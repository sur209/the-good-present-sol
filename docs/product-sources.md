# Product source provenance

Product source records are non-public Editorial Studio data. They explain where a canonical product was found without adding marketplace fields to the public `Product` contract.

## Storage and boundary

Records live at:

```text
editorial-data/product-sources/{source-id}.json
```

The owning Studio module is `apps/studio/src/modules/product-sources/`. The module validates, reads, looks up, deduplicates, and atomically writes records. Astro reads only `content/`, so these files are not part of the public build.

The canonical product remains `content/products/{product-id}.json`. Saving or replacing a source record never changes the product's stable ID, merchant, URLs, copy, status, or other editorial fields. A source record can be updated by its own stable source ID.

## Record shape

```ts
type ProductSourceRecord = {
  id: string;
  productId: string;
  sourceKind: "manual" | "manual-amazon" | "csv-import" | "amazon-creators-api";
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
- `csv-import`: provenance from a future controlled CSV import.
- `amazon-creators-api`: provenance from a future Amazon Creators API import.

The last two kinds record provenance only at this stage. There is no CSV importer, Amazon API integration, scraper, or automatic synchronization. `lastSynchronizedAt` is retained for future controlled workflows and is never populated automatically now.

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

A product-source candidate inside a `ProductSourcingRequest` is not a `ProductSourceRecord` and is not a canonical Product. It contains only reviewable source identity, observed name/facts, provenance kind, and review state. Candidate states are `needs-review`, `approved-for-intake`, `rejected`, and `linked-to-product`.

Batch approval authorizes later intake only. The existing manual intake, or a future controlled Creators API intake, must create the canonical Product and its normal source-provenance record. Linking the reviewed candidate then requires that exact `ProductSourceRecord` to belong to the active canonical Product and that supplied marketplace/external identity match. Linking still does not fulfill the editorial requirement; the editor separately selects the Product on the request.

The current repository has no Creators API client. I.2 accepts optional `amazon-creators-api` candidate fixtures or records from a future existing integration without depending on it, making network requests, scraping, creating Products automatically, or bypassing the source ledger.

## Verification

From the repository root:

```sh
npm run typecheck
npm run test
npm run content:validate
npm run build
```

Studio tests cover schema strictness, all source kinds, safe IDs and paths, persistence and replacement, uniqueness and lookup, missing canonical products, editor integration, manual intake validation and confirmation, duplicate prevention, rollback after partial failure, source-to-product linking, temporary-file cleanup, guide selection, and exclusion from Astro output.
