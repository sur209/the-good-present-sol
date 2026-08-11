import assert from "node:assert/strict";
import test from "node:test";

import { productDestination, type ClusterHub, type GiftGuide, type Product } from "./schemas.ts";
import {
  assertValidPublicContent,
  formatValidationIssues,
  type PublicContentSources,
  type SourceRecord,
  validatePublicContent,
} from "./validation.ts";

const product: Product = {
  schemaVersion: 1,
  id: "product_shift-mug",
  name: "Insulated Shift Mug",
  merchant: "Demo Merchant",
  affiliateUrl: "https://example.com/products/shift-mug",
  shortDescription: "A lidded mug for long workdays.",
  status: "active",
  lastCheckedAt: "2026-08-01",
};

const guide: GiftGuide = {
  schemaVersion: 1,
  id: "guide_practical",
  pageType: "gift-guide",
  clusterId: "cluster_nurse-gifts",
  slug: "practical",
  language: "en-US",
  title: "Practical Gifts for Nurses",
  excerpt: "Useful gifts selected around real routines.",
  introduction: "A practical gift should make a demanding day a little easier.",
  primaryAxis: "gift-style",
  primaryIntent: "Find useful gifts nurses can genuinely use during or after a shift.",
  relatedGuideIds: [],
  seoTitle: "Practical Gifts for Nurses | The Good Present",
  seoDescription: "A human-edited guide to useful gifts for nurses.",
  status: "published",
  publishedAt: "2026-08-01",
  recommendations: [
    {
      id: "practical_mug",
      productId: product.id,
      position: 1,
      editorialDescription: "The lid and insulation suit stop-and-start breaks.",
      whyItFits: "It supports a daily routine without adding clutter.",
      editorialStatus: "ready",
    },
  ],
};

const cluster: ClusterHub = {
  schemaVersion: 1,
  id: "cluster_nurse-gifts",
  pageType: "cluster-hub",
  slug: "nurse-gifts",
  language: "en-US",
  title: "Nurse Gifts",
  excerpt: "Thoughtful gifts for the nurses in your life.",
  introduction: "Start with the person, their routine, and the moment you want to mark.",
  seoTitle: "Nurse Gifts | The Good Present",
  seoDescription: "Browse human-edited nurse gift guides by meaningful intent.",
  navigationGroups: [
    { id: "group_by-style", label: "By gift style", axis: "gift-style", guideIds: [guide.id] },
  ],
  status: "published",
  publishedAt: "2026-08-01",
};

function source(file: string, data: unknown): SourceRecord {
  return { file, data };
}

function validSources(): PublicContentSources {
  return {
    products: [source(`content/products/${product.id}.json`, structuredClone(product))],
    clusters: [source(`content/clusters/${cluster.id}.json`, structuredClone(cluster))],
    guides: [source(`content/guides/${guide.id}.json`, structuredClone(guide))],
  };
}

test("parses a complete valid public content graph", () => {
  const content = assertValidPublicContent(validSources());
  assert.equal(content.products[0]?.id, product.id);
  assert.equal(content.clusters[0]?.navigationGroups[0]?.guideIds[0], guide.id);
  assert.equal(content.guides[0]?.recommendations[0]?.productId, product.id);
});

test("accepts an editorially ready unresolved gift idea without a Product record", () => {
  const sources = validSources();
  sources.guides[0] = source(`content/guides/${guide.id}.json`, {
    ...guide,
    recommendations: [
      {
        id: "practical_recovery-ritual",
        productResolution: "unresolved",
        position: 1,
        heading: "A small recovery ritual for after a long shift",
        editorialDescription: "Build the gift around how they prefer to decompress at home.",
        whyItFits: "It starts with the recipient's routine instead of inventing a product.",
        bestFor: "Someone whose off-shift preferences you know well",
        considerations: "Look for easy care and a format that suits their space.",
        editorialStatus: "ready",
      },
    ],
  });
  sources.products = [];

  const content = assertValidPublicContent(sources);
  const recommendation = content.guides[0]!.recommendations[0]!;
  assert.equal(recommendation.productResolution, "unresolved");
  assert.equal(recommendation.productId, undefined);
});

test("rejects missing and mixed Product-resolution states", () => {
  for (const recommendation of [
    {
      id: "mixed_idea",
      productResolution: "unresolved",
      productId: product.id,
      position: 1,
      heading: "Mixed idea",
      editorialDescription: "Editorial description.",
      whyItFits: "Editorial reason.",
      editorialStatus: "ready",
    },
    {
      id: "ambiguous_idea",
      position: 1,
      heading: "Ambiguous idea",
      editorialDescription: "Editorial description.",
      whyItFits: "Editorial reason.",
      editorialStatus: "ready",
    },
  ]) {
    const sources = validSources();
    sources.guides[0] = source(`content/guides/${guide.id}.json`, {
      ...guide,
      recommendations: [recommendation],
    });
    assert.equal(validatePublicContent(sources).success, false);
  }
});

test("resolves one safe merchant destination from the central product record", () => {
  const { affiliateUrl: _affiliateUrl, ...withoutAffiliate } = product;
  const { affiliateUrl: _affiliateUrl2, productUrl: _productUrl, ...withoutLinks } = product;
  assert.equal(productDestination(product), product.affiliateUrl);
  assert.equal(
    productDestination({ ...withoutAffiliate, productUrl: "https://merchant.test/item" }),
    "https://merchant.test/item",
  );
  assert.equal(productDestination(withoutLinks), undefined);
  assert.equal(
    productDestination({
      ...product,
      affiliateUrl: "javascript:alert(1)",
      productUrl: "https://merchant.test/fallback",
    } as Product),
    "https://merchant.test/fallback",
  );
});

test("reports source-aware schema, URL, date, image, SEO, and draft-state failures", () => {
  const sources = validSources();
  sources.products[0] = source("content/products/product_bad.json", {
    ...product,
    id: "product_bad",
    productUrl: "data:text/html,unsafe",
    affiliateUrl: "javascript:alert(1)",
    image: "/images/mug.svg",
    lastCheckedAt: "2026-02-30",
  });
  sources.guides[0] = source("content/guides/guide_bad.json", {
    ...guide,
    id: "guide_bad",
    primaryAxis: "keyword",
    primaryIntent: " ",
    seoDescription: "",
    recommendations: [
      { ...guide.recommendations[0], editorialStatus: "needs-review", productId: "product_bad" },
    ],
  });
  sources.clusters[0] = source("content/clusters/cluster_bad.json", {
    ...cluster,
    id: "cluster_bad",
    seoTitle: "",
    publishedAt: "not-a-date",
  });
  sources.guides.push(
    source("content/guides/guide_empty.json", {
      ...guide,
      schemaVersion: 2,
      id: "guide_empty",
      slug: "empty-guide",
      recommendations: [],
    }),
  );

  const result = validatePublicContent(sources);
  assert.equal(result.success, false);
  if (result.success) return;

  const fields = result.issues.map(({ field }) => field);
  assert.ok(fields.includes("productUrl"));
  assert.ok(fields.includes("affiliateUrl"));
  assert.ok(fields.includes("imageAlt"));
  assert.ok(fields.includes("lastCheckedAt"));
  assert.ok(fields.includes("primaryAxis"));
  assert.ok(fields.includes("primaryIntent"));
  assert.ok(fields.includes("seoDescription"));
  assert.ok(fields.includes("recommendations[0]"));
  assert.ok(fields.includes("seoTitle"));
  assert.ok(fields.includes("publishedAt"));
  assert.ok(fields.includes("schemaVersion"));
  assert.ok(fields.includes("recommendations"));

  const formatted = formatValidationIssues(result.issues);
  assert.match(formatted, /content\/products\/product_bad\.json/);
  assert.match(formatted, /record "product_bad"/);
});

test("reports duplicate identities, routes, filenames, and broken cross-record relations", () => {
  const sources = validSources();
  const inactiveProduct = { ...product, id: "product_inactive", status: "inactive" as const };
  sources.products.push(
    source("content/products/product_inactive.json", inactiveProduct),
    source("content/products/product_duplicate-file.json", structuredClone(product)),
  );

  const conflictingCluster = { ...cluster, id: "cluster_other" };
  sources.clusters.push(
    source("content/clusters/cluster_other.json", conflictingCluster),
    source("content/clusters/cluster_duplicate-file.json", {
      ...cluster,
      slug: "nurse-gifts-duplicate",
      navigationGroups: [],
    }),
    source("content/clusters/cluster_reserved.json", {
      ...cluster,
      id: "cluster_reserved",
      slug: "about",
      navigationGroups: [],
    }),
  );

  const baseRecommendation = guide.recommendations[0]!;
  assert.ok(baseRecommendation.productId);
  const brokenGuide: GiftGuide = {
    ...guide,
    clusterId: "cluster_missing",
    relatedGuideIds: [guide.id, "guide_missing", "guide_missing", "guide_other"],
    recommendations: [
      baseRecommendation,
      { ...baseRecommendation, productId: inactiveProduct.id },
      {
        ...baseRecommendation,
        id: "practical_missing",
        position: 3,
        productId: "product_missing",
      },
    ],
  };
  sources.guides[0] = source(`content/guides/${guide.id}.json`, brokenGuide);
  sources.guides.push(
    source("content/guides/guide_second.json", {
      ...guide,
      id: "guide_second",
      clusterId: "cluster_missing",
    }),
    source("content/guides/guide_duplicate-file.json", { ...guide, slug: "graduation" }),
    source("content/guides/guide_other.json", {
      ...guide,
      id: "guide_other",
      clusterId: "cluster_other",
      slug: "graduation",
    }),
  );
  const sourceCluster = sources.clusters[0]?.data as ClusterHub;
  sourceCluster.navigationGroups[0]!.guideIds = [guide.id, guide.id, "guide_missing"];

  const result = validatePublicContent(sources);
  assert.equal(result.success, false);
  if (result.success) return;

  const report = formatValidationIssues(result.issues);
  for (const expected of [
    "Duplicate product ID",
    "Duplicate cluster ID",
    "Duplicate cluster slug",
    "Duplicate guide ID",
    "Duplicate guide slug inside its cluster",
    "reserved public path",
    "Canonical filename",
    'Duplicate guide ID "guide_practical" in this navigation group',
    "nonexistent published guide",
    "nonexistent published cluster",
    "cannot relate to itself",
    "Duplicate related guide ID",
    "does not exist or is not published",
    "belongs to cluster",
    "Duplicate recommendation ID",
    "Duplicate recommendation position",
    "inactive product",
    "nonexistent product",
  ]) {
    assert.match(report, new RegExp(expected));
  }

  for (const issue of result.issues) {
    assert.ok(issue.file);
    assert.ok(issue.recordId);
    assert.ok(issue.field);
    assert.ok(issue.reason);
  }

  assert.throws(() => assertValidPublicContent(sources), /Public content validation failed/);
});

test("surfaces JSON read errors with the source file", () => {
  const sources = validSources();
  sources.products.push({
    file: "content/products/product_broken.json",
    data: undefined,
    readError: "Invalid JSON: Unexpected token at line 2.",
  });

  const result = validatePublicContent(sources);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.issues.at(-1), {
    file: "content/products/product_broken.json",
    recordId: "<unknown>",
    field: "$file",
    reason: "Invalid JSON: Unexpected token at line 2.",
  });
});
