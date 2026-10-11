# D02 WOFF2 asset hash audit — 2026-10-07

Static, development-only evidence for the registered D02 Excalidraw checkout at commit `ed10ac7dca7e40f3f4a31269b4bfba980d0db41e`. The checkout was clean when reviewed. No project code or generator was run; no files in the checkout were changed; no holdout checkout contents, labels, analyzer output, or performance results were opened or analyzed.

Boundary deviation: while gathering context, the reviewer read `T1a-scope-review.md`, which included a holdout-scope row. No holdout checkout, labels, analyzer output, or performance results were opened or analyzed. The D02 inventory below uses only the registered development checkout and was independently recomputed from that checkout after collection.

The tracked-file query found 237 `.woff2` files totaling 13,275,360 bytes and 236 distinct SHA-256 values. The sorted per-file path, byte-size, and SHA-256 inventory is [`D02-font-asset-sha256-2026-10-07.jsonl`](D02-font-asset-sha256-2026-10-07.jsonl), whose SHA-256 is `8cb92b049cc9ecfa7fcd8f4d0b3849e6e1d255838719bb5506535ad6aa63614e`.

One exact duplicate was found: `packages/excalidraw/fonts/Assistant/Assistant-Regular.woff2` and `public/Assistant-Regular.woff2` are both `76945f09225aae65bdbd204cb4ac40d4caa4ff67150e5074bab1a04d1b778fc3`. This establishes identical local bytes for those two paths only. It does not identify the upstream input revision, establish the license/notice for the bytes, or provide legal clearance. The other font binaries still require per-family source and licensing evidence.

## Local font metadata clues (not clearance)

- `packages/excalidraw/fonts/Excalifont/index.ts:11-28` records `cn-font-split@5.2.2`, a generation timestamp, font version metadata, attribution, and SIL OFL 1.1 text.
- `packages/excalidraw/fonts/Xiaolai/index.ts:216-240` records the same generator version, a generation timestamp, Xiaolai SC v3.11 metadata, attribution, OFL 1.1 text, and local subset/modification notes.
- `packages/excalidraw/fonts/ComicShanns/index.ts:11-68` records the generator/version and MIT attribution. Its tracked source `packages/excalidraw/fonts/ComicShanns/ComicShanns-Regular.sfd:1-7` repeats the source metadata and MIT text.

These are local wrapper/source clues and do not pin the original upstream input revision or prove the relationship between every WOFF2 subset and its source. No font-family README, LICENSE, or NOTICE file is tracked under the font directory; the root project MIT license does not establish the font assets' terms. Other wrappers and `fonts.css` provide family, weight, or range details; `packages/common/src/font-metadata.ts` contains metrics and flags rather than provenance. Exact per-file source mapping, notices, and rights review remain open.

Reproduction from the repository root uses only Git path listing and Python standard-library reads/hashing:

```sh
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
import subprocess
root = Path('.superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02')
paths = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '*.woff2'], check=True, capture_output=True).stdout.split(bytes([0]))
for raw in sorted(p for p in paths if p):
    path = raw.decode()
    data = (root / path).read_bytes()
    print(path, len(data), sha256(data).hexdigest())
PY
```
