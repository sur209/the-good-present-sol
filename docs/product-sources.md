# Product source provenance

Product source records are non-public Editorial Studio data. They explain where a canonical product was found without adding marketplace fields to the public `Product` contract.

## Storage and boundary

Records live at:

```text
editorial-data/product-sources/{source-id}.json
```

The owning Studio module is `apps/studio/src/modules/product-sources/`. The module validates, reads, looks up, deduplicates, and atomically writes records. Astro reads only `content/`, so these files are not part of the public build.

The canonical product remains `content/products/{product-id}.json`. Saving or replacing a source record never changes the product's stable ID, merchant, URLs, copy, status, or other editorial fields. A source record can be updated by its own stable source ID.

## Evidence domains

Product sourcing and fit review preserve five explicit domains:

| Domain                           | Owner and meaning                                                                                | May create canonical verified Product facts? |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| I.0 deterministic evidence       | System-derived token matches, exact IDs, in-Guide repetition, and distinct cross-Guide reuse IDs | No                                           |
| Provider-observed evidence       | Returned or manually observed name, merchant, URL/ID, price, rating/reviews, query, time, facts  | No                                           |
| AI interpretation                | Product-fit, gift-value, evidence/operations, and collection-quality assessments                 | No                                           |
| Editor decision                  | Intake confirmation, fulfillment/assignment choices, and optional EditorialBenchmarks            | Only through the separate confirmed intake   |
| Canonical verified Product facts | Editor-approved fields on an existing `content/products/{product-id}.json` record                | This is the canonical domain                 |

The P.2.3 fit prompt labels these domains in its structured input. A provider observation cannot be copied into `verifiedFacts` by the evaluator, and a ProductClassProfile requirement or EditorialBenchmark rationale is guidance rather than proof. Only the existing P.1 confirmation path can author a canonical Product; fit evaluation, benchmark creation, linking, fulfillment, and assignment remain separate actions.

## Record shape

```ts
type ProductSourceRecord = {
  id: string;
  productId: string;
  sourceKind:
    "manual" | "manual-amazon" | "csv-import" | "amazon-creators-api" | "serpapi" | "dataforseo";
  provider: string;
  marketplace?: string;
  externalId?: string;
  sourceUrl?: string;
  importMethod: "manual" | "csv" | "api";
  importedAt: string;
  lastReviewedAt?: string;
  lastSynchronizedAt?: string;
  sourceStatus: "active" | "inactive" | "needs-review";
  notes?: string;
  sourceFacts?: string[];
  imageRightsNotes?: string;
  originalProductUrl?: string;
  originalAffiliateUrl?: string;
  normalizedAffiliateUrl?: string;
  trackingId?: string;
};
```

`sourceUrl` accepts only absolute HTTP(S) URLs. An external ID requires a marketplace. Timestamps are ISO 8601 date-times. `provider`, `marketplace`, and `externalId` are trimmed and compared case-insensitively for source identity.

## Uniqueness and lookup

An external ID is unique within the tuple `(provider, marketplace, externalId)`. Records without an external ID do not participate in that duplicate check. The Studio rejects a new or updated record before writing when another source already owns the tuple.

The same tuple is used for deterministic lookup. A source may point to only an existing canonical product; missing-product or orphaned source records are errors. Product deletion is not part of this stage, and removing a canonical product without removing its source record is intentionally detected rather than silently ignored.

## Supported source kinds

- `manual`: editor-entered provenance.
- `manual-amazon`: editor-entered Amazon provenance created only by the validated Amazon US intake. It keeps the probable ASIN in `externalId`, the original pasted URLs, the normalized affiliate URL, and the selected tracking ID.
- `serpapi`: observed SerpAPI discovery evidence retained when an editor completes the ordinary P.1 intake.
- `dataforseo`: observed DataForSEO discovery evidence retained when the explicitly enabled paid provider is used and an editor completes P.1 intake.
- `csv-import`: provenance from a possible future controlled batch-import source adapter. The previous P.2 batch-import concept is deferred and is not implemented.
- `amazon-creators-api`: provenance from a future Amazon Creators API import.

There is no CSV importer, Amazon API integration, scraper, or automatic synchronization. `lastSynchronizedAt` is retained for controlled source workflows; external discovery writes its observation time only when the editor later confirms ordinary P.1 intake.

## Studio workflow

Open a product in `/products/{product-id}/edit`. The non-public provenance section lists existing sources and provides a form to create or update one. The form changes only `editorial-data/product-sources/`; merchant-source facts never overwrite the canonical product automatically.

For a product that has no external ID, use `manual` and record the provider, source URL, import timestamp, status, and notes as available. Add `marketplace` and `externalId` only when the source system supplies them. Use the Amazon intake for `manual-amazon`; the generic provenance form cannot create that kind.

## Assisted manual product intake

Use `/products/intake` when an editor needs to create a new canonical product and its source record together. The form keeps source evidence separate from original editorial copy:

- Amazon product URLs, editor-entered ASINs, pasted affiliate URLs, source facts, and image rights/provenance notes stay in the non-public source record.
- The editor writes the name, merchant, short description, and selected `verifiedFacts` as original catalog copy. Every selected fact must be affirmed as supported by the entered source facts.
- A price entry is a durable editorial label or range only; an exact current price is rejected. Images are references only, are never downloaded automatically, and require alt text plus rights/provenance notes.

The intake performs local HTTPS/host/ASIN checks, detects duplicate ASINs and likely canonical duplicates, and shows both the canonical `Product` and source record before saving. The editor must confirm explicitly. The Studio writes `content/products/{product-id}.json` and `editorial-data/product-sources/{source-id}.json` with rollback if the second write fails. No Amazon page is fetched, no HTML is extracted, no browser is automated, no Creators API call is made, and no affiliate URL is generated.

ASINs, source facts, and provenance notes are internal Studio data. The canonical product may contain only the editor-approved public fields from the shared schema, and guide changes still require the existing Goal 2 draft, preview, validation, and publication workflow.

## I.2 sourcing integration

A product-source candidate inside a `ProductSourcingRequest` is not a `ProductSourceRecord` and is not a canonical Product. It reuses the existing candidate model and contains reviewable source identity, observed name/facts, provenance kind, optional product/affiliate URL evidence, and review state. URL evidence keeps the normalized URL separate from the original pasted URL and may include a tracking ID and local warnings:

```ts
type ProductSourceCandidate = {
  sourceKind: "manual" | "amazon-creators-api" | "serpapi" | "dataforseo";
  provider: string;
  merchant?: string;
  domain?: string;
  marketplace?: string;
  externalId?: string;
  sourceUrl?: string;
  productUrl?: string;
  affiliateUrl?: string;
  originalProductUrl?: string;
  originalAffiliateUrl?: string;
  trackingId?: string;
  urlWarnings?: string[];
  query?: string;
  observedAt?: string;
  observedPrice?: string;
  observedRating?: number;
  observedReviewCount?: number;
  name: string;
  sourceFacts: string[];
  status: "needs-review" | "approved-for-intake" | "rejected" | "linked-to-product";
};
```

For an unresolved GuideDraft slot, the editor can resolve from the catalog or paste a product/affiliate URL. Both actions first create or reuse the same slot-origin I.2 request and preserve the inherited Guide/slot/sourcing context. Catalog matches show deterministic I.0 evidence, its threshold, and whether the Product is already used in the Guide; that evidence is not an editorial-fit label and never auto-selects or assigns the Product.

The manual URL path reuses the A.1 Amazon URL/ASIN/affiliate helpers. It performs no request, redirect expansion, HTML extraction, scrape, image download, or affiliate-link generation. Amazon URLs are separated into product and affiliate destinations locally; other HTTP(S) URLs are only normalized safely. Short links and missing tracking tags remain warnings for P.1 review.

The P.2 candidate handoff opens the existing P.1 intake with the URL evidence prefilled. The editor must still confirm Product identity, provenance, selected facts, original description, and affiliate destination when present. A successful P.1 write creates the canonical Product and its normal P.0 `ProductSourceRecord`, links the candidate back to both records, and returns to the same I.2 request. Linking is not fulfillment; the editor separately selects the Product and, for a slot, assigns it explicitly.

Batch approval authorizes later intake only. The existing manual intake, or a future controlled Creators API intake, must create the canonical Product and its normal source-provenance record. Linking the reviewed candidate then requires that exact `ProductSourceRecord` to belong to the active canonical Product and that supplied marketplace/external identity match. Linking still does not fulfill the editorial requirement; the editor separately selects the Product on the request.

The current repository has no Creators API client. I.2 accepts optional `amazon-creators-api` candidate fixtures or records from a future integration through this same candidate input and lifecycle. A later P.3 Amazon Creators API source must use this interface and queue rather than create a parallel catalog or review model.

## P.2.2 bounded external discovery

External candidate discovery stays inside `apps/studio/src/modules/product-sources/`. The provider-neutral `ProductDiscoverySource` accepts one concrete query plus a candidate bound and returns inputs for the existing `ProductSourceCandidate` model. SerpAPI and DataForSEO are adapters to that contract; neither creates a canonical Product, source record, I.2 fulfillment, or GuideDraft assignment.

The editor first selects unresolved sourcing requests and generates one batched `SearchPlan` through the existing editorial structured-generation provider. The prompt derives the editorial problem, use case, intended Product class, attributes, exclusions, and one to three concrete queries from the `GuideDraft`, stable recommendation slot, I.2 request, questionnaire, originating brief, budget, and taxonomies. Editors do not re-enter known context. The plan and provider metadata are stored on each existing request.

Before an external call, the run checks the canonical catalog, relevant EditorialBenchmarks, and recent compatible candidates. Resolved slots are skipped. An editor may explicitly override reusable evidence, but each slot remains capped at three queries, four stored external candidates, two concurrent calls, three provider calls per run, and two total rounds. Only the first round is offered initially; the second requires its own editor action. There is no retry-until-satisfied loop.

SerpAPI uses its current Google Shopping endpoint and API-key query authentication. DataForSEO uses its current Google organic live advanced endpoint with HTTP Basic authentication and extracts only returned shopping elements. These behaviors were verified against the official provider documentation on 2026-08-11:

- [SerpAPI Google Shopping API](https://serpapi.com/google-shopping-api), [shopping results](https://serpapi.com/shopping-results), and [status/error behavior](https://serpapi.com/api-status-and-error-codes).
- [DataForSEO authentication](https://docs.dataforseo.com/v3/auth/), [live advanced endpoint](https://docs.dataforseo.com/v3/serp-se-type-live-advanced/), and [advanced result fields](https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/).

No pricing or quota number is a domain invariant. Provider quota, configuration, timeout, malformed-response, unavailable, and zero-result states are surfaced as bounded round outcomes. `PRODUCT_DISCOVERY_PROVIDER` defaults to `disabled`; selecting `serpapi` also requires `SERPAPI_API_KEY`. DataForSEO additionally requires `DATAFORSEO_ENABLED=true`, `PRODUCT_DISCOVERY_PAID_POLICY=allow-paid-dataforseo`, and credentials. SerpAPI failure never invokes DataForSEO, because runtime configuration constructs exactly one selected provider and contains no fallback chain. Missing credentials leave catalog, recent-candidate, manual URL, and idea-only operation available.

Provider fields remain observation evidence on the candidate: title, merchant/domain, source URL, external/product ID, observed price, rating/review metadata, query, provider, and timestamp are copied only when actually returned. They do not become canonical verified facts. P.1 keeps that discovery provenance in the ordinary non-public `ProductSourceRecord`, while the editor authors and verifies the canonical Product separately.

## P.2.4 guide-wide resolution

The GuideDraft curation board creates or reuses one exact slot-origin I.2 request for every selected recommendation, then sends the inherited contexts through one batch SearchPlan generation. Its default selection is all Product-unresolved slots; a subset or exact slot is allowed, and resolved/ready slots are skipped unless the editor explicitly requests alternatives.

Resolution order is fixed and visible: active canonical catalog; relevant EditorialBenchmarks and recent compatible candidates; the one configured SerpAPI adapter; DataForSEO only when it is both enabled and explicitly selected; manual URL; or remain idea-only. Provider adapters are never chained, so a SerpAPI failure cannot spend against DataForSEO. SearchPlan edits and additional bounded rounds remain explicit editor actions.

Sourcing and provenance records support the decision without becoming separate checklist stages. Reviewing a candidate opens the existing P.1 intake; confirmed intake creates the ordinary P.0 record and links it to the candidate. The editor then explicitly fulfills I.2 and assigns the canonical Product to the exact slot. The board never assigns a source candidate or auto-selects a Product.

All SearchPlans, candidates, evaluations, benchmarks, requests, provider observations, source identities, IDs, and trace data remain under `editorial-data/` or Studio draft storage. Astro reads canonical `content/` only, so guide-wide discovery internals cannot enter the public build.

## Verification

From the repository root:

```sh
npm run typecheck
npm run test
npm run content:validate
npm run build
```

Studio tests cover schema strictness, all source kinds, safe IDs and paths, persistence and replacement, uniqueness and lookup, missing canonical products, editor integration, manual intake validation and confirmation, duplicate prevention, rollback after partial failure, source-to-product linking, temporary-file cleanup, guide selection, and exclusion from Astro output.
