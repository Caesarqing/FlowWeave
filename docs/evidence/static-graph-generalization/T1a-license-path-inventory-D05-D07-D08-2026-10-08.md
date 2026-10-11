# T1a license and attribution path inventory — D05, D07, D08 — 2026-10-08

Status: development-only static evidence; proposed scopes remain unfrozen. This is not legal clearance.

## Boundary and method

Read the T1a constraints in section 7 of the implementation plan, the registered D05/D07/D08 records and JSONL inventories, and only their three pinned development checkouts. No holdout checkout, source, result, or label was opened. No project code ran; no package was installed or downloaded; no network lookup was performed. The scan used each checkout's complete tracked path list, text header/attribution searches, SHA-256, and static dependency manifests. Binary file contents and dependency resolution were not examined.

The registry is marked proposed, with proposed-reviewed-not-frozen collection scopes. The current raw corpus SHA-256 is 8cdeb59d92a2326bf38c680517af481b031624869063fdfdc66afbf40ba3fcc7. The prior manifest-integrity check reports all listed path, mode, size, content hash, normalized scope hash, and counts consistent with the pinned development checkouts; this review independently rechecked the commit, Git tree, clean state, and matching SHA-256 for every row in these three inventories.

| Sample | Pinned commit / tree | Checkout | Tracked paths | Inventory rows / sources | Inventory SHA-256 | Scope SHA-256 |
| --- | --- | --- | ---: | ---: | --- | --- |
| D05 Gson | 854c8255b625cf1e13c701a83ea9ccb4caaa576a / aba443ba941f8a8c00b98ca91f1268ab58ebf88a | clean | 313 | 102 / 96 | 5c27077fd9ad55a6075dd9f711dcf06572e88e400791195bf33a9b1fbf80e453 | 73e786141a71e70b0f2c664e03ecf430fd17a7b5663485284d4354453c48bf47 |
| D07 Cobra | adbc8813901bba65827259daa8e22ff94ec1f30e / 5a3b2c8e9af4c74e607a0a55e7910c1edb5d266f | clean | 66 | 21 / 19 | 770fab99821d00ed8e50408bd73403a02babe69d94230ab70e3fe4ad89988556 | b3ef65af56c4ceaa5eb49913b4ef25bef117e5409a2c8e4e4008b7cdfbe79fd7 |
| D08 chi | 167e1e3bd039d060696b99c8da4e876ae04f42c1 / 78ea402444f50acbf2de96c413503d75ef8b6e54 | clean | 105 | 37 / 35 | e067379f15cc92167689f96f510d0c97419e363b06f262ed7026bf594992a62c | 0f97941ddb5f802f3d6341f715710e7e3c49b809aa4525de69682151ffc3b671 |

## Findings

The tracked-path search found only the primary license path(s) listed below. No additional tracked LICENSE/LICENCE/COPYING/NOTICE files, third-party attribution directories, or vendor directories were found. All listed primary license files are represented in the proposed inventories. Header counts below mean a matching copyright/license marker occurred within the first 60 lines; they are inventory facts, not a conclusion about rights.

**D05 — Gson.** The proposed scope includes gson/src/main/java, extras/src/main/java, proto/src/main/java, four POMs, and two license files. The full checkout scan found 91 source files, four configuration files, and both license files with a header marker in the proposed inventory; the other 153 header-bearing tracked files are outside those registered rows, chiefly tests and auxiliary modules. Five of the 96 proposed source files had no matching header marker in the first 60 lines:

| Proposed source with no detected header | SHA-256 |
| --- | --- |
| gson/src/main/java/com/google/gson/Strictness.java | d0151a6b4d3a8d04e54d7c136ce5300408f7dfaf8d1fd278a0d847cbbdd93ce8 |
| gson/src/main/java/com/google/gson/internal/NumberLimits.java | e47e4501ada090c6c65740f218bdc01bb672be508db80ba1899a294f1d61cdfd |
| gson/src/main/java/com/google/gson/internal/TroubleshootingGuide.java | 58c3962efa0df5686695b999487d7b69b56744e08adc3d7b84d9dabd0883098f |
| gson/src/main/java/com/google/gson/internal/bind/IgnoreJRERequirement.java | deb00e3f5167f80b3b96e5f6db7a1285edddf4eb77789a2221e14ca5bb131da1 |
| gson/src/main/java/com/google/gson/internal/bind/JavaTimeTypeAdapters.java | d26ba63d400721bf6dc1626ef1714c83db2813c68ea97dfae7b22a8ad571024f |

LICENSE is Apache-2.0 per the registry, SHA-256 cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30; nested gson/LICENSE is also an Apache License 2.0 text, SHA-256 be422904f64790bb41165f7b494f890230bdab413df98ffc3c3e2da9b6750bc5.

In-scope source attribution needs follow-up: extras/src/main/java/com/google/gson/typeadapters/PostConstructAdapterFactory.java (SHA-256 dca33b7d30f3c6a434e18077fcf096fb1f5e4896be86b8a0b3365e0d2edd37a6) says it was copied from a pinned GitHub gist URL; gson/src/main/java/com/google/gson/internal/LinkedTreeMap.java (SHA-256 e597fe66b14de2f2feeb519185846f498fdb6a38bb9daac0af5d9a2f089c6a57) says it derives from Android 4.1 TreeMap. Their exact upstream revisions and corresponding notice/license records were not established here.

One related generation input sits outside the proposed source rows: gson/src/main/java-templates/com/google/gson/internal/GsonBuildConfig.java (SHA-256 842f6b9e6c138447aae1e9559e8f2f15e2e0588d2d02700df9b902e76e575f7e) says the Java/class files are generated and cites a Stack Overflow answer. Included gson/pom.xml routes src/main/java-templates to target/generated-sources/java-templates. This template's origin/license treatment is therefore a scope/provenance gap for generated build input.

The included POM hashes are root pom.xml 76293cf9be1c86ed2a4bd2b7ee136502b8331260127b4a9a814b9e3efd3b9dbe, gson/pom.xml 4750f6235050270c57b4e99504ecb34375e93df24a5bc28416bca00dbdfd2e40, extras/pom.xml 6f09e5a8a01d0e6bf48d864a04842abfd3b66dba8a32c3df1b776c787c9d0120, and proto/pom.xml d7fe5e63cf0da3ea8bef572f0e6c03769577824d9fe527032f4773b9e90ea931. The root lists seven Maven modules; the proposed source scope includes three. Static declarations include Error Prone annotations, Guava, protobuf, jsr250, JUnit, and Truth. No Maven dependency lock was found. Profiles, parent-managed versions, effective scopes, and transitive licenses remain unresolved because Maven was not run.

**D07 — Cobra.** The proposed scope has 19 Go sources, go.mod, and LICENSE.txt. All 19 source files and the license file have an Apache-2.0 header marker. The other 18 header-bearing tracked files are outside the inventory, chiefly test files excluded by the scope. No separate NOTICE/COPYING/vendor attribution path was found. doc/rest_docs.go (SHA-256 4ffa45d039448b87c77cbec3ab5c827cb2a77038e8cf6f8ec75046b9d7d4dd26) says indentString was adapted from kr/text's indent.go on the moving main branch; the exact revision and its applicable notice/license were not established.

The in-scope doc/man_docs.go (7f72248e811ea9842d85030280e600e545fcdd419a010aefa3d395c9c2428709), doc/md_docs.go (b6f51d89c0d9963df27b489066fd1617a58f805ec3ff7e0d3036088a13927daf), and doc/rest_docs.go contain generator routines that emit “Auto generated by spf13/cobra” text. These are generator sources, not identified generated source files.

Static go.mod (SHA-256 cc6098fd1118fb3bb349c72bcd6e9c665d3a1b2a516ea9807ee24521ad2ddf8c) declares four direct modules: go-md2man/v2 2.0.6, mousetrap 1.1.0, pflag 1.0.9, and yaml/v3 3.0.4. A tracked 12-line go.sum exists (SHA-256 e557d41a00d687ace802030ae327b7d794989b638b5a0e9305865023a0544834), but it is absent from the 21-row inventory even though the registered include path is “.”. Treat this as an inventory coverage ambiguity/gap, not as a resolved exclusion. No tracked vendor tree or additional go.mod was found. The root module's dependency checksums and vendored source coverage are not represented by the current inventory.

**D08 — chi.** The proposed scope has 35 Go sources, go.mod, and LICENSE. Only tree.go among the source rows has a detected copyright/license marker; it explicitly attributes the radix tree to Armon Dadgar's go-radix on the moving master branch and says MIT licensed. Its SHA-256 is f4b12b63b662fb8e36658172b36b35705cfb24eefae0665635f4fbd52e64fb79. Root LICENSE is MIT per the registry, SHA-256 a2d51b7515acfaff2f7a88688650f2fc4fd99561383e72bba2305e3db59a1647. No extra NOTICE/COPYING/vendor path or out-of-scope header hit was found.

Eight other in-scope source files contain explicit upstream-origin comments: middleware/nocache.go (389eb1e308194561aea139b8d56d49f46b9fb30d84f8da146f5deaea66c5f5cc), middleware/realip.go (2f837f2213de7074c5c6915dad70f85c4588077291a8563d1cbad6698a757220), middleware/recoverer.go (efc38c7b32bfb29ebbe16b199832d1eff13179a34a025c07b53c733c11a2154c), middleware/request_id.go (31b21034dd5cd6393fa9abc9ce1207acc78fea1e162d866edf6bb2a7badd288b), middleware/terminal.go (6e663b6ab8e26417198021c226b5aa5bce92648c5bb172d329389c16bef8ca20), and middleware/wrap_writer.go (7b6ed24d3d5bfd362e00851d117e74273b02597a1d9e9eb243cbf7aae22597c8) identify Goji middleware; context.go (b19edcca252e2fe74e82802c4c7ce1a1c0855728f9ede1288f0224283dfc7e53) and middleware/middleware.go (8789f84814d815185cb5a7bc6c247969b67d0ff9b8045ee1c95f4c9ad59ff4b1) identify Go 1.7 net/http. Upstream revisions and the precise license/notice chain for the copied or ported code were not independently verified.

Static root go.mod (SHA-256 7eb620f0fce870d93eaba87bf6f8c36284db786108030ca229a5016461797090) declares module github.com/go-chi/chi/v5 and Go 1.24, with no require block; no root go.sum is tracked. Separate go.mod/go.sum pairs under _examples/rest and _examples/versions are explicitly excluded by the proposed scope. Their hashes are respectively 18ba038ee1930a7817c888711e6562aa26281658ef1515789b41fc3b47599c61 / 3c5053c9c97cfde3e040fd39ff6858ec65288042a624075ea13784b58cfc1037, and fd833daea12d311fd9c7182d433095eb224be3a4c80b26311e848c7e452affb5 / 0712aab90567f5fa0c11762c05494f8f6b42993b18573679ce165b805ad4e733. Those example dependencies are not evidence of the root module's dependency set.

## Reproduction

Set SAMPLE_CHECKOUT to exactly one of the three development paths under .superpowers/sdd/STATIC_LOADING_MODULE_GRAPH_IMPLEMENTATION_PLAN/corpus-checkouts/{D05,D07,D08}. These commands inspect tracked paths and text only:

    git -C "$SAMPLE_CHECKOUT" rev-parse HEAD
    git -C "$SAMPLE_CHECKOUT" rev-parse 'HEAD^{tree}'
    git -C "$SAMPLE_CHECKOUT" status --porcelain=v1
    git -C "$SAMPLE_CHECKOUT" ls-files | rg -ni '(^|/)(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)|(^|/)(third[-_. ]?party|vendor|attribution)(/|$)|(^|/)[^/]*(license|licence|copying|notice|copyright)[^/]*$'
    (cd "$SAMPLE_CHECKOUT" && git ls-files -z | xargs -0 rg -n -i --no-heading 'SPDX-License-Identifier|Copyright|Licensed under|Code generated|Auto generated by|DO NOT EDIT|copied from|ported from|adapted from|derived from|source[[:space:]]*:[[:space:]]*https?://')
    (cd "$SAMPLE_CHECKOUT" && git ls-files -z | xargs -0 shasum -a 256)

This search found material questions for exact upstream source revision and notice/license provenance, per-file generated-input coverage, and static dependency inventory completeness. The full embedded/transitive dependency license review and accountable acquisition-owner review remain open under T1a; no clearance or scope-freeze conclusion is made.
