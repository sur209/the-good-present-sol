# Canonical public content contract

All public records use `schemaVersion: 1`. The canonical directories are:

```text
content/products/{product-id}.json
content/clusters/{cluster-id}.json
content/guides/{guide-id}.json
```

The filename stem must equal the record's stable `id`. Files are never named by editable slug. IDs persist across copy, URL, merchant, image, or slug changes.

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

A future Studio replacement flow is:

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

## Cross-record validation

Validation fails with the affected source file, record ID when discoverable, field or relation, and an actionable reason. It covers malformed records plus duplicate IDs and slugs, filename/ID mismatches, reserved path collisions, missing or cross-cluster references, related-guide duplicates and self-links, invalid axes or intents, missing or inactive products, unsafe URLs, invalid dates, image/alt mismatches, empty guides, duplicate recommendation IDs or positions, non-ready recommendations, missing SEO fields, and unsupported schema versions.

The public build consumes the same validation result as the standalone validation command. No invalid or draft public content is rendered.

## Affiliate links

An outbound merchant control renders only when a validated destination exists. Affiliate destinations are manually controlled data and use safe absolute HTTP(S) URLs. Public links open in a new tab with `rel="sponsored nofollow noopener"`, identify the merchant, and never pass through an internal redirect. Development example URLs must be labeled as demos in both content and UI and replaced before production launch.

## Manual publishing workflow

Until the local Studio exists:

1. Add or edit one stable-ID-named JSON file in the appropriate canonical directory.
2. Keep slugs independent from IDs and apply the public-URL editorial rule in `docs/architecture.md`.
3. Reference products, clusters, and guides by stable ID.
4. Run `npm run content:validate`.
5. Run `npm run verify` before merging.
