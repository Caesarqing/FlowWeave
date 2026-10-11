# T1a development asset provenance re-audit: D02, H03, D10 — 2026-10-08

Read-only follow-up for the three registered development checkouts. No project code, generator, or build was run; no package or repository was downloaded or installed. No holdout checkout, label, analysis output, or user project was inspected. The checkouts were clean, shallow snapshots at the registered identities:

| Role | Checkout | Commit | Git tree |
| --- | --- | --- | --- |
| D02 | `corpus-checkouts/D02` | `ed10ac7dca7e40f3f4a31269b4bfba980d0db41e` | `66be96e073c2141d8973127015e81c6d99df23af` |
| H03 | `corpus-checkouts/H03` | `74fb73b20e17e1b3fa072d7754af493217f86781` | `6a1b65ed70b9a4470c601d4b4463516fa0889484` |
| D10 | `corpus-checkouts/CANDIDATE-memos` | `6ff88e36a22fae6fd225579777e77430b5f85a94` | `2f6f2efc0c197f8934d0190fe08f7dd2a1a3130f` |

## Re-audit result

The prior direct mapping remains D02 `public/Virgil.woff2` (61,248 bytes, SHA-256 `9976295bfe709bdea64839a4d4e9a1d436dd6eb67538399a5a0e8b8fadbcf1cf`) to the immutable Excalidraw/Virgil upstream file at commit `3d4c829dc85b455d4646631ac52bc1517df04217`, with its OFL-1.1 notice. This audit recomputed the local hash; it did not fetch the upstream binary again. It does not cover the distinct `packages/excalidraw/fonts/Virgil/Virgil-Regular.woff2` hash `2279cf7daf1c42a3a53b2c1437ad72f0050efb67ac263e0245f67612fd766714`.

D02 has 237 tracked WOFF2 paths and 236 unique byte hashes. Existing wrappers name licenses and likely source families, but the checkout has no font-family license/notice files and does not bind the remaining binaries to immutable source bytes. In particular, the four ComicShanns slices are not tied to the MIT-noticed editable SFD by a tracked generator record; Excalifont/Xiaolai metadata likewise does not identify the exact slice inputs. The remaining exact external input is a per-binary (or byte-identical group) source revision and corresponding license/notice record, plus the ComicShanns generation mapping. The existing per-file evidence is `D02-font-asset-sha256-2026-10-07.jsonl` (SHA-256 `8cb92b049cc9ecfa7fcd8f4d0b3849e6e1d255838719bb5506535ad6aa63614e`). Independent verification should compare each recorded binary hash to immutable upstream artifacts and have a reviewer other than the corpus selector check the linked notice and generation record.

H03's main and Android `PublicSuffixPatterns.java` are identical (316,185 bytes, SHA-256 `946d205a2de1fb39768034d197f1a412f9de34eb0cb83739e14ce5a2d763a66f`). The pinned checkout contains neither the PSL input nor a generator/updater record. Official Guava history identifies the generated-output update commit `16fda8017316d48a63d99bfc85375f3037b3a6c7`; the nearest preceding PSL candidate is `publicsuffix/list@728555a30ef4d40e42a82d5678e5fbad2ad17b26`. The candidate has 10,330 rules, all present in Guava output, but Guava output also has 462 rules absent from it. This does not identify the actual input. Required external evidence is the exact archived PSL input bytes/hash and provenance tied by Guava's updater log or maintainer record to the generated output, plus the input's notice/terms and disposition record. An independent reviewer should reproduce the output from that pinned input and recorded generator, and a release/build record should establish whether the Android copy ships.

D10 Unicode generators name the three Unicode 17.0.0 input URLs, but the pinned checkout has no input files or input hashes. The checked-in generated Go and TypeScript files carry digest `a5ac7d15cb353b0a0fd6571da68ec89a5681d3b1d68a74ac1c6e583b3761ea66`, which is over parsed output and does not identify historical response bytes. The earlier official-source trace records candidate Unicode input response hashes and Unicode License v3 terms; it does not bind those bytes to this generation. Required external evidence is the generation-time input archive/hashes and generator revision/command; an independent reproduction should match the checked-in generated digest.

D10's `proto/buf.lock` pins `buf.build/googleapis/googleapis` commit `004180b77378443887d3b55cabc00384`, digest `b5:e8f475fe3330f31f5fd86ac689093bcd274e19611a09db91f41d637cb9197881ce89882b94d13a58738e53c91c6e4bae7dc1feba85f590164c975a89e25115dc`. Earlier read-only BSR evidence recorded a matching module digest and Apache-2.0 `LICENSE` hash `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`. The checkout has no module-local LICENSE/NOTICE/COPYING path. Needed to complete the generated-file record are the full included-source/import notice inventory, the remote generator artifact identities and hashes, and an output-to-input record. An independent audit should verify the module digest, review every applicable notice, and reproduce/check representative generated files with the pinned generator artifacts.

D10 has five web images whose local hashes are:

| Path | SHA-256 |
| --- | --- |
| `web/public/android-chrome-192x192.png` | `97e8a946eb7135704a2c2b4c2d738bfebce4e7fb118e9633d2d646e5c1a61478` |
| `web/public/android-chrome-512x512.png` | `1b12d8325272c68562f46ba0a452d7c5ac141af86262aab4603d037e18481b29` |
| `web/public/apple-touch-icon.png` | `404dd223f57197c09483c6b68e809108079018ca555a10347ec12d4aefb19b42` |
| `web/public/full-logo.webp` | `ca1340e773c400a43c757ddd5d78581c99ac050919487e4d8a751f3457ac6e90` |
| `web/public/logo.webp` | `f87a44fb961d32a1cece3d00717289b4a30f6528c61a6785d097e4feab291859` |

Local history and upstream PRs establish when these files entered the repository or were converted, but do not identify the original artwork source or an image-specific permission record. The exact missing input is an author/design-owner record mapping these hashes to original assets and applicable permissions. Independent evidence should come from the artwork owner or maintainer, then be checked against the immutable files. The checked-in `server/frontend/dist/index.html` is a placeholder, so an actual release-bundle manifest and notice inspection are also needed to establish what is embedded.

## Closure decision

No additional source mapping was established in this pass beyond the already recorded D02 public Virgil mapping. No T1a checkbox can be closed: plan item 137 also requires the full independent-repository sample, approved scope and selection reasons, source/license records, and acquisition owners; this report resolves none of those remaining requirements. It makes no legal conclusion. The exact open evidence requests are source/input hashes and generation records from upstream maintainers for D02/H03/D10, artwork ownership/permission records from D10's asset owner, complete build/release asset records, and independent verification of each supplied record.

## Evidence references

- `T1a-license-path-inventory-D02-H03-D10-2026-10-08.md` — SHA-256 `aac77b6bd0c65c06d59c800a319a33718f30f68b4886aed5cb3ecd56199de3d9`.
- `T1a-development-source-license-trace-2026-10-06.md` — SHA-256 `43b6d7a878d1acff725d359ada895ba2390f9c9fc95d608cc2c053b232b10281`.
- `T1a-development-license-inventory-followup-2026-10-06.md` — SHA-256 `708a4fb2265b52d3333f10b1467fc35a8f63cf95016d9897e6b074cb1a5394a8`.
- `T1a-development-local-asset-provenance-2026-10-06.json` — SHA-256 `c6c7fad9bcc356015d1f192068dad259cfb8bd7dbdf819e0e968d046c749fc3f`.
- `D02-font-asset-hash-audit-2026-10-07.md` — SHA-256 `6c9e1acca35ba21775048203a769af3ffa84078173bac70acd9f9a87bd308b7a`.
- `D02-font-asset-sha256-2026-10-07.jsonl` — SHA-256 `8cb92b049cc9ecfa7fcd8f4d0b3849e6e1d255838719bb5506535ad6aa63614e`.
