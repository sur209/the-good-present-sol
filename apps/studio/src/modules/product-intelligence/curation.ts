import {
  productDestination,
  type Product,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import type { GuideDraft } from "../../drafts.ts";
import { suggestProductsForSlot } from "../../product-catalog.ts";
import type { EditorialBenchmark } from "./benchmarks.ts";
import type { ProductSourcingRequest } from "./sourcing.ts";

export type GuideCurationNextAction =
  | "use-catalog-product"
  | "review-candidate"
  | "prepare-search"
  | "run-discovery"
  | "generate-idea-copy"
  | "keep-as-idea"
  | "review-product-copy"
  | "add-affiliate-destination"
  | "fully-ready";

export interface GuideCurationProgress {
  ideaReadyProductUnresolved: number;
  candidateReview: number;
  productResolved: number;
  productCopyNeedsReview: number;
  affiliateDestinationMissing: number;
  fullyReady: number;
  publishedIdeaOnly: number;
}

export function guideSourcingRequestForSlot(
  requests: readonly ProductSourcingRequest[],
  draftId: string,
  slotId: string,
): ProductSourcingRequest | undefined {
  return [...requests]
    .filter(
      ({ origin, status }) =>
        status !== "rejected" &&
        origin.kind === "recommendation-slot" &&
        origin.guideDraftId === draftId &&
        origin.recommendationSlotId === slotId,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function selectGuideWideResolutionSlots(
  draft: GuideDraft,
  selectedSlotIds?: readonly string[],
  includeResolved = false,
): GuideDraft["recommendations"] {
  const selected = selectedSlotIds ? new Set(selectedSlotIds) : undefined;
  if (selected) {
    const known = new Set(draft.recommendations.map(({ id }) => id));
    const missing = [...selected].filter((id) => !known.has(id));
    if (missing.length) throw new TypeError(`Unknown GuideDraft slots: ${missing.join(", ")}.`);
  }
  const slots = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .filter((slot) => (!selected || selected.has(slot.id)) && (includeResolved || !slot.productId));
  if (!slots.length) {
    throw new TypeError(
      includeResolved
        ? "Select at least one GuideDraft slot."
        : "No unresolved Product slots were selected.",
    );
  }
  return slots;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function relevantEditorialBenchmarks(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
  request: ProductSourcingRequest | undefined,
  benchmarks: readonly EditorialBenchmark[],
): EditorialBenchmark[] {
  const productClass = normalized(request?.searchPlan?.productClass ?? slot.slotLabel);
  return benchmarks.filter(
    (benchmark) =>
      benchmark.status === "active" &&
      ((benchmark.context.guideId === draft.id &&
        (!benchmark.context.recommendationSlotId ||
          benchmark.context.recommendationSlotId === slot.id)) ||
        normalized(benchmark.productClass) === productClass),
  );
}

export function guideCurationNextAction(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
  content: ValidatedPublicContent,
  request?: ProductSourcingRequest,
): GuideCurationNextAction {
  if (slot.productId) {
    const product = content.products.find(({ id }) => id === slot.productId);
    if (slot.editorialStatus !== "ready") return "review-product-copy";
    if (!product || !productDestination(product)) return "add-affiliate-destination";
    return "fully-ready";
  }
  if (suggestProductsForSlot(content.products, slot, 1).length) return "use-catalog-product";
  if (request?.sourceCandidates.some(({ status }) => status === "needs-review")) {
    return "review-candidate";
  }
  if (!request?.searchPlan) return "prepare-search";
  if (!request.discoveryRounds.length) return "run-discovery";
  if (slot.editorialStatus !== "ready") return "generate-idea-copy";
  return "keep-as-idea";
}

export function guideCurationProgress(
  draft: GuideDraft,
  content: ValidatedPublicContent,
  requests: readonly ProductSourcingRequest[] = [],
): GuideCurationProgress {
  const products = new Map<string, Product>(
    content.products.map((product) => [product.id, product]),
  );
  const productSlots = draft.recommendations.filter(({ productId }) => productId);
  return {
    ideaReadyProductUnresolved: draft.recommendations.filter(
      ({ productId, editorialStatus }) => !productId && editorialStatus === "ready",
    ).length,
    candidateReview: draft.recommendations.filter((slot) =>
      requests.some(
        ({ origin, sourceCandidates }) =>
          origin.kind === "recommendation-slot" &&
          origin.guideDraftId === draft.id &&
          origin.recommendationSlotId === slot.id &&
          sourceCandidates.some(({ status }) => status === "needs-review"),
      ),
    ).length,
    productResolved: productSlots.length,
    productCopyNeedsReview: productSlots.filter(
      ({ editorialStatus }) => editorialStatus !== "ready",
    ).length,
    affiliateDestinationMissing: productSlots.filter(({ productId }) => {
      const product = products.get(productId!);
      return !product || !productDestination(product);
    }).length,
    fullyReady: productSlots.filter(({ productId, editorialStatus }) => {
      const product = products.get(productId!);
      return editorialStatus === "ready" && Boolean(product && productDestination(product));
    }).length,
    publishedIdeaOnly:
      content.guides
        .find(({ id }) => id === draft.id)
        ?.recommendations.filter(({ productId }) => !productId).length ?? 0,
  };
}
