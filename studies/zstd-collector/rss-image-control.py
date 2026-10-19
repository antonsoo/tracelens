"""Show that Linux rusage can retain a preceding program image's peak RSS."""

import argparse
import os

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--node", default="node")
args = parser.parse_args()
allocation = bytearray(256 * 1024 * 1024)
os.execvp(
    args.node,
    [
        args.node,
        "--input-type=module",
        "-e",
        """
import {readFileSync} from 'node:fs';
console.log(JSON.stringify({
  precedingImageAllocationBytes:268435456,
  node:process.version,
  rusageMaxRssKiB:process.resourceUsage().maxRSS,
  currentImageVmHwmKiB:Number(/^VmHWM:\\s+(\\d+)/m.exec(readFileSync('/proc/self/status','utf8'))[1]),
}));
""",
    ],
)
