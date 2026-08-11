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

The request detail uses the existing deterministic catalog matcher and links to the existing assisted manual intake. Intake returns the new Product to the request screen but does not select it. Manual, SerpAPI, explicitly enabled DataForSEO, and optional future `amazon-creators-api` candidate records use the same review lifecycle; approval means only “approved for intake.” A reviewed candidate must still become a canonical Product with a matching `ProductSourceRecord`, be linked back to that record, and then be selected separately. No Creators API client is added or required; a future integration must provide the same validated candidate input.

## P.2.1 catalog-first and manual-URL resolution

An unresolved recommendation slot can create or reuse its own slot-origin I.2 request automatically. The editor can inspect active catalog Products with the existing I.0 matcher or paste a product/affiliate URL. Catalog cards show deterministic shared-token evidence, the I.0 threshold, and whether the Product is already used in the Guide. This is evidence with explicit limitations, not an editorial-fit label; there is no automatic Product choice or slot assignment.

The manual URL path reuses A.1 Amazon URL, ASIN, and affiliate helpers. It performs no network request, redirect expansion, HTML parsing, scraping, image download, or affiliate generation. Amazon product and affiliate URLs are separated locally, while non-Amazon input is limited to safe absolute HTTP(S) normalization. Short links, missing ASINs, and missing visible tracking tags are warnings for review rather than hidden resolution.

The URL is stored as the existing I.2 `ProductSourceCandidate` with normalized and original URL fields, optional ASIN/tracking evidence, and warnings. P.1 opens with this evidence prefilled but requires explicit confirmation of identity, provenance, facts, original description, and affiliate destination when present. P.1 then creates the canonical Product and P.0 `ProductSourceRecord`, links the candidate to both records, and returns to the same request. Fulfillment and exact slot assignment remain explicit later actions.

For a recommendation-slot origin, the final Assign action calls the ordinary Goal 2 `selectRecommendationProduct()` path and returns to the exact stable slot. The assignment preserves the slot ID and position. Existing generic copy moves to `needs-review`; an empty slot moves to `needs-generation`. It does not approve Product-backed copy or publish.

## P.2.2 bounded automatic discovery

An editor can select multiple open requests on `/product-sourcing` and generate their compact `SearchPlan` records in one structured call through the existing editorial provider. Known context comes from each I.2 request and its `GuideDraft`, exact recommendation slot, questionnaire, originating brief, budget, and taxonomies. Each plan follows editorial problem → use case → Product class → concrete query and contains must-have/useful attributes, exclusions, and one to three queries.

Running discovery is a separate editor action on one request. The provider-neutral Product source interface returns inputs for the existing I.2 `ProductSourceCandidate`; SerpAPI is supported, while DataForSEO is disabled by default and requires both explicit enablement and an explicit paid-use policy. There is exactly one configured provider and no automatic fallback. Missing credentials or provider failure leaves catalog search, recent candidates, manual URL intake, and idea-only publication available.

The run checks canonical catalog coverage, relevant EditorialBenchmarks, and recent compatible candidates before external calls, skips already resolved slots, and defaults to one round. A second and final round requires explicit action. Per slot, limits are three queries/provider calls, four stored external candidates, and two concurrent calls. Timeout, configuration/quota, malformed, unavailable, duplicate, and zero-result outcomes are recorded without autonomous retry.

Returned title, merchant/domain, source URL, external/product ID, price, rating/review metadata, provider, query, and observation time are source observations only. The candidate never becomes a Product automatically, and these fields do not expand the canonical Product schema or count as `verifiedFacts`. Ordinary P.1 intake, source-provenance review, I.2 fulfillment, exact slot assignment, copy review, and publication remain separate editor-controlled gates. The earlier P.2 batch-import concept is deferred as a possible future source adapter and is not implemented.

## P.2.3 product fit and gift value

The `ProductFitEvaluator` is an advisory AI interpretation over selected I.2 source candidates. An editor can select candidates from one or several sourcing requests and evaluate the batch with one structured provider call. The stored session lives under `editorial-data/product-fit-evaluations/` and preserves the compact structured input, strict response, provider/model, one-call and candidate counts, prompt/policy versions, and request/token metadata when the provider returns it.

The response persists all 21 dimensions; every dimension has its own `positive`, `neutral`, `negative`, or `unknown` assessment and rationale:

- Editorial/functional fit: Product class match, slot specificity, Guide relevance, recipient fit, occasion/career-stage/work-context fit, and supported budget compatibility.
- Consumer/gift value: practical usefulness, gift desirability, presentation/giftability, ease of choosing correctly, compatibility/selection risk, perceived value, and contextual emotional relevance or memorability.
- Evidence/operations: evidence quality, maintenance risk, commercial suitability, and existing-catalog reuse opportunity.
- Collection quality: in-Guide distinctiveness, redundancy with current selections, repeated Product class, and repeated functional role.

`unknown` is required when the evidence cannot support a conclusion. In particular, price-band compatibility and perceived value remain unknown without usable observed-price and budget evidence. The diagnostic summary separately records possible provider-result weakness, SearchPlan/class mismatch, profile coverage, and fit-confidence limits so later review can distinguish discovery, planning, profile, and interpretation failures.

The evaluator cannot return a total, winner, selection, rejection, canonical Product ID assignment, verified fact, fulfillment transition, or GuideDraft assignment. It receives provider observations in an explicitly labeled domain and canonical Product facts only when an already linked canonical Product exists. A profile requirement means “look for evidence”; it never supplies the missing fact.

The guide-wide board does not expose all 21 dimensions by default. Candidate cards group the current editorial decision into slot fit, gift value, evidence quality, in-guide distinctiveness, and the most important risk or missing evidence. The full dimension-by-dimension record, provider observations, IDs, and traceability remain available through expandable diagnostics.

### ProductClassProfiles

The internal v1 registry is deliberately small and dogfood-derived:

- `weatherproof-field-notebook`
- `hydration-reservoir`
- `compression-socks`
- `insulated-drinkware`
- `protective-equipment-case`
- `generic`, the mandatory fallback

Each profile has a stable class ID, aliases/search vocabulary, important and truly required attributes, undesirable attributes, compatibility risks, giftability guidance, query-expansion hints, maintenance considerations, evaluation guidance, and version. The evaluator passes only a compact profile summary. Profiles are code-controlled internal guidance; benchmarks do not mutate them, and missing profile attributes do not become Product facts.

### Ranking policy v1

`product-fit-ranking-v1` is a deterministic lexicographic ordering aid, not a score. It orders by:

1. fewer negative critical dimensions;
2. more positive core dimensions;
3. fewer negative collection dimensions;
4. fewer unknown dimensions;
5. stable request/candidate ID tie-break.

Every stored candidate ordering entry exposes those four counts, the session preserves all dimensions, and the policy object lists the contributing dimension paths. There is no sum, weight, automatic winner, selection, or rejection.

### EditorialBenchmarks

An editor may optionally use **Marcar como referencia editorial** on an especially strong selected canonical Product. The internal record under `editorial-data/editorial-benchmarks/` keeps the canonical Product ID, Product class, Guide/slot or semantic context, audience/context tags, concise rationale, structured strong-fit reasons, free-form attributes/reasons, optional discovery-session/rejected-alternative references, status, version, and timestamps.

Structured reasons are: more specific, correct class, stronger real-world use, better gift desirability, easier to choose, better presentation, better value, better context fit, and less generic. A benchmark is an explicit editor decision and a compact advisory example. It does not auto-select, add a ranking boost, mutate a class profile, become hidden training data, or force later Product reuse.

### Collection diversity and evidence boundaries

The deterministic input stores exact in-Guide canonical repetition separately from distinct published Guide IDs that reuse the Product. In-Guide repetition can produce a visible collection concern and affect v1 ordering through the documented signals; it never auto-rejects legitimate overlap. Cross-Guide reuse is a separate reuse opportunity and is not treated as in-Guide redundancy.

The five domains remain separate throughout:

1. I.0 deterministic evidence;
2. provider-observed evidence;
3. AI interpretation;
4. editor decisions, including benchmarks;
5. canonical verified Product facts.

Deterministic extraction precedes AI. Candidate/slot evaluation is batched by default, profiles and benchmarks are compact summaries rather than historical sessions, and the evaluator makes no discovery call. Provider call count is always one per fit batch; input/output/total token counts and request ID are stored only when returned by the configured provider.

## P.2.4 guide-wide curation and progressive Product resolution

`/drafts/{guide-id}/curation` is a compact projection over the authoritative GuideDraft, I.2 request/candidate data, P.2.2 discovery, P.2.3 fit sessions and EditorialBenchmarks, P.1 intake, and P.0 provenance. It does not add a curation record or parallel lifecycle.

The default scope is every unresolved Product-resolution slot. The editor may choose a subset or one exact slot; Product-resolved/ready recommendations are omitted unless alternatives are explicitly requested. One batch action creates or reuses exact slot-origin I.2 requests and generates SearchPlans from inherited guide, slot, questionnaire, brief, discovery, budget, taxonomy, and requirement context. No known context is re-entered.

Resolution remains editor-controlled and ordered: canonical catalog; recent compatible candidates and relevant EditorialBenchmarks; configured SerpAPI; DataForSEO only when explicitly enabled and selected; manual URL; or remain idea-only. There is no automatic Product selection or hidden paid fallback. Each slot receives one recommended next action, while ordinary actions link back to catalog selection, P.1 candidate review, URL intake, rejection, another bounded round, SearchPlan editing, idea-only copy, or evidence detail.

Idea-only copy uses the separate `idea-recommendation-v1` operation. Its strict input contains only generic guide/slot intent, requirement guidance, audience, budget, Product class, what-to-look-for attributes, and exclusions. Product records, candidates, merchants, source URLs, and provenance are excluded. The output must provide useful consumer guidance without naming an exact Product or merchant or asserting price, rating/review, stock/discount/availability, URLs, or Product-specific specifications.

Later Product attachment preserves guide ID, recommendation ID, position, and canonical route. The chosen item follows exact I.2 create/reuse, P.1 review, P.0 provenance, canonical Product creation, explicit sourcing fulfillment, and explicit slot assignment. Generic copy moves to `needs-review`; the editor reviews manually or regenerates only that recommendation. Publishing the idea does not satisfy I.0 coverage, and A.2 treats the gap as an opportunity rather than an affiliate hard error.

## Boundaries

- I.0 analysis and ordinary I.2 transitions use no AI or network. P.2.2 uses the existing editorial structured-generation adapter only when the editor requests a batch SearchPlan, then calls only the explicitly selected Product discovery provider when the editor starts a bounded round.
- No embeddings, semantic index, scraper, browser automation, automatic product import, or automatic provider fallback is used.
- I.0 analysis and I.2 request transitions write no canonical product, guide, or cluster; only the separately confirmed existing intake and Goal 2 paths may do so.
- No draft, candidate, or guide is created automatically.
- I.1 reads selected I.0 results but does not change thresholds, calculate a second coverage report, or turn a signal into an editorial decision.
- I.2 coordinates explicit requirements and reviewed selections but does not recalculate I.0, create Products, or choose products automatically. Editorial publication does not fulfill or hide an unresolved Product requirement.
- P.2.1 coordinates catalog/URL resolution into I.2 but does not introduce a second candidate model, editorial-fit score, network lookup, automatic fulfillment, or automatic assignment.
- P.2.2 stores plans, observed evidence, and bounded round outcomes on existing I.2 records. It does not add canonical rating/review fields, turn observation into verification, create Products, fulfill I.2, assign a slot, or publish.
- P.2.3 stores advisory fit sessions and explicit editor benchmarks in separate non-public directories. Neither record changes a source candidate, sourcing request, Product, ProductClassProfile, GuideDraft, or public artifact.
- P.2.4 adds only a guide-wide projection and separate safe idea-copy operation. It reuses every existing request, discovery, intake, provenance, Product, assignment, review, publication, A.2, and I.0 boundary.
- Any later product work must use the existing intake and source-provenance flows.
- Any later guide work must use the existing Goal 2 preview, validation, and atomic publication flow.

## Verification

The Studio suite covers every signal class, threshold overrides, invalid thresholds, empty catalogs, distinct inactive handling, unique-guide reuse counting, dashboard traceability, and an isolated Astro build containing Studio-only sentinel data. The sentinel is visible in the dashboard and absent from filenames and HTML in the public artifact.

Run the focused or complete checks with:

```bash
npm run test --workspace @the-good-present/studio
npm run verify
```
