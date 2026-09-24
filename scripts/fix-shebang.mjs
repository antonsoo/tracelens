// tsc preserves a leading shebang in emitted JS, but does not mark the file
// executable. npm sets the exec bit on files named in package.json's "bin"
// during `npm install`, but that only helps consumers, not `npm run build`
// run straight from a checkout — so we set it here too, and make sure the
// shebang line is present even if a future TS version stops preserving it.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const entry = new URL('../dist-cli/cli/index.js', import.meta.url);
const original = readFileSync(entry, 'utf8');
const shebang = '#!/usr/bin/env node\n';
const fixed = original.startsWith('#!') ? original : shebang + original;

writeFileSync(entry, fixed);
chmodSync(entry, 0o755);
