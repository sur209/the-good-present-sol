# Product intelligence

Product intelligence is a read-only, non-public Studio analysis of how the canonical product catalog supports published content, current GuideDrafts, and structured product-gap reports. Open `/product-intelligence` in the local Editorial Studio to inspect it.

It reports catalog-health and editorial-coverage observations. It does not rank opportunities, propose a guide, create a candidate, select a product, or write canonical content.

## Inputs and ownership

The analysis reads three existing sources:

- Canonical products, guides, and clusters under `content/`, validated through `packages/content-schema`.
- File-based GuideDrafts from `drafts/`, validated by the existing Studio draft schema.
- Structured product-gap reports under `editorial-data/product-gaps/`, validated by the Studio-owned schema in `apps/studio/src/modules/product-intelligence/gaps.ts`.

The calculation lives in `apps/studio/src/modules/product-intelligence/coverage.ts`. Its thresholds and non-public types remain in that owning Studio module because there is no second runtime consumer. The report is calculated on request so it cannot become stale; no `editorial-data/product-intelligence/` snapshot, database, index, or write path is needed yet.

Astro still reads only the three canonical `content/` directories. Drafts, product-gap reports, thresholds, evidence, and rendered Studio HTML never enter the public build.

## Deterministic signals

All counts use normalized lowercase metadata and distinct canonical IDs.

| Group              | Signal                                       | Exact rule                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog health     | Active products unused by guides             | Active product ID referenced by zero published guide IDs. Draft selection does not turn unpublished work into published use.                                                                                |
| Catalog health     | Products reused across many guides           | Active product ID referenced by at least 3 distinct published guide IDs. Repeated recommendations inside one guide count once. This is a reuse observation, not a reward.                                   |
| Catalog health     | Categories with substantial coverage         | Normalized category represented by at least 3 distinct active product IDs. Guide appearances do not increase coverage.                                                                                      |
| Catalog health     | Categories represented by one product        | Normalized category represented by exactly 1 active product ID.                                                                                                                                             |
| Catalog health     | Clusters with low product-category diversity | Published cluster content draws from fewer than 3 distinct normalized categories across its distinct active product IDs. Reusing a product or category does not increase diversity.                         |
| Catalog health     | Broad audience or occasion metadata          | Active product has at least 3 distinct recipients or at least 3 distinct occasions. The Studio shows both lists; breadth is not treated as proof that more content should exist.                            |
| Editorial coverage | GuideDraft slots without a catalog match     | Unassigned slot has no active product sharing at least 2 distinct tokens with its label, intent, and search terms through the existing deterministic product-matching fields.                               |
| Editorial coverage | Brief requirements without catalog coverage  | A validated product-gap report has a stable slot whose explicit status is `unassigned`. The analyzer reports that structured editorial fact and reason; it does not reinterpret prose or infer suitability. |

Inactive products appear in their own section and are excluded from active coverage, diversity, broad-metadata, and slot-match calculations. Any published guide references are still shown as trace evidence if invalid input is supplied, though the canonical public validator normally rejects that state.

The defaults are exported as `DEFAULT_PRODUCT_COVERAGE_THRESHOLDS`:

```text
reusedGuideCount = 3
substantialCategoryProductCount = 3
minimumClusterCategoryCount = 3
broadMetadataValueCount = 3
minimumSlotMatchTokenCount = 2
```

Each value must be a positive integer. The dashboard displays the active values next to the signals so threshold behavior is never hidden.

## Explainability and inspection

Every signal exposes its contributing stable IDs:

- Product observations show the product ID, name, status, relevant metadata, and a link to the existing product editor.
- Reuse and cluster observations show every contributing published guide ID, title, cluster ID, and canonical route.
- Category observations list every distinct contributing active product.
- Draft-slot observations link to the existing GuideDraft and show the stable slot ID and search terms.
- Brief observations show the report, guide, cluster, and requirement slot IDs plus the stored reason.

There is no aggregate opportunity score. Catalog-health observations answer what the current records contain and reuse; editorial-coverage observations identify explicit missing support. Whether any observation merits product research, a brief change, a guide, or no action remains an editor decision.

## Boundaries

- No AI provider or structured-generation call is used.
- No embeddings, semantic index, network request, scraper, or product import is used.
- No canonical product, guide, or cluster is written.
- No draft, candidate, or guide is created automatically.
- Any later product work must use the existing intake and source-provenance flows.
- Any later guide work must use the existing Goal 2 preview, validation, and atomic publication flow.

## Verification

The Studio suite covers every signal class, threshold overrides, invalid thresholds, empty catalogs, distinct inactive handling, unique-guide reuse counting, dashboard traceability, and an isolated Astro build containing Studio-only sentinel data. The sentinel is visible in the dashboard and absent from filenames and HTML in the public artifact.

Run the focused or complete checks with:

```bash
npm run test --workspace @the-good-present/studio
npm run verify
```
