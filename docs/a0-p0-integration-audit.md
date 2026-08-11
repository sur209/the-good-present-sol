# A.0 + P.0 integration audit

## Audit scope

- Audited baseline commit: `f7d6b1bc2544e91c2eb9bad054b05e2173baafd3` on `main`.
- Audit date: 2026-08-08.
- A.0 commit: `3ef1d65f7080c9978b3a363a4aedd586f8c0acec` (`docs: finalize affiliate operating contract`).
- P.0 commit: `f7d6b1bc2544e91c2eb9bad054b05e2173baafd3` (`feat: add product source provenance`).
- Goal 1 / Goal 2 integration baseline: `74896c5e56114fca6d7f587ef223a22f43b91e34` (`fix: harden goal 1 and goal 2 integration`).
- Scope: the implemented affiliate contract and product-source provenance as extensions of the existing canonical product catalog, Editorial Studio, publication boundary, and static Astro site.
- Deferred roadmap work was treated as out of scope, not as missing functionality.

The audit read all repository documentation, inspected the three relevant commits and current implementation, traced product and recommendation identity through Studio and Astro, exercised the affiliate/ordinary/missing destination cases, inspected the affiliate status and provenance modules, ran the untouched verification suite, and recursively inspected production artifacts.

## Baseline verification

The untouched baseline passed:

```text
npm.cmd run verify
```

Baseline result: formatting, strict TypeScript, 0 Astro diagnostics, 57 tests (50 Studio and 7 shared content/route tests), validation of 11 products / 1 cluster / 3 guides, and the 9-page static build all passed. An earlier run reached the Studio suite without a test failure but exceeded a 120-second command limit; the complete bounded rerun passed in 77.5 seconds.

## Concrete finding and fix

### Medium — Editing provenance timestamps changed their instant

`datetime-local` values have no timezone. The Studio rendered a stored UTC value by removing its `Z`, then parsed the submitted value in the server's local timezone. In the repository environment (`America/Buenos_Aires`), an unchanged value drifted as follows:

```text
stored:      2026-08-08T00:00:00.000Z
displayed:   2026-08-08T00:00
resubmitted: 2026-08-08T03:00:00.000Z
```

The minute-only field also discarded seconds and milliseconds. This made an unrelated source-record edit silently change provenance chronology.

Fix:

- The provenance form now labels its timestamp fields as UTC.
- Zone-less form values are parsed as UTC; already zoned programmatic values remain accepted.
- Rendering normalizes to UTC and preserves seconds and milliseconds with the native `datetime-local` step.
- The Studio integration test now submits a zone-less value with fractional seconds and verifies the exact stored and rendered timestamp.

The fix changes only Studio form conversion. It does not change the `ProductSourceRecord` schema, source identity, canonical products, recommendations, publication, or Astro.

No other concrete A.0/P.0 defect was demonstrated.

## Contract and workflow results

### Canonical product and provenance

- `content/products/{product-id}.json` remains the only canonical product catalog and public product identity.
- Guides reference products only by stable `productId`; source IDs and external IDs do not enter guide records.
- `editorial-data/product-sources/{source-id}.json` is a separate Studio-owned ledger whose records reference canonical product IDs.
- Source filenames and record IDs are checked for equality, unsafe IDs are rejected, missing canonical products block source operations, and external IDs are unique by the documented case-insensitive `(provider, marketplace, externalId)` tuple.
- Source saves use the existing atomic JSON writer and do not write canonical product or guide files.
- Seven of the eleven canonical products are reused by two guides. Provenance operations did not create another product representation or change any recommendation identity.

### Affiliate destinations

- `productDestination(product)` remains the single public-contract resolver. For Amazon Products it selects only a valid Amazon `affiliateUrl`; other Products retain the valid affiliate-first, ordinary-URL fallback.
- Studio preview and Astro both call that resolver and classify the selected URL as affiliate only when it is the resolved `affiliateUrl`.
- Affiliate destinations use sponsored/nofollow/noopener semantics and the affiliate CTA.
- Ordinary non-Amazon destinations use nofollow/noopener without sponsored semantics and use the ordinary-product CTA.
- Amazon Products without a valid affiliate destination render no merchant anchor.
- Guides contain no merchant destination fields, and no outbound redirect/proxy route exists.

### Affiliate program state and privacy

- Affiliate program records remain under `editorial-data/affiliate-programs/` and are read only by the Studio module.
- The strict schema rejects credential/secret fields. Provider credentials continue to live only in the local server environment.
- The status route is read-only and exposes no credential values or secret fields.
- Affiliate program state does not modify product records or participate in destination resolution.
- Astro imports canonical `content/` only; it does not import either editorial-data module.

### Goal 1 / Goal 2 invariants

- Stable product IDs, guide IDs, recommendation IDs, filenames, and ID-based relationships remain authoritative.
- Replacing a recommendation product remains local to that recommendation; updating a canonical product still affects every referencing guide without rewriting guide-specific copy.
- AI prompt input excludes `productUrl` and `affiliateUrl`. Strict generated schemas reject extra URL fields, generated copy rejects URLs, and generated IDs/products/order must exactly match system-controlled input.
- The draft-to-public transform constructs fresh strict public records and cannot publish provenance, program configuration, draft-only state, or provider credentials.
- Full-graph validation and atomic stable-ID publication remain unchanged.
- The internal-only `returnTo` allowlist still accepts only `/drafts/{safe-id}` and rejects external destinations.

## Required scenarios verified

### A — Affiliate-only product

The shared resolver test and isolated Astro integration build selected the canonical affiliate URL. The rendered control used `target="_blank"`, `rel="sponsored nofollow noopener"`, and the affiliate CTA. Studio preview uses the same resolver and classification.

### B — Ordinary product URL only

The isolated integration fixture removed `affiliateUrl` and added a valid `productUrl`. Astro rendered that URL with `rel="nofollow noopener"`, the ordinary-product CTA, and no `sponsored` token. Studio preview follows the same shared classification branch.

### C — Missing destination

The isolated fixture removed both destination fields. The affected recommendation rendered without an outbound merchant anchor, while the guide still built successfully.

### D — Product reuse

The current graph contains seven products used by two guides. Existing integration coverage updates a reused canonical product and verifies that another guide's recommendation ID and guide-specific copy remain unchanged.

### E — Provenance integrity

Isolated source-store and HTTP tests create, update, deduplicate, and reload source records without changing canonical product IDs or guide recommendation IDs. The new regression assertion preserves the exact UTC provenance timestamp, including seconds and milliseconds.

### F — Program-status privacy

The affiliate schema/status tests verify the committed program record, its missing-configuration state, and the absence of credential or secret fields in the rendered status page. The seed program remains disabled and intentionally lacks store/associate and tracking IDs.

### G — Redirect/input boundary

The existing HTTP test submitted an external `returnTo=https://evil.example`; the Studio omitted it and did not redirect externally. Product and source URLs continue to accept only absolute HTTP(S) values, and source/draft IDs reject traversal syntax.

### H — Production build isolation

The canonical production build emitted 14 files: 9 HTML pages, static metadata, one CSS asset, 0 JavaScript files, and 0 source maps. A recursive scan across HTML, CSS, XML, and text output found 0 matches for affiliate-program IDs/field names, provenance kinds/field names, AI configuration, credentials, Studio paths/state, loopback hosts, or local filesystem paths. The canonical artifact contained 18 external product controls, all with `target="_blank"` and `rel="sponsored nofollow noopener"` because the committed seed catalog currently contains affiliate-only demo destinations.

## Verification commands

Commands run from the repository root:

```text
npm.cmd run verify
npm.cmd run test --workspace @the-good-present/studio
npm.cmd run content:validate
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npx.cmd prettier --check apps/studio/src/server.ts apps/studio/src/studio.test.ts
git diff --check
```

The artifact inspection used a recursive PowerShell scan of `apps/site/dist/` for internal affiliate/provenance/configuration markers, AI and credential markers, Studio/draft state, loopback and local paths, JavaScript/source maps, and outbound-link attributes.

The Studio workspace has no separate build script or browser bundle. Its strict type check and 50-test server suite are the applicable Studio verification.

## Ponytail complexity audit

The whole-repository pass checked dependencies, module boundaries, exports and callers, destination resolution, filesystem stores, provider implementations, publication, routes, and A.0/P.0 roadmap placeholders.

No removable dependency, parallel product catalog, duplicate publication or destination resolver, affiliate-specific product copy, speculative service/plugin/worker layer, or replaceable standard-library implementation was found. The source-store linear scan is appropriate for the local ledger, Zod protects real trust boundaries, and the two provider implementations justify their existing interface.

Result: `Lean already. Ship.`

## Remaining known limitations

- All committed merchant destinations are visibly labeled `example.com` affiliate demos and must be replaced with verified editorial destinations before launch.
- The committed affiliate program is disabled and intentionally incomplete pending verified account identifiers.
- The committed product-source directory contains no operational source records; provenance behavior was verified with isolated temporary records.
- Ordinary-only and missing destination behavior is covered with isolated build fixtures because the committed seed catalog currently contains affiliate demo URLs for every product.
- Publication remains a one-local-editor workflow with one atomic record write at a time; no concurrency lock or multi-record transaction is intended at this stage.
- No external affiliate, merchant, Amazon, CSV, or AI account was contacted during this audit.

## Explicitly deferred roadmap items

These remain deliberate exclusions, not defects:

- A.1 manual affiliate-link intake;
- A.2 and later affiliate automation/reporting work;
- P.1 manual Amazon product intake;
- P.2 batch candidate import;
- P.3 Amazon Creators API integration;
- P.4 source refresh and change detection;
- I.0 product coverage analysis and later product intelligence;
- scraping, generic import pipelines, background workers, synchronization, and speculative plugin infrastructure.

## Final result

The focused tests, content validation, strict type checking, full test suite, canonical Astro build, production artifact scan, formatting check, and diff check passed. The final full `npm.cmd run verify` result after adding this report is recorded in the audit commit.

A.0 and P.0 remain coherent extensions of the existing Goal 1 / Goal 2 system. The only demonstrated integration defect was provenance timestamp drift, and the correction is confined to the Studio form boundary.
