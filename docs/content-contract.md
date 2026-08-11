# Canonical public content contract

All public records use `schemaVersion: 1`. The canonical directories are:

```text
content/products/{product-id}.json
content/clusters/{cluster-id}.json
content/guides/{guide-id}.json
```

The filename stem must equal the record's stable `id`. Files are never named by editable slug. IDs persist across copy, URL, merchant, image, or slug changes.

## Shared package entry points

The Studio and public site import the same contract from `@the-good-present/content-schema`. Its public entry point exports:

- `productSchema`, `clusterHubSchema`, and `giftGuideSchema` plus their inferred TypeScript types.
- `productDestination` for the canonical validated affiliate-first merchant destination fallback.
- `PUBLIC_SCHEMA_VERSION`, `PRIMARY_AXES`, and `PUBLIC_CONTENT_DIRECTORIES`.
- `clusterPath`, `guidePath`, `canonicalUrl`, and the reserved-path constants.
- `validatePublicContent` for non-throwing validation and `assertValidPublicContent` for build boundaries.
- `formatValidationIssues` for actionable output.

Run all canonical record and relation checks from the repository root with:

```text
npm run content:validate
```

The exact public build command is `npm run build`; Astro emits only static assets to `apps/site/dist/`. Astro loads the same validator from its configuration, so invoking the site workspace build directly also rejects invalid public content.

## Shared primitives

```ts
type PageType = "cluster-hub" | "gift-guide";

type PrimaryAxis =
  "general" | "occasion" | "recipient" | "career-stage" | "work-context" | "gift-style" | "budget";
```

Public dates are ISO 8601 calendar dates. Public content is `en-US`; monetary budget context is `USD`. Slugs are lowercase URL-safe path segments. URLs accept only absolute `http:` and `https:` values.

## Product

A product is a reusable catalog entity, not a guide-specific recommendation:

```ts
type Product = {
  schemaVersion: 1;
  id: string;
  name: string;
  brand?: string;
  merchant: string;
  productUrl?: string;
  affiliateUrl?: string;
  shortDescription: string;
  verifiedFacts?: string[];
  priceLabel?: string;
  image?: string;
  imageAlt?: string;
  categories?: string[];
  interests?: string[];
  recipients?: string[];
  occasions?: string[];
  status: "active" | "inactive";
  lastCheckedAt?: string;
};
```

An image requires meaningful alternative text. Exact price, availability, stock, discount, rating, and review fields do not exist. URLs are controlled editorial data and never originate from generated copy. A product can be referenced by several guides; changing its catalog record affects every resolution of that ID.

## Cluster hub

```ts
type ClusterHub = {
  schemaVersion: 1;
  id: string;
  pageType: "cluster-hub";
  slug: string;
  language: "en-US";
  title: string;
  excerpt: string;
  introduction: string;
  seoTitle: string;
  seoDescription: string;
  navigationGroups: Array<{
    id: string;
    label: string;
    axis: PrimaryAxis;
    guideIds: string[];
  }>;
  status: "published";
  publishedAt: string;
  updatedAt?: string;
};
```

Navigation groups are manually curated. IDs cannot repeat inside a group. Every referenced guide must exist, be published, and belong to this cluster. A guide may appear in more than one useful group. Empty groups are valid editorial placeholders but do not render.

## Gift guide

```ts
type GiftGuide = {
  schemaVersion: 1;
  id: string;
  pageType: "gift-guide";
  clusterId: string;
  slug: string;
  language: "en-US";
  title: string;
  excerpt: string;
  introduction: string;
  conclusion?: string;
  primaryAxis: PrimaryAxis;
  primaryIntent: string;
  taxonomies?: {
    occasions?: string[];
    recipients?: string[];
    careerStages?: string[];
    workContexts?: string[];
    giftStyles?: string[];
    budgetLabels?: string[];
  };
  budgetContext?: {
    currency: "USD";
    label: string;
    minimum?: number;
    maximum?: number;
  };
  relatedGuideIds?: string[];
  seoTitle: string;
  seoDescription: string;
  status: "published";
  publishedAt: string;
  updatedAt?: string;
  recommendations: GuideRecommendation[];
};

type ProductBackedRecommendation = {
  id: string;
  productId: string;
  position: number;
  heading?: string;
  editorialDescription: string;
  whyItFits: string;
  bestFor?: string;
  considerations?: string;
  editorialStatus: "ready";
};

type UnresolvedGiftIdea = {
  id: string;
  productResolution: "unresolved";
  position: number;
  heading: string;
  editorialDescription: string;
  whyItFits: string;
  bestFor?: string;
  considerations?: string;
  editorialStatus: "ready";
};

type GuideRecommendation = ProductBackedRecommendation | UnresolvedGiftIdea;
```

Every guide has a nonempty explicit intent, one controlled primary axis, and at least one recommendation. Recommendation IDs and positions are unique within a guide. Related guides are unique, cannot self-reference, and must exist in the same cluster. Product-backed recommendations resolve active products by stable ID rather than duplicating product records.

P.2 deliberately extends the original Goal 1/Goal 2 Product-required recommendation contract. Existing Product-backed records keep their exact shape and require no migration. An idea-only record is unambiguous because it must contain `productResolution: "unresolved"`, must not contain `productId`, and must still be editorially `ready`. It may contain only generic editorial guidance: no Product or merchant identity, price, rating, review, stock, discount, availability, unsupported Product specification, or shopping CTA. `considerations` carries any current what-to-look-for guidance without adding a parallel field.

`productResolution` is intentionally asymmetric for backward compatibility: legacy Product-backed records are resolved by their required `productId`; only the new idea-only branch carries the discriminator. A recommendation ID and position survive unresolved publication, sourcing, later Product resolution, and Product replacement.

## Product update and replacement

These are different operations:

- **Product update:** the selected product remains the same while its merchant, URL, image, or other catalog metadata changes. The stable product ID stays in place, so every guide using it sees the update.
- **Product replacement:** one guide recommendation changes from one product ID to another. Its recommendation `id` and `position` stay fixed; only that guide is affected.

The Studio replacement flow is:

```text
existing recommendation slot
  -> replace productId
  -> preserve recommendation ID and position
  -> mark draft editorial copy needs-review
  -> edit or regenerate only that recommendation
  -> return editorialStatus to ready
  -> publish through the canonical public schema
```

`needs-review` and `needs-generation` are intentionally not public values. The canonical public contract accepts only `editorialStatus: "ready"`, while Product resolution remains the separate `productId`/`productResolution` state. Legacy draft `unassigned` values are accepted on read and normalized to `needs-generation`.

Questionnaire answers, prompts, outlines, provider/model identifiers, generation timestamps, validation notes, and temporary recommendation fields exist only in guide drafts. Provider credentials are neither draft fields nor public fields. Publication constructs a fresh strict public object, so none of that operational state can cross the canonical boundary.

## Cross-record validation

Validation fails with the affected source file, record ID when discoverable, field or relation, and an actionable reason. It covers malformed records plus duplicate IDs and slugs, filename/ID mismatches, reserved path collisions, missing or cross-cluster references, related-guide duplicates and self-links, invalid axes or intents, missing or inactive referenced products, ambiguous or mixed resolution states, unsafe URLs, invalid dates, image/alt mismatches, empty guides, duplicate recommendation IDs or positions, non-ready recommendations, missing SEO fields, and unsupported schema versions. Idea-only recommendations bypass Product lookup only because their strict unresolved branch forbids `productId`; Product-backed cross-record checks are unchanged.

The public build consumes the same validation result as the standalone validation command. No invalid or draft public content is rendered.

## Affiliate links

Product-backed recommendations resolve every outbound destination through the selected stable product ID and the central product catalog. `productDestination(product)` uses a valid `affiliateUrl` first, then a valid ordinary `productUrl`; it returns no destination when neither URL is valid. The guide record never stores a merchant URL. An unresolved gift idea has no Product lookup and renders no Product, merchant, price, or shopping UI.

An affiliate destination is manually controlled editorial data and uses a safe absolute HTTP(S) URL. Affiliate links open in a new tab with `rel="sponsored nofollow noopener"`. An ordinary product URL opens in a new tab with `rel="nofollow noopener"` and uses a `View product at…` label, so a direct merchant link is not presented as an affiliate link. Products without a valid destination render no merchant CTA. Links are direct external anchors; there is no internal open-redirect route or URL parameter.

The global disclosure is the public `/affiliate-disclosure/` page, linked from the site footer and available independently of any one guide. A guide places a short disclosure band near its commercial links when it contains affiliate destinations; the CTA itself identifies the merchant and uses the affiliate relation. Ordinary product links do not trigger an affiliate-only disclosure band. Development `example.com` URLs must be labeled as demos in both content and UI and replaced before production launch.

Affiliate-program account configuration is non-public Studio data under `editorial-data/affiliate-programs/`. It records program identity, marketplace, store or associate identifier, allowed tracking IDs, disclosure text/version, and enabled state. It does not contain secrets, does not modify product records, and is not read by Astro.

## Product source provenance

The canonical `Product` remains the editorial catalog record used by guides and Astro. Optional non-public `ProductSourceRecord` files live under `editorial-data/product-sources/`, owned by the Studio product-sources module. They record source kind, provider, marketplace, external ID, source URL, import and review timestamps, status, and notes without extending or changing the public product schema.

Source records are validated independently and must reference an existing canonical product. External IDs are unique within `(provider, marketplace, externalId)`; lookup and duplicate detection use that tuple. Updating or replacing a source record does not change the canonical product's stable ID or overwrite its merchant, URL, copy, or other editorial fields. No API, scraping, synchronization, or public ASIN requirement exists in this stage.

The Studio product editor shows and persists this provenance locally. The Astro build reads only `content/`, so source records and their provider identifiers do not enter public pages or static output.

## Studio and manual publishing workflow

The local Studio's Publish action creates or updates `content/{type}/{stable-id}.json`. It strips questionnaire answers, prompts, outline details, selection rationale, and other draft-only state; preserves `publishedAt` on updates; refreshes `updatedAt`; validates the complete candidate graph; and uses an atomic same-directory replacement. A slug edit changes the route field, never the filename or update identity. Publication does not run Git or deploy: the editor must review, commit, and push canonical changes separately.

Direct JSON editing remains a supported fallback. Every canonical record is named by stable ID.

### Add a product

1. Choose a durable ID that describes identity, not a current URL or mutable display name.
2. Create `content/products/{product-id}.json`; the filename stem and `id` must match.
3. Add original catalog-neutral copy, a merchant, and only verified editorial metadata.
4. Add `productUrl` or `affiliateUrl` only when an editor controls a safe absolute HTTP(S) destination.
5. If `image` is present, add meaningful `imageAlt`. Do not add stock, availability, ratings, reviews, discounts, or unsupported exact prices.

### Add a cluster hub

1. Apply the public-URL rule in `docs/architecture.md`; a set of tags is not enough.
2. Create `content/clusters/{cluster-id}.json` with a stable ID and an editable, globally unique, non-reserved slug.
3. Curate `navigationGroups` by stable guide ID. Every listed guide must already be a published guide in this cluster.
4. Leave a group empty only as a deliberate editorial placeholder; the public site does not render it.

### Add a gift guide

1. Confirm the intent is differentiated, substantial, and better than a section in an existing guide.
2. Create `content/guides/{guide-id}.json`; keep the stable ID independent from the slug.
3. Reference an existing published cluster, choose exactly one controlled `primaryAxis`, and write an explicit `primaryIntent`.
4. Keep each recommendation ID and position unique and publish only `editorialStatus: "ready"`. Use a stable `productId` for a Product-backed recommendation, or `productResolution: "unresolved"` with no `productId` for an editorially complete idea-only recommendation.
5. Add only same-cluster published guides to `relatedGuideIds`. Secondary taxonomies remain metadata and never create routes.
6. For a budget guide, record the editorial constraint in `budgetContext`; do not generate the guide from a price query.

### Validate and publish

1. Use the Studio's Publish action or add/edit one stable-ID-named JSON file in the appropriate canonical directory.
2. Keep slugs independent from IDs and apply the public-URL editorial rule in `docs/architecture.md`.
3. Reference products, clusters, and guides by stable ID.
4. Run `npm run content:validate`.
5. Run `npm run verify` before merging.
