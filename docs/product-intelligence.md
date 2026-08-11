# Product intelligence

The deterministic product-coverage analysis is a read-only, non-public Studio view of how the canonical product catalog supports published content, current GuideDrafts, and structured product-gap reports. Open `/product-intelligence` in the local Editorial Studio to inspect it. I.2 adds a separate non-public sourcing-request ledger at `/product-sourcing`. P.2 extends coverage with published recommendations whose editorial content is ready while Product resolution remains open.

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
| Editorial coverage | Published recommendations without a Product  | A valid published recommendation uses `productResolution: unresolved`. It remains a Product-resolution gap even though it is editorially publishable and renders without a CTA.                             |
| Editorial coverage | GuideDraft slots without a catalog match     | Slot without `productId` has no active product sharing at least 2 distinct tokens with its label, intent, and search terms through the existing deterministic product-matching fields.                      |
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
- Published unresolved observations show the guide ID/title/route and stable recommendation ID.
- Brief observations show the report, guide, cluster, and requirement slot IDs plus the stored reason.

There is no aggregate opportunity score. Catalog-health observations answer what the current records contain and reuse; editorial-coverage observations identify explicit missing support. Whether any observation merits product research, a brief change, a guide, or no action remains an editor decision.

## I.1 Opportunity Lab consumption

Coverage-first Lab sessions may select deterministic I.0 observations from the existing `/opportunities` form. The Lab derives stable `coverage_...` selector IDs at read time and carries each selected observation's exact contributing canonical product IDs and deterministic `category_...` IDs into the ordinary generation session and candidates. The `category_...` IDs are derived from normalized catalog values or explicit gap requirements; they are selection/provenance identifiers, not a second catalog or public schema.

This is a one-way read boundary: `analyzeProductCoverage()` remains the only coverage calculation, writes no snapshot, and makes no recommendation. The divergent stage frames hypotheses; the convergent stage must separately consider thin-content, cannibalization, product-concentration, catalog-volatility, and product-reuse concerns; the editor still chooses page, section, merge, hold, or rejection through the existing Lab decisions. No signal, product, underused group, or gap automatically creates a candidate, brief, draft, URL, sourcing task, or product intake.

## I.2 product-sourcing requests

I.2 adds a controlled write path at `/product-sourcing`. Studio-owned records live at `editorial-data/product-intelligence/request_{stable-id}.json` and keep the exact originating candidate, EditorialBrief, GuideDraft, or GuideDraft recommendation-slot identity together with the intended role, category, audience, occasion, budget, required verified facts, exclusions, search terms, lifecycle status, source-candidate review, selected canonical Product IDs, and timestamps.

The statuses are `open`, `partially-fulfilled`, `fulfilled`, `held`, and `rejected`. Holding or rejecting is explicit. Partial or complete fulfillment can happen only by explicitly selecting an active canonical Product from the existing catalog whose `verifiedFacts` contain every must-have fact on the request. The same Product can fulfill another request only through another explicit selection.

The request detail uses the existing deterministic catalog matcher and links to the existing assisted manual intake. Intake returns the new Product to the request screen but does not select it. Manual and optional `amazon-creators-api` candidate records may be reviewed in a batch; approval means only “approved for intake.” A reviewed candidate must still become a canonical Product with a matching `ProductSourceRecord`, be linked back to that record, and then be selected separately. No Creators API client is added or required; an existing or future integration may provide the same validated candidate input.

## P.2.1 catalog-first and manual-URL resolution

An unresolved recommendation slot can create or reuse its own slot-origin I.2 request automatically. The editor can inspect active catalog Products with the existing I.0 matcher or paste a product/affiliate URL. Catalog cards show deterministic shared-token evidence, the I.0 threshold, and whether the Product is already used in the Guide. This is evidence with explicit limitations, not an editorial-fit label; there is no automatic Product choice or slot assignment.

The manual URL path reuses A.1 Amazon URL, ASIN, and affiliate helpers. It performs no network request, redirect expansion, HTML parsing, scraping, image download, or affiliate generation. Amazon product and affiliate URLs are separated locally, while non-Amazon input is limited to safe absolute HTTP(S) normalization. Short links, missing ASINs, and missing visible tracking tags are warnings for review rather than hidden resolution.

The URL is stored as the existing I.2 `ProductSourceCandidate` with normalized and original URL fields, optional ASIN/tracking evidence, and warnings. P.1 opens with this evidence prefilled but requires explicit confirmation of identity, provenance, facts, original description, and affiliate destination when present. P.1 then creates the canonical Product and P.0 `ProductSourceRecord`, links the candidate to both records, and returns to the same request. Fulfillment and exact slot assignment remain explicit later actions.

For a recommendation-slot origin, the final Assign action calls the ordinary Goal 2 `selectRecommendationProduct()` path and returns to the exact stable slot. The assignment preserves the slot ID and position and moves the slot to `needs-generation`, including when the generic idea was previously editorially ready or published. It does not approve Product-backed copy or publish.

## Boundaries

- No AI provider or structured-generation call is used.
- No embeddings, semantic index, network request, scraper, or product import is used.
- I.0 analysis and I.2 request transitions write no canonical product, guide, or cluster; only the separately confirmed existing intake and Goal 2 paths may do so.
- No draft, candidate, or guide is created automatically.
- I.1 reads selected I.0 results but does not change thresholds, calculate a second coverage report, or turn a signal into an editorial decision.
- I.2 coordinates explicit requirements and reviewed selections but does not recalculate I.0, create Products, or choose products automatically. Editorial publication does not fulfill or hide an unresolved Product requirement.
- P.2.1 coordinates catalog/URL resolution into I.2 but does not introduce a second candidate model, editorial-fit score, network lookup, automatic fulfillment, or automatic assignment.
- Any later product work must use the existing intake and source-provenance flows.
- Any later guide work must use the existing Goal 2 preview, validation, and atomic publication flow.

## Verification

The Studio suite covers every signal class, threshold overrides, invalid thresholds, empty catalogs, distinct inactive handling, unique-guide reuse counting, dashboard traceability, and an isolated Astro build containing Studio-only sentinel data. The sentinel is visible in the dashboard and absent from filenames and HTML in the public artifact.

Run the focused or complete checks with:

```bash
npm run test --workspace @the-good-present/studio
npm run verify
```
