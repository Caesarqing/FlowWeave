# T1a license-path inventory: D02, H03, D10 — 2026-10-08

Status: local-only development follow-up. It adds no legal clearance, sample approval, or T1a closure. Only the three pinned development checkouts and named local evidence below were inspected. No project code was run, no package was installed or downloaded, and no holdout checkout, source, result, or label was inspected. At report creation, the `.gitignore` rule at line 44 ignored this path and was left unchanged. A subsequent continuation added explicit allowlist entries for all three audit reports; the current rule no longer ignores this report.

## Result

No new local record closes an unresolved asset-binary permission question. D02's tracked ComicShanns editable source file carries an MIT notice and author list, but it does not bind the four WOFF2 slices to that source. The prior trace's exact immutable-source match for D02 `public/Virgil.woff2` remains the only font-binary mapping already tied to an upstream license record; this pass only re-hashed the local path. Its package sibling is a different file.

### D02 Excalidraw

The pinned checkout is `ed10ac7dca7e40f3f4a31269b4bfba980d0db41e`, tree `66be96e073c2141d8973127015e81c6d99df23af`; it is shallow and `git status --short` was empty. The existing per-file inventory records 237 WOFF2 files and remains the hash source for the complete binary set.

`ComicShanns-Regular.sfd` contains a full MIT notice and author list (SHA-256 `ccb87f5dda14ae0800b57d1052e4b9faddda8b2d4a1aeb2e28e6cb11722539fe`). The four neighboring WOFF2 imports in `ComicShanns/index.ts` are not tied to the SFD by a tracked generator or manifest. The wrapper also has two different generation descriptions: its opening comment says it was manually rewritten from the online split tool, while its embedded font metadata says `cn-font-split@5.2.2`. This narrows the source lead but leaves the exact input revision and binary-to-source mapping open.

Excalifont and Xiaolai wrappers embed OFL 1.1 text, names, and attribution; their hashes are `57793f1c8aa1116de20fb0add878c6c143a29d505913699114008e8907372e8a` and `92882c3762cd155663341f19f63b28dc9fe868d796a97176dabb84c0016223d6`. They still do not identify the exact upstream font bytes used to make each checked-in slice. No font-family LICENSE, NOTICE, COPYING, or README path is tracked under the font directories. The checkout's shallow boundary also prevents local history from supplying the missing inputs.

`fc-scan`, `fc-query`, and `woff2_decompress` were unavailable, and Python `fontTools` was not installed. I did not decode the WOFF2 name tables; their recorded hashes establish byte identity only.

The vendored WOFF2 WASM wrapper reports `fonteditor-core` 2.4.0 and includes its MIT text; the package manifest declares 2.4.1 while `yarn.lock` contains both versions. `scripts/buildWasm.js` writes to `packages/excalidraw/fonts/wasm`, whereas the checked-in wrapper is under `packages/excalidraw/subset/woff2`. These local records do not establish which package bytes produced the checked-in wrapper or its matching regeneration path. No generator was run.

The existing source trace maps `public/Virgil.woff2` to a pinned upstream Virgil file and its OFL record. This pass confirms local SHA-256 `9976295bfe709bdea64839a4d4e9a1d436dd6eb67538399a5a0e8b8fadbcf1cf`. `packages/excalidraw/fonts/Virgil/Virgil-Regular.woff2` hashes to `2279cf7daf1c42a3a53b2c1437ad72f0050efb67ac263e0245f67612fd766714`, so that mapping does not cover the package copy. No new local evidence identifies its source or terms.

### H03 Guava

The pinned checkout is `74fb73b20e17e1b3fa072d7754af493217f86781`, tree `6a1b65ed70b9a4470c601d4b4463516fa0889484`; it is shallow and `git status --short` was empty. Tracked-file lookup found the two `PublicSuffixPatterns.java` outputs but no `public_suffix_list.dat`, `effective_tld_names.dat`, generator, or dataset-specific LICENSE/NOTICE/COPYING file. The main and Android outputs are byte-identical, SHA-256 `946d205a2de1fb39768034d197f1a412f9de34eb0cb83739e14ce5a2d763a66f`.

Both generated headers identify Guava Authors and Apache-2.0, but neither identifies the PSL input or its terms. The root Maven POM does not list the Android module among its modules; a separate Android Guava POM exists and points at shared Guava module metadata. No build was run, so this does not establish whether or where that copy is shipped. The prior candidate PSL comparison remains consistency evidence only: the pinned local source tree still contains no immutable input hash or generator record connecting that candidate to these output bytes. Provenance and notice disposition remain open.

### D10 Memos

The pinned checkout is `6ff88e36a22fae6fd225579777e77430b5f85a94`, tree `2f6f2efc0c197f8934d0190fe08f7dd2a1a3130f`; it is shallow and `git status --short` was empty.

The five tracked web images have no author/license metadata chunks in their local PNG/WebP containers. Their SHA-256 values are: `android-chrome-192x192.png` `97e8a946eb7135704a2c2b4c2d738bfebce4e7fb118e9633d2d646e5c1a61478`; `android-chrome-512x512.png` `1b12d8325272c68562f46ba0a452d7c5ac141af86262aab4603d037e18481b29`; `apple-touch-icon.png` `404dd223f57197c09483c6b68e809108079018ca555a10347ec12d4aefb19b42`; `full-logo.webp` `ca1340e773c400a43c757ddd5d78581c99ac050919487e4d8a751f3457ac6e90`; `logo.webp` `f87a44fb961d32a1cece3d00717289b4a30f6528c61a6785d097e4feab291859`. Local `git log --follow` for each path returned only the pinned shallow commit, so it adds no earlier source or authorship record. Existing evidence traces repository additions and consumers, but not original artwork authorship or image-specific permission. `server/frontend/dist/index.html` remains a placeholder; the checked-in tree cannot establish the release bundle's embedded assets or notices.

The Unicode generator names three versioned 17.0.0 source URLs, but the pinned checkout contains none of the three input files or input hashes. The generated Go/TypeScript digest is over parsed output data, so it cannot identify the historical response bytes. No local source or license text was added by this pass.

`proto/buf.lock` pins `buf.build/googleapis/googleapis` at commit `004180b77378443887d3b55cabc00384` with the recorded module digest; a representative generated TypeScript file carries a Google LLC Apache-2.0 header. The tracked-proto path search found no module LICENSE, NOTICE, or COPYING file. The local lock and file header establish a module identity and a per-file notice, but do not record the complete included-source or remote-generator notice chain. The prior BSR license-file response is external evidence and was not refreshed or treated as new local proof here.

## Commands

Run from the FlowWeave checkout root. These were read-only; the image scan used Python's standard library to list PNG/WebP chunks and SHA-256 values.

```sh
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02 rev-parse HEAD 'HEAD^{tree}' --is-shallow-repository
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02 status --short
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02 ls-files 'packages/excalidraw/fonts/**/LICENSE*' 'packages/excalidraw/fonts/**/NOTICE*' 'packages/excalidraw/fonts/**/COPYING*' 'packages/excalidraw/fonts/**/README*'
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03 rev-parse HEAD 'HEAD^{tree}' --is-shallow-repository
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03 status --short
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03 ls-files 'public_suffix_list.dat' 'effective_tld_names.dat' '**/public_suffix_list.dat' '**/effective_tld_names.dat' '**/*PublicSuffixPatterns.java' '**/LICENSE*' '**/NOTICE*' '**/COPYING*'
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03 grep -n -I -E 'public_suffix_list|PublicSuffixPatterns|public suffix list|MPL-2.0|Mozilla|NOTICE|COPYING' HEAD -- guava android/guava pom.xml
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos rev-parse HEAD 'HEAD^{tree}' --is-shallow-repository
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos status --short
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos ls-files '*DerivedCoreProperties.txt' '*UnicodeData.txt' '*emoji-test.txt' 'proto/**/LICENSE*' 'proto/**/NOTICE*' 'proto/**/COPYING*'
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos log --follow --format='%h %cs %an %s' -- web/public/android-chrome-192x192.png
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos log --follow --format='%h %cs %an %s' -- web/public/android-chrome-512x512.png
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos log --follow --format='%h %cs %an %s' -- web/public/apple-touch-icon.png
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos log --follow --format='%h %cs %an %s' -- web/public/full-logo.webp
git -C .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos log --follow --format='%h %cs %an %s' -- web/public/logo.webp
sed -n '1,36p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/packages/excalidraw/fonts/ComicShanns/index.ts
sed -n '1,34p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/packages/excalidraw/fonts/Excalifont/index.ts
sed -n '216,240p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/packages/excalidraw/fonts/Xiaolai/index.ts
sed -n '1,27p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/packages/excalidraw/subset/woff2/woff2-wasm.ts
sed -n '130,140p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/packages/excalidraw/package.json
sed -n '6526,6539p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/yarn.lock
sed -n '6808,6811p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/yarn.lock
sed -n '1,55p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/D02/scripts/buildWasm.js
sed -n '1,18p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03/guava/src/com/google/thirdparty/publicsuffix/PublicSuffixPatterns.java
sed -n '1,18p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03/android/guava/src/com/google/thirdparty/publicsuffix/PublicSuffixPatterns.java
sed -n '215,244p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/H03/android/guava/pom.xml
sed -n '1,20p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos/proto/buf.lock
sed -n '1,34p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos/proto/buf.gen.yaml
sed -n '1,15p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos/web/src/types/proto/google/api/annotations_pb.ts
sed -n '1,10p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos/markdown/parser/tag_unicode_tables.go
sed -n '20,70p' .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos/markdown/parser/tagdata/main.go
```

The exact `shasum -a 256` inputs and results are listed below. The checked-in paths, not rendered or transformed output, were hashed.

The image metadata scan was this standard-library-only Python command (from the FlowWeave root):

```sh
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path

root = Path('.superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/CANDIDATE-memos')
paths = [
    'web/public/android-chrome-192x192.png',
    'web/public/android-chrome-512x512.png',
    'web/public/apple-touch-icon.png',
    'web/public/full-logo.webp',
    'web/public/logo.webp',
]
for rel in paths:
    data = (root / rel).read_bytes()
    chunks = []
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        pos = 8
        while pos + 12 <= len(data):
            size = int.from_bytes(data[pos:pos + 4], 'big')
            tag = data[pos + 4:pos + 8].decode('ascii', 'replace')
            chunks.append(tag)
            pos += 12 + size
            if tag == 'IEND':
                break
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        pos = 12
        while pos + 8 <= len(data):
            tag = data[pos:pos + 4].decode('ascii', 'replace')
            size = int.from_bytes(data[pos + 4:pos + 8], 'little')
            chunks.append(tag)
            pos += 8 + size + (size & 1)
    print(rel, len(data), sha256(data).hexdigest(), ','.join(chunks), sep='\t')
PY
```

## Hashes of evidence files used

| File | SHA-256 |
| --- | --- |
| `.gitignore` (working-tree content at report creation) | `a6bff667be130b5f3d811c35cbe779adcf46bbc9db154410eb91c7ef262ea5c8` |
| `docs/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN.md` (content at report creation) | `31246a8ea5b4e618f8492e41f51ef2f52d32295069f3f3d48900fe20f8a18c0e` |
| `T1a-development-source-license-trace-2026-10-06.md` | `43b6d7a878d1acff725d359ada895ba2390f9c9fc95d608cc2c053b232b10281` |
| `T1a-development-license-inventory-followup-2026-10-06.md` | `708a4fb2265b52d3333f10b1467fc35a8f63cf95016d9897e6b074cb1a5394a8` |
| `T1a-development-local-asset-provenance-2026-10-06.json` | `c6c7fad9bcc356015d1f192068dad259cfb8bd7dbdf819e0e968d046c749fc3f` |
| `T1a-development-manifest-integrity-2026-10-08.md` | `a24806758de2128be03af2b8d4b4b903702767220eb13525554dd7296d1265eb` |
| `D02-font-asset-hash-audit-2026-10-07.md` | `6c9e1acca35ba21775048203a769af3ffa84078173bac70acd9f9a87bd308b7a` |
| `D02-font-asset-sha256-2026-10-07.jsonl` | `8cb92b049cc9ecfa7fcd8f4d0b3849e6e1d255838719bb5506535ad6aa63614e` |

| Checkout file | SHA-256 |
| --- | --- |
| D02 `LICENSE` | `1352d204fdb90d5e482c13139d848bc2c9300a9a7de358a0a558a23e72d0d8be` |
| D02 `ComicShanns/index.ts` | `947fd9ac901be8a6c62aaa35450b5f2ffca0489c194cfd54bba6ba53d3ef2e55` |
| D02 `Excalifont/index.ts` | `57793f1c8aa1116de20fb0add878c6c143a29d505913699114008e8907372e8a` |
| D02 `Xiaolai/index.ts` | `92882c3762cd155663341f19f63b28dc9fe868d796a97176dabb84c0016223d6` |
| D02 `ComicShanns-Regular.sfd` | `ccb87f5dda14ae0800b57d1052e4b9faddda8b2d4a1aeb2e28e6cb11722539fe` |
| D02 `subset/woff2/woff2-wasm.ts` | `5428f71551fc004524353d50c66c09f98667e3bb7183b51de5ce4aefe4c78b9a` |
| D02 `packages/excalidraw/package.json` | `160dabbd052e579a5b7b0e341d653e0739d17d44d68f16be8c1cf893e1e4236d` |
| D02 `yarn.lock` | `2fceed8bdb8180b2d14ab0db6010f48b05da0f3a772e218a7024e88ca7a7c76e` |
| D02 `scripts/buildWasm.js` | `68dffaf8b7ba42ef7c22bc967da1bc818bc31aa407193d8975597b200a306605` |
| D02 `public/Virgil.woff2` | `9976295bfe709bdea64839a4d4e9a1d436dd6eb67538399a5a0e8b8fadbcf1cf` |
| D02 `fonts/Virgil/Virgil-Regular.woff2` | `2279cf7daf1c42a3a53b2c1437ad72f0050efb67ac263e0245f67612fd766714` |
| H03 `LICENSE` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| H03 `pom.xml` | `741b3eb8330fcdf9c8b1724626164e9f18569eb8b8eb5fd0ca1786928f09c6ef` |
| H03 `guava/pom.xml` | `5ab92759764cf7f87982de4b38e01ab5fbcfa101ef64a14671b60d2e3f9cb343` |
| H03 `android/guava/pom.xml` | `e870d339ebdad138180dc369965d272484853a9c756c6ce6b7f78d2275bc02c3` |
| H03 main and Android `PublicSuffixPatterns.java` | `946d205a2de1fb39768034d197f1a412f9de34eb0cb83739e14ce5a2d763a66f` each |
| D10 `LICENSE` | `dadc85262cec40d1344736b57da50814194ff721ab98012c09cd9d35c4b8582a` |
| D10 `tagdata/main.go` | `3241fc95c96924ea20202cf014421d108b998d46d3057d9ffa61ce9f112bfc4d` |
| D10 `tag_unicode_tables.go` | `21079a54be653b5437c17cf847cbbd7e52e17bb9c91758a92e4b4741eef57b18` |
| D10 `tag-unicode-data.ts` | `951dad0cf5e89c5c6eef2fe9c271eaa673bcdbc34223ec61d3221349ee35d88a` |
| D10 `proto/buf.lock` | `06c19c80cc80b6a5666f01b57ad6a78bdad6630cfcca1fa862681a6a934e59bc` |
| D10 `proto/buf.gen.yaml` | `b832e79f631d2ad47ffb9866d15989e3526265d3809cee2c55ed6a3ca445db3f` |
| D10 `annotations_pb.ts` | `afcbcc452d9c77eb80706c8dc32b2396d4e006ab82bddb90a0710e2dfe899986` |
| D10 `server/frontend/frontend.go` | `127d12221a0c728955674c7a3cf97307d99c36337a1acb893ec5d0ae6ee48ff6` |
| D10 `server/frontend/dist/index.html` | `502a0d487093dc7e2570fe1bbf11a66c93d30076ea39bb69118828c1ad3212a8` |

The five D10 image hashes are listed with their paths in the D10 section.

## Next evidence needed

D02 needs a source revision and license/notice mapping for the remaining font binaries, plus a generator record that binds the ComicShanns slices to the editable SFD. H03 needs the exact PSL input bytes/revision, its terms, and a recorded transformation/notice path; the Android artifact path needs a build or release record. D10 needs historical Unicode input hashes, the complete BSR source/import and remote-generator notice chain, and image authorship/permission records plus the actual release bundle. These are evidence requests only; this report makes no legal judgment.
