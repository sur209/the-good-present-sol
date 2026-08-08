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
- `productDestination` for the canonical affiliate-first merchant destination fallback.
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

type GuideRecommendation = {
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
```

Every guide has a nonempty explicit intent, one controlled primary axis, and at least one recommendation. Recommendation IDs and positions are unique within a guide. Related guides are unique, cannot self-reference, and must exist in the same cluster. Recommendations resolve active products by stable ID rather than duplicating product records.

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

`needs-review` is intentionally not a public value or schema in this stage. The canonical public contract accepts only `editorialStatus: "ready"`, ensuring draft-only workflow metadata cannot publish.

Questionnaire answers, prompts, outlines, provider/model identifiers, generation timestamps, validation notes, and temporary recommendation fields exist only in guide drafts. Provider credentials are neither draft fields nor public fields. Publication constructs a fresh strict public object, so none of that operational state can cross the canonical boundary.

## Cross-record validation

Validation fails with the affected source file, record ID when discoverable, field or relation, and an actionable reason. It covers malformed records plus duplicate IDs and slugs, filename/ID mismatches, reserved path collisions, missing or cross-cluster references, related-guide duplicates and self-links, invalid axes or intents, missing or inactive products, unsafe URLs, invalid dates, image/alt mismatches, empty guides, duplicate recommendation IDs or positions, non-ready recommendations, missing SEO fields, and unsupported schema versions.

The public build consumes the same validation result as the standalone validation command. No invalid or draft public content is rendered.

## Affiliate links

An outbound merchant control renders only when a validated destination exists. Affiliate destinations are manually controlled data and use safe absolute HTTP(S) URLs. Public links open in a new tab with `rel="sponsored nofollow noopener"`, identify the merchant, and never pass through an internal redirect. Development example URLs must be labeled as demos in both content and UI and replaced before production launch.

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
4. Reference products by stable ID. Keep each recommendation ID and position unique and publish only `editorialStatus: "ready"`.
5. Add only same-cluster published guides to `relatedGuideIds`. Secondary taxonomies remain metadata and never create routes.
6. For a budget guide, record the editorial constraint in `budgetContext`; do not generate the guide from a price query.

### Validate and publish

1. Use the Studio's Publish action or add/edit one stable-ID-named JSON file in the appropriate canonical directory.
2. Keep slugs independent from IDs and apply the public-URL editorial rule in `docs/architecture.md`.
3. Reference products, clusters, and guides by stable ID.
4. Run `npm run content:validate`.
5. Run `npm run verify` before merging.
