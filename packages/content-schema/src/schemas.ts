import { z } from "zod";

import { SLUG_PATTERN } from "./routes.ts";

export const PUBLIC_SCHEMA_VERSION = 1 as const;

export const PUBLIC_CONTENT_DIRECTORIES = {
  products: "content/products",
  clusters: "content/clusters",
  guides: "content/guides",
} as const;

export const PAGE_TYPES = ["cluster-hub", "gift-guide"] as const;
export const PRIMARY_AXES = [
  "general",
  "occasion",
  "recipient",
  "career-stage",
  "work-context",
  "gift-style",
  "budget",
] as const;

const nonEmptyString = z.string().trim().min(1, "Must not be empty.");
const contentIdSchema = nonEmptyString.regex(
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
  "Must use lowercase letters, numbers, hyphens, or underscores and be safe as a filename.",
);
const slugSchema = nonEmptyString.regex(SLUG_PATTERN, "Must be a lowercase URL-safe slug.");
const dateSchema = z.iso.date();
const stringListSchema = z.array(nonEmptyString);

export const safeHttpUrlSchema = z.url({ protocol: /^https?$/ });

const AMAZON_HOSTS = new Set([
  "amazon.com",
  "www.amazon.com",
  "smile.amazon.com",
  "amzn.to",
  "a.co",
]);

function isAmazonUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return AMAZON_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const amazonAffiliateUrlSchema = z
  .string()
  .trim()
  .url("Must be a valid URL.")
  .refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", "Must use HTTPS.")
  .refine(isAmazonUrl, "Must use an accepted Amazon retail hostname.");

const imageSchema = nonEmptyString.refine(
  (value) =>
    safeHttpUrlSchema.safeParse(value).success ||
    (/^\/(?!\/)[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/.test(value) && !value.includes("..")),
  "Must be a safe absolute HTTP(S) URL or root-relative local asset path.",
);

export const pageTypeSchema = z.enum(PAGE_TYPES);
export const primaryAxisSchema = z.enum(PRIMARY_AXES);

export const productSchema = z
  .strictObject({
    schemaVersion: z.literal(PUBLIC_SCHEMA_VERSION),
    id: contentIdSchema,
    name: nonEmptyString,
    brand: nonEmptyString.optional(),
    merchant: nonEmptyString,
    productUrl: safeHttpUrlSchema.optional(),
    affiliateUrl: safeHttpUrlSchema.optional(),
    shortDescription: nonEmptyString,
    verifiedFacts: stringListSchema.optional(),
    priceLabel: nonEmptyString.optional(),
    image: imageSchema.optional(),
    imageAlt: nonEmptyString.optional(),
    categories: stringListSchema.optional(),
    interests: stringListSchema.optional(),
    recipients: stringListSchema.optional(),
    occasions: stringListSchema.optional(),
    status: z.enum(["active", "inactive"]),
    lastCheckedAt: dateSchema.optional(),
  })
  .refine((product) => !product.image || product.imageAlt, {
    path: ["imageAlt"],
    message: "Alternative text is required when an image is present.",
  });

export const clusterNavigationGroupSchema = z.strictObject({
  id: contentIdSchema,
  label: nonEmptyString,
  axis: primaryAxisSchema,
  guideIds: z.array(contentIdSchema),
});

export const clusterHubSchema = z.strictObject({
  schemaVersion: z.literal(PUBLIC_SCHEMA_VERSION),
  id: contentIdSchema,
  pageType: z.literal("cluster-hub"),
  slug: slugSchema,
  language: z.literal("en-US"),
  title: nonEmptyString,
  excerpt: nonEmptyString,
  introduction: nonEmptyString,
  seoTitle: nonEmptyString,
  seoDescription: nonEmptyString,
  navigationGroups: z.array(clusterNavigationGroupSchema),
  status: z.literal("published"),
  publishedAt: dateSchema,
  updatedAt: dateSchema.optional(),
});

const guideTaxonomiesSchema = z.strictObject({
  occasions: stringListSchema.optional(),
  recipients: stringListSchema.optional(),
  careerStages: stringListSchema.optional(),
  workContexts: stringListSchema.optional(),
  giftStyles: stringListSchema.optional(),
  budgetLabels: stringListSchema.optional(),
});

const budgetContextSchema = z
  .strictObject({
    currency: z.literal("USD"),
    label: nonEmptyString,
    minimum: z.number().nonnegative().optional(),
    maximum: z.number().nonnegative().optional(),
  })
  .refine(
    ({ minimum, maximum }) => minimum === undefined || maximum === undefined || minimum <= maximum,
    {
      path: ["maximum"],
      message: "Maximum budget must be greater than or equal to minimum budget.",
    },
  );

export const shoppingOptionsSchema = z
  .array(
    z.strictObject({
      name: nonEmptyString.max(120),
      description: nonEmptyString.max(500),
      imageUrl: imageSchema.optional(),
      affiliateUrl: amazonAffiliateUrlSchema.refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          ["amazon.com", "www.amazon.com"].includes(url.hostname) &&
          /^\/dp\/[A-Z0-9]{10}\/?$/.test(url.pathname) &&
          /^[a-zA-Z0-9-]+-20$/.test(url.searchParams.get("tag") ?? "")
        );
      }, "Must be an Amazon.com product link with a US affiliate tracking ID."),
    }),
  )
  .min(1)
  .max(10)
  .superRefine((options, context) => {
    const products = new Set<string>();
    options.forEach((option, index) => {
      if (!URL.canParse(option.affiliateUrl)) return;
      const asin = new URL(option.affiliateUrl).pathname.replace(/\/$/, "");
      if (products.has(asin))
        context.addIssue({
          code: "custom",
          path: [index, "affiliateUrl"],
          message: "Duplicate Amazon product.",
        });
      products.add(asin);
    });
  });

const productBackedGuideRecommendationSchema = z.strictObject({
  id: contentIdSchema,
  productId: contentIdSchema,
  productResolution: z.never().optional(),
  directAffiliateUrl: amazonAffiliateUrlSchema.optional(),
  shoppingOptions: shoppingOptionsSchema.optional(),
  position: z.number().int().positive(),
  heading: nonEmptyString.optional(),
  editorialDescription: nonEmptyString,
  whyItFits: nonEmptyString,
  bestFor: nonEmptyString.optional(),
  considerations: nonEmptyString.optional(),
  editorialStatus: z.literal("ready"),
});

const unresolvedGuideRecommendationSchema = z.strictObject({
  id: contentIdSchema,
  productId: z.never().optional(),
  productResolution: z.literal("unresolved"),
  directAffiliateUrl: amazonAffiliateUrlSchema.optional(),
  shoppingOptions: shoppingOptionsSchema.optional(),
  position: z.number().int().positive(),
  heading: nonEmptyString,
  editorialDescription: nonEmptyString,
  whyItFits: nonEmptyString,
  bestFor: nonEmptyString.optional(),
  selectionGuidance: nonEmptyString.optional(),
  considerations: nonEmptyString.optional(),
  editorialStatus: z.literal("ready"),
});

export const guideRecommendationSchema = z.union([
  productBackedGuideRecommendationSchema,
  unresolvedGuideRecommendationSchema,
]);

export const giftGuideSchema = z.strictObject({
  schemaVersion: z.literal(PUBLIC_SCHEMA_VERSION),
  id: contentIdSchema,
  pageType: z.literal("gift-guide"),
  clusterId: contentIdSchema,
  slug: slugSchema,
  language: z.literal("en-US"),
  title: nonEmptyString,
  excerpt: nonEmptyString,
  introduction: nonEmptyString,
  conclusion: nonEmptyString.optional(),
  primaryAxis: primaryAxisSchema,
  primaryIntent: nonEmptyString,
  taxonomies: guideTaxonomiesSchema.optional(),
  budgetContext: budgetContextSchema.optional(),
  relatedGuideIds: z.array(contentIdSchema).optional(),
  seoTitle: nonEmptyString,
  seoDescription: nonEmptyString,
  status: z.literal("published"),
  publishedAt: dateSchema,
  updatedAt: dateSchema.optional(),
  recommendations: z
    .array(guideRecommendationSchema)
    .min(1, "A published gift guide must contain at least one recommendation."),
});

export type PageType = z.infer<typeof pageTypeSchema>;
export type PrimaryAxis = z.infer<typeof primaryAxisSchema>;
export type Product = z.infer<typeof productSchema>;
export type ClusterNavigationGroup = z.infer<typeof clusterNavigationGroupSchema>;
export type ClusterHub = z.infer<typeof clusterHubSchema>;
export type GuideRecommendation = z.infer<typeof guideRecommendationSchema>;
export type GiftGuide = z.infer<typeof giftGuideSchema>;

export function productDisplayName(product: Pick<Product, "name">): string {
  const firstListingSegment = product.name.split("|")[0]!.split(",")[0]!.trim();
  const withoutListingMeasurements = firstListingSegment
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:count|pack|mg|g|kg|oz|ounces?|ml|liters?|inches?|cm|mm|servings?)\b/gi,
      "",
    )
    .replace(/\s+[-–—]\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const concise = withoutListingMeasurements || firstListingSegment || "Product";
  if (concise.length <= 80) return concise;
  return `${concise
    .slice(0, 77)
    .replace(/\s+\S*$/, "")
    .replace(/[,:;\s-]+$/, "")}…`;
}

export function isAmazonProduct(
  product: Pick<Product, "merchant" | "productUrl" | "affiliateUrl">,
): boolean {
  return (
    /\bamazon\b/i.test(product.merchant) ||
    isAmazonUrl(product.productUrl) ||
    isAmazonUrl(product.affiliateUrl)
  );
}

export function productDestination(product: Product): string | undefined {
  if (isAmazonProduct(product)) {
    const affiliateUrl = product.affiliateUrl;
    if (
      !affiliateUrl ||
      !safeHttpUrlSchema.safeParse(affiliateUrl).success ||
      !isAmazonUrl(affiliateUrl)
    ) {
      return undefined;
    }
    return new URL(affiliateUrl).protocol === "https:" ? affiliateUrl : undefined;
  }

  return [product.affiliateUrl, product.productUrl].find(
    (value) => value && safeHttpUrlSchema.safeParse(value).success,
  );
}

export function recommendationDestination(
  recommendation: Pick<GuideRecommendation, "directAffiliateUrl">,
  product?: Product,
): string | undefined {
  return recommendation.directAffiliateUrl ?? (product ? productDestination(product) : undefined);
}
