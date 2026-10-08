#!/bin/bash
# Reads the captured spans with the released tracelens and with this checkout, scores both against
# the recorded provider responses, and writes results.json.
#
#   ./analyze.sh <work-dir>      (the directory capture/run-all.sh filled)
#
# Builds go to <work-dir>/build; the repository's own dist-cli/ is not touched. The released
# version is built from the v0.3.3 tag in a git worktree under <work-dir>.
set -eu
WORK=$(realpath -m "${1:?usage: analyze.sh <work-dir>}")
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
mkdir -p "$WORK/build" "$WORK/res"

[ -d "$WORK/wt-v0.3.3" ] || git -C "$REPO" worktree add --detach "$WORK/wt-v0.3.3" v0.3.3
[ -e "$WORK/wt-v0.3.3/node_modules" ] || ln -s "$REPO/node_modules" "$WORK/wt-v0.3.3/node_modules"
"$REPO/node_modules/.bin/tsc" -p "$WORK/wt-v0.3.3/tsconfig.cli.json" --outDir "$WORK/build/v0.3.3"
"$REPO/node_modules/.bin/tsc" -p "$REPO/tsconfig.cli.json" --outDir "$WORK/build/checkout"
for v in v0.3.3 checkout; do echo '{"type":"module"}' >"$WORK/build/$v/package.json"; done

for v in v0.3.3 checkout; do
  node "$HERE/read-with-tracelens.mjs" "$WORK/build/$v" "$WORK/res/tl-$v.json" "$WORK"/out/*.jsonl
done
python3 -I "$HERE/score.py" "$WORK" "$WORK/res/score.json" >"$WORK/res/score.txt"
python3 -I "$HERE/dialects.py" "$WORK" "$WORK/res/dialects.json" >"$WORK/res/dialects.txt"
python3 -I "$HERE/summarize.py" "$WORK/res/score.json" "$WORK/res/dialects.json" "$HERE/results.json" --markdown
