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

## Verification

From the repository root:

```sh
npm run typecheck
npm run test
npm run content:validate
npm run build
```

Studio tests cover schema strictness, all source kinds, safe IDs and paths, persistence and replacement, uniqueness and lookup, missing canonical products, editor integration, temporary-file cleanup, and exclusion from Astro output.
