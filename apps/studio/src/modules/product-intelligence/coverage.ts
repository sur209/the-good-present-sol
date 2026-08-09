import {
  guidePath,
  type GiftGuide,
  type Product,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import type { GuideDraft } from "../../drafts.ts";
import { productSlotMatchScore } from "../../product-catalog.ts";
import type { ProductGapReport } from "./gaps.ts";

export interface ProductCoverageThresholds {
  reusedGuideCount: number;
  substantialCategoryProductCount: number;
  minimumClusterCategoryCount: number;
  broadMetadataValueCount: number;
  minimumSlotMatchTokenCount: number;
}

export const DEFAULT_PRODUCT_COVERAGE_THRESHOLDS: ProductCoverageThresholds = {
  reusedGuideCount: 3,
  substantialCategoryProductCount: 3,
  minimumClusterCategoryCount: 3,
  broadMetadataValueCount: 3,
  minimumSlotMatchTokenCount: 2,
};

export interface ProductEvidence {
  productId: string;
  name: string;
  status: Product["status"];
  categories: string[];
  recipients: string[];
  occasions: string[];
}

export interface GuideEvidence {
  guideId: string;
  title: string;
  clusterId: string;
  route?: string;
}

function normalized(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLocaleLowerCase("en-US")))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function productEvidence(product: Product): ProductEvidence {
  return {
    productId: product.id,
    name: product.name,
    status: product.status,
    categories: normalized(product.categories),
    recipients: normalized(product.recipients),
    occasions: normalized(product.occasions),
  };
}

function guideEvidence(
  guide: GiftGuide,
  clustersById: Map<string, ValidatedPublicContent["clusters"][number]>,
): GuideEvidence {
  const cluster = clustersById.get(guide.clusterId);
  return {
    guideId: guide.id,
    title: guide.title,
    clusterId: guide.clusterId,
    ...(cluster ? { route: guidePath(cluster.slug, guide.slug) } : {}),
  };
}

function thresholds(overrides: Partial<ProductCoverageThresholds>): ProductCoverageThresholds {
  const result = { ...DEFAULT_PRODUCT_COVERAGE_THRESHOLDS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Coverage threshold "${name}" must be a positive integer.`);
    }
  }
  return result;
}

export function analyzeProductCoverage(
  content: ValidatedPublicContent,
  drafts: GuideDraft[] = [],
  briefReports: ProductGapReport[] = [],
  thresholdOverrides: Partial<ProductCoverageThresholds> = {},
) {
  const configuredThresholds = thresholds(thresholdOverrides);
  const products = [...content.products].sort((left, right) => left.id.localeCompare(right.id));
  const activeProducts = products.filter((product) => product.status === "active");
  const productsById = new Map(products.map((product) => [product.id, product]));
  const clustersById = new Map(content.clusters.map((cluster) => [cluster.id, cluster]));
  const guides = [...content.guides].sort((left, right) => left.id.localeCompare(right.id));
  const guideRefs = new Map(guides.map((guide) => [guide.id, guideEvidence(guide, clustersById)]));
  const guideIdsByProduct = new Map<string, Set<string>>();
  for (const guide of guides) {
    for (const productId of new Set(guide.recommendations.map(({ productId }) => productId))) {
      const guideIds = guideIdsByProduct.get(productId) ?? new Set<string>();
      guideIds.add(guide.id);
      guideIdsByProduct.set(productId, guideIds);
    }
  }

  const categoryProducts = new Map<string, Product[]>();
  for (const product of activeProducts) {
    for (const category of normalized(product.categories)) {
      const members = categoryProducts.get(category) ?? [];
      members.push(product);
      categoryProducts.set(category, members);
    }
  }
  const categoryCoverage = [...categoryProducts]
    .map(([category, members]) => ({
      category,
      products: members.map(productEvidence),
    }))
    .sort((left, right) => left.category.localeCompare(right.category, "en-US"));

  const clustersWithLowCategoryDiversity = [...content.clusters]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((cluster) => {
      const clusterGuides = guides.filter((guide) => guide.clusterId === cluster.id);
      const productIds = new Set(
        clusterGuides.flatMap((guide) => guide.recommendations.map(({ productId }) => productId)),
      );
      const contributingProducts = [...productIds]
        .map((id) => productsById.get(id))
        .filter((product): product is Product => product?.status === "active")
        .sort((left, right) => left.id.localeCompare(right.id));
      return {
        clusterId: cluster.id,
        title: cluster.title,
        categories: normalized(contributingProducts.flatMap((product) => product.categories ?? [])),
        products: contributingProducts.map(productEvidence),
        guides: clusterGuides.map((guide) => guideRefs.get(guide.id)!),
      };
    })
    .filter(
      ({ categories }) => categories.length < configuredThresholds.minimumClusterCategoryCount,
    );

  return {
    thresholds: configuredThresholds,
    catalogHealth: {
      activeProductsUnused: activeProducts
        .filter((product) => !guideIdsByProduct.get(product.id)?.size)
        .map(productEvidence),
      inactiveProducts: products
        .filter((product) => product.status === "inactive")
        .map((product) => ({
          product: productEvidence(product),
          guides: [...(guideIdsByProduct.get(product.id) ?? [])].map((id) => guideRefs.get(id)!),
        })),
      productsReusedAcrossGuides: activeProducts
        .map((product) => ({
          product: productEvidence(product),
          guides: [...(guideIdsByProduct.get(product.id) ?? [])]
            .sort()
            .map((id) => guideRefs.get(id)!),
        }))
        .filter(
          ({ guides: productGuides }) =>
            productGuides.length >= configuredThresholds.reusedGuideCount,
        ),
      substantialCategories: categoryCoverage.filter(
        ({ products: categoryMembers }) =>
          categoryMembers.length >= configuredThresholds.substantialCategoryProductCount,
      ),
      singleProductCategories: categoryCoverage.filter(
        ({ products: categoryMembers }) => categoryMembers.length === 1,
      ),
      clustersWithLowCategoryDiversity,
      productsWithBroadMetadata: activeProducts
        .map(productEvidence)
        .filter(
          (product) =>
            product.recipients.length >= configuredThresholds.broadMetadataValueCount ||
            product.occasions.length >= configuredThresholds.broadMetadataValueCount,
        ),
    },
    editorialCoverage: {
      draftSlotsWithoutSuitableProducts: [...drafts]
        .sort((left, right) => left.id.localeCompare(right.id))
        .flatMap((draft) =>
          draft.recommendations
            .filter(
              (slot) =>
                !slot.productId &&
                !activeProducts.some(
                  (product) =>
                    productSlotMatchScore(product, {
                      slotLabel: slot.slotLabel,
                      slotIntent: slot.slotIntent,
                      searchTerms: slot.searchTerms,
                    }) >= configuredThresholds.minimumSlotMatchTokenCount,
                ),
            )
            .map((slot) => ({
              guideId: draft.id,
              guideTitle: draft.title,
              slotId: slot.id,
              slotLabel: slot.slotLabel,
              searchTerms: slot.searchTerms ?? [],
            })),
        ),
      briefRequirementsWithoutCatalogCoverage: [...briefReports]
        .sort((left, right) => left.id.localeCompare(right.id))
        .flatMap((report) =>
          report.slots
            .filter((slot) => slot.status === "unassigned")
            .map((slot) => ({
              reportId: report.id,
              guideId: report.guideId,
              clusterId: report.clusterId,
              slotId: slot.id,
              requirement: slot.category,
              reason: slot.reason,
            })),
        ),
    },
  };
}

export type ProductCoverageAnalysis = ReturnType<typeof analyzeProductCoverage>;
