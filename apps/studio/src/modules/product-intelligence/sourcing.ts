import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { Product, ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideDraft } from "../../drafts.ts";
import { selectRecommendationProduct } from "../../guide-editor.ts";
import { suggestProductsForSlot } from "../../product-catalog.ts";
import { REPOSITORY_ROOT, atomicWriteJson } from "../../repository.ts";
import type { ProductSourceRecord } from "../product-sources/records.ts";

export const PRODUCT_SOURCING_REQUESTS_DIRECTORY = "editorial-data/product-intelligence";
export const PRODUCT_SOURCING_REQUEST_STATUSES = [
  "open",
  "partially-fulfilled",
  "fulfilled",
  "completed-idea-only",
  "held",
  "rejected",
] as const;
export const PRODUCT_SOURCE_CANDIDATE_STATUSES = [
  "needs-review",
  "approved-for-intake",
  "rejected",
  "linked-to-product",
] as const;
export const PRODUCT_SOURCE_CANDIDATE_KINDS = [
  "manual",
  "amazon-creators-api",
  "serpapi",
  "dataforseo",
] as const;
export const PRODUCT_DISCOVERY_PROVIDERS = ["serpapi", "dataforseo"] as const;
export const PRODUCT_DISCOVERY_MODES = ["general", "amazon"] as const;

const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const requestId = safeId.regex(/^request_/, 'Must start with "request_".');
const sourceCandidateId = safeId.regex(
  /^source_candidate_/,
  'Must start with "source_candidate_".',
);
const timestamp = z.iso.datetime({ offset: true });

export const productRequirementOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("candidate"), candidateId: safeId }),
  z.strictObject({ kind: z.literal("brief"), briefId: safeId }),
  z.strictObject({ kind: z.literal("guide-draft"), guideDraftId: safeId }),
  z.strictObject({
    kind: z.literal("recommendation-slot"),
    guideDraftId: safeId,
    recommendationSlotId: safeId,
  }),
]);

export const productSourceCandidateSchema = z
  .strictObject({
    id: sourceCandidateId,
    sourceKind: z.enum(PRODUCT_SOURCE_CANDIDATE_KINDS),
    provider: nonEmptyText,
    discoveryMode: z.enum(PRODUCT_DISCOVERY_MODES).optional(),
    brand: nonEmptyText.optional(),
    merchant: nonEmptyText.optional(),
    domain: nonEmptyText.optional(),
    marketplace: nonEmptyText.optional(),
    externalId: nonEmptyText.optional(),
    sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
    productUrl: z.url({ protocol: /^https?$/ }).optional(),
    affiliateUrl: z.url({ protocol: /^https?$/ }).optional(),
    originalProductUrl: z.url({ protocol: /^https?$/ }).optional(),
    originalAffiliateUrl: z.url({ protocol: /^https?$/ }).optional(),
    trackingId: nonEmptyText.optional(),
    urlWarnings: textList.optional(),
    name: nonEmptyText,
    sourceFacts: textList,
    query: nonEmptyText.optional(),
    observedAt: timestamp.optional(),
    observedPrice: nonEmptyText.optional(),
    observedRating: z.number().nonnegative().optional(),
    observedReviewCount: z.number().int().nonnegative().optional(),
    observedImageUrl: z.url({ protocol: /^https?$/ }).optional(),
    providerResultPosition: z.number().int().positive().optional(),
    status: z.enum(PRODUCT_SOURCE_CANDIDATE_STATUSES),
    canonicalProductId: safeId.optional(),
    productSourceId: safeId.optional(),
    addedAt: timestamp,
    reviewedAt: timestamp.optional(),
  })
  .superRefine((candidate, context) => {
    const discovered = candidate.sourceKind === "serpapi" || candidate.sourceKind === "dataforseo";
    if (
      discovered &&
      candidate.status !== "linked-to-product" &&
      (!candidate.query || !candidate.observedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "A discovered candidate requires its query and observation timestamp.",
      });
    }
    const reviewed = candidate.status !== "needs-review";
    if (reviewed !== Boolean(candidate.reviewedAt)) {
      context.addIssue({
        code: "custom",
        path: ["reviewedAt"],
        message: reviewed
          ? "A reviewed candidate requires reviewedAt."
          : "Pending review has no reviewedAt.",
      });
    }
    const linked = candidate.status === "linked-to-product";
    if (
      linked !== Boolean(candidate.canonicalProductId) ||
      linked !== Boolean(candidate.productSourceId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonicalProductId"],
        message: linked
          ? "A linked candidate requires canonicalProductId and productSourceId."
          : "Only a linked candidate may reference a canonical product and source record.",
      });
    }
  });

export const productSearchPlanSchema = z.strictObject({
  productClass: nonEmptyText,
  mustHaveAttributes: textList.max(10),
  usefulAttributes: textList.max(10),
  exclusions: textList.max(10),
  queries: textList.min(1).max(3),
  providerId: nonEmptyText,
  modelId: nonEmptyText.optional(),
  promptVersion: nonEmptyText,
  plannedAt: timestamp,
});

export const productDiscoveryRoundSchema = z.strictObject({
  round: z.number().int().min(1).max(2),
  provider: z.enum(PRODUCT_DISCOVERY_PROVIDERS),
  discoveryMode: z.enum(PRODUCT_DISCOVERY_MODES).optional(),
  status: z.enum([
    "stored",
    "partial",
    "empty",
    "reused-catalog",
    "reused-candidates",
    "skipped-resolved",
    "failed",
  ]),
  queries: textList.min(1).max(3),
  providerCalls: z.number().int().nonnegative(),
  storedCandidateCount: z.number().int().nonnegative().max(4),
  returnedCandidateCount: z.number().int().nonnegative().optional(),
  reusedCandidateCount: z.number().int().nonnegative().optional(),
  attemptedAt: timestamp,
  failureCode: z.enum(["configuration", "quota", "timeout", "unavailable", "malformed"]).optional(),
});

export const productSourcingRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("product-sourcing-request"),
    id: requestId,
    origin: productRequirementOriginSchema,
    intendedRole: nonEmptyText,
    requiredCategory: nonEmptyText,
    audience: nonEmptyText,
    occasion: nonEmptyText,
    budgetContext: nonEmptyText,
    mustHaveVerifiedFacts: textList,
    exclusions: textList,
    searchTerms: textList.min(1),
    status: z.enum(PRODUCT_SOURCING_REQUEST_STATUSES),
    approvedProductIds: z.array(safeId),
    sourceCandidates: z.array(productSourceCandidateSchema),
    searchPlan: productSearchPlanSchema.optional(),
    discoveryRounds: z.array(productDiscoveryRoundSchema).max(2).default([]),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine((request, context) => {
    if (
      (request.status === "partially-fulfilled" || request.status === "fulfilled") &&
      request.approvedProductIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvedProductIds"],
        message: "A fulfilled request requires an explicitly selected canonical product.",
      });
    }
    if (new Set(request.approvedProductIds).size !== request.approvedProductIds.length) {
      context.addIssue({
        code: "custom",
        path: ["approvedProductIds"],
        message: "Canonical product selections must be unique within a request.",
      });
    }
    if (
      new Set(request.sourceCandidates.map(({ id }) => id)).size !== request.sourceCandidates.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceCandidates"],
        message: "Source candidate IDs must be unique within a request.",
      });
    }
  });

export type ProductRequirementOrigin = z.infer<typeof productRequirementOriginSchema>;
export type ProductSourceCandidate = z.infer<typeof productSourceCandidateSchema>;
export type ProductSourcingRequest = z.infer<typeof productSourcingRequestSchema>;
export type ProductSourcingRequestStatus = ProductSourcingRequest["status"];
export type ProductSearchPlan = z.infer<typeof productSearchPlanSchema>;
export type ProductDiscoveryRound = z.infer<typeof productDiscoveryRoundSchema>;
export type ProductDiscoveryMode = (typeof PRODUCT_DISCOVERY_MODES)[number];

export interface ProductSourcingRequestInput {
  origin: ProductRequirementOrigin;
  intendedRole: string;
  requiredCategory: string;
  audience: string;
  occasion: string;
  budgetContext: string;
  mustHaveVerifiedFacts?: string[];
  exclusions?: string[];
  searchTerms: string[];
}

export interface ProductSourceCandidateInput {
  id?: string;
  sourceKind: ProductSourceCandidate["sourceKind"];
  provider: string;
  discoveryMode?: ProductSourceCandidate["discoveryMode"];
  brand?: string;
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
  name: string;
  sourceFacts?: string[];
  query?: string;
  observedAt?: string;
  observedPrice?: string;
  observedRating?: number;
  observedReviewCount?: number;
  observedImageUrl?: string;
  providerResultPosition?: number;
}

export interface ProductSourcingOriginContext {
  candidates?: readonly { id: string }[];
  briefs?: readonly { id: string }[];
  drafts?: readonly GuideDraft[];
}

export interface ProductSourcingBriefContext {
  targetAudience: string;
  risks: readonly string[];
}

export interface ProductSourcingRequestPrefill {
  intendedRole: string;
  requiredCategory: string;
  audience: string | undefined;
  occasion: string | undefined;
  budgetContext: string | undefined;
  mustHaveVerifiedFacts: string[];
  exclusions: string[];
  searchTerms: string[];
}

function firstKnownValue(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value?.trim());
}

export function productSourcingPrefillForDraftSlot(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
  brief?: ProductSourcingBriefContext,
): ProductSourcingRequestPrefill {
  if (!draft.recommendations.some(({ id }) => id === slot.id)) {
    throw new TypeError(`The recommendation slot "${slot.id}" does not belong to this GuideDraft.`);
  }
  return {
    intendedRole: slot.slotIntent ?? slot.slotLabel,
    requiredCategory: slot.slotLabel,
    audience: firstKnownValue(
      draft.questionnaire.recipient,
      brief?.targetAudience,
      draft.taxonomies?.recipients?.join(", "),
    ),
    occasion: firstKnownValue(
      draft.questionnaire.occasion,
      draft.taxonomies?.occasions?.join(", "),
      draft.primaryIntent,
    ),
    budgetContext: firstKnownValue(
      slot.budgetHint,
      draft.questionnaire.budget,
      draft.budgetContext?.label,
    ),
    mustHaveVerifiedFacts: [],
    exclusions: draft.questionnaire.avoid ? [draft.questionnaire.avoid] : [...(brief?.risks ?? [])],
    searchTerms: slot.searchTerms?.length ? [...slot.searchTerms] : [slot.slotLabel],
  };
}

const unspecifiedSourcingContext = "Not specified";

export function productSourcingRequestInputForDraftSlot(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
  brief?: ProductSourcingBriefContext,
): ProductSourcingRequestInput {
  const prefill = productSourcingPrefillForDraftSlot(draft, slot, brief);
  return {
    origin: {
      kind: "recommendation-slot",
      guideDraftId: draft.id,
      recommendationSlotId: slot.id,
    },
    intendedRole: prefill.intendedRole,
    requiredCategory: prefill.requiredCategory,
    audience: prefill.audience ?? unspecifiedSourcingContext,
    occasion: prefill.occasion ?? unspecifiedSourcingContext,
    budgetContext: prefill.budgetContext ?? unspecifiedSourcingContext,
    mustHaveVerifiedFacts: prefill.mustHaveVerifiedFacts,
    exclusions: prefill.exclusions,
    searchTerms: prefill.searchTerms,
  };
}

export function findProductSourcingRequestForDraftSlot(
  requests: readonly ProductSourcingRequest[],
  guideDraftId: string,
  recommendationSlotId: string,
): ProductSourcingRequest | undefined {
  return [...requests]
    .filter(
      (request) =>
        request.status !== "rejected" &&
        request.origin.kind === "recommendation-slot" &&
        request.origin.guideDraftId === guideDraftId &&
        request.origin.recommendationSlotId === recommendationSlotId,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function createProductSourcingRequestForDraftSlot(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
  brief?: ProductSourcingBriefContext,
  now = new Date(),
  id = `request_${randomUUID()}`,
): ProductSourcingRequest {
  return createProductSourcingRequest(
    productSourcingRequestInputForDraftSlot(draft, slot, brief),
    now,
    id,
  );
}

export function createProductSourcingRequest(
  input: ProductSourcingRequestInput,
  now = new Date(),
  id = `request_${randomUUID()}`,
): ProductSourcingRequest {
  const timestampValue = now.toISOString();
  return productSourcingRequestSchema.parse({
    schemaVersion: 1,
    recordType: "product-sourcing-request",
    id,
    ...input,
    mustHaveVerifiedFacts: input.mustHaveVerifiedFacts ?? [],
    exclusions: input.exclusions ?? [],
    status: "open",
    approvedProductIds: [],
    sourceCandidates: [],
    discoveryRounds: [],
    createdAt: timestampValue,
    updatedAt: timestampValue,
  });
}

export function assertProductSourcingOrigin(
  origin: ProductRequirementOrigin,
  context: ProductSourcingOriginContext,
): void {
  if (origin.kind === "candidate") {
    if (!context.candidates?.some(({ id }) => id === origin.candidateId)) {
      throw new TypeError(`The originating candidate "${origin.candidateId}" does not exist.`);
    }
    return;
  }
  if (origin.kind === "brief") {
    if (!context.briefs?.some(({ id }) => id === origin.briefId)) {
      throw new TypeError(`The originating brief "${origin.briefId}" does not exist.`);
    }
    return;
  }
  const draft = context.drafts?.find(({ id }) => id === origin.guideDraftId);
  if (!draft) {
    throw new TypeError(`The originating GuideDraft "${origin.guideDraftId}" does not exist.`);
  }
  if (
    origin.kind === "recommendation-slot" &&
    !draft.recommendations.some(({ id }) => id === origin.recommendationSlotId)
  ) {
    throw new TypeError(
      `The originating recommendation slot "${origin.recommendationSlotId}" does not exist.`,
    );
  }
}

const requestTransitions: Record<ProductSourcingRequestStatus, ProductSourcingRequestStatus[]> = {
  open: ["completed-idea-only", "held", "rejected"],
  "partially-fulfilled": ["completed-idea-only", "held", "fulfilled", "rejected"],
  fulfilled: [],
  "completed-idea-only": [],
  held: ["open", "rejected"],
  rejected: [],
};

export function transitionProductSourcingRequest(
  request: ProductSourcingRequest,
  status: ProductSourcingRequestStatus,
  now = new Date(),
): ProductSourcingRequest {
  if (!requestTransitions[request.status].includes(status)) {
    throw new TypeError(`Invalid sourcing transition: ${request.status} -> ${status}.`);
  }
  return productSourcingRequestSchema.parse({
    ...request,
    status,
    updatedAt: now.toISOString(),
  });
}

export function completeProductSourcingRequestAsIdeaOnly(
  request: ProductSourcingRequest,
  now = new Date(),
): ProductSourcingRequest {
  return transitionProductSourcingRequest(request, "completed-idea-only", now);
}

export function productSourcingRequestIsActive(request: ProductSourcingRequest): boolean {
  return request.status === "open" || request.status === "partially-fulfilled";
}

export function selectCanonicalProductForRequest(
  request: ProductSourcingRequest,
  productId: string,
  products: readonly Product[],
  status: "partially-fulfilled" | "fulfilled",
  now = new Date(),
): ProductSourcingRequest {
  if (request.status !== "open" && request.status !== "partially-fulfilled") {
    throw new TypeError("Only an open or partially fulfilled request can select a product.");
  }
  const product = products.find(({ id }) => id === productId);
  if (!product || product.status !== "active") {
    throw new TypeError("Only an active canonical Product may satisfy a sourcing request.");
  }
  const verifiedFacts = new Set(
    (product.verifiedFacts ?? []).map((fact) => fact.trim().toLocaleLowerCase("en-US")),
  );
  const missingFacts = request.mustHaveVerifiedFacts.filter(
    (fact) => !verifiedFacts.has(fact.trim().toLocaleLowerCase("en-US")),
  );
  if (missingFacts.length) {
    throw new TypeError(
      `The canonical Product is missing required verified facts: ${missingFacts.join(", ")}.`,
    );
  }
  return productSourcingRequestSchema.parse({
    ...request,
    status,
    approvedProductIds: [...new Set([...request.approvedProductIds, product.id])],
    updatedAt: now.toISOString(),
  });
}

export function addProductSourceCandidates(
  request: ProductSourcingRequest,
  inputs: readonly ProductSourceCandidateInput[],
  now = new Date(),
): ProductSourcingRequest {
  if (request.status !== "open" && request.status !== "partially-fulfilled") {
    throw new TypeError("Source candidates can be added only to an active request.");
  }
  if (!inputs.length) throw new TypeError("Add at least one source candidate.");
  const addedAt = now.toISOString();
  const keys = new Set(request.sourceCandidates.map(productSourceCandidateKey));
  const additions = inputs.filter((input) => {
    const key = productSourceCandidateKey(input);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (!additions.length) return request;
  return productSourcingRequestSchema.parse({
    ...request,
    sourceCandidates: [
      ...request.sourceCandidates,
      ...additions.map((input) => ({
        ...input,
        id: input.id ?? `source_candidate_${randomUUID()}`,
        sourceFacts: input.sourceFacts ?? [],
        status: "needs-review",
        addedAt,
      })),
    ],
    updatedAt: addedAt,
  });
}

function productSourceCandidateKey(
  candidate: ProductSourceCandidateInput | ProductSourceCandidate,
): string {
  const provider = candidate.provider.trim().toLocaleLowerCase("en-US");
  if (candidate.externalId) {
    return [provider, candidate.marketplace ?? "", candidate.externalId]
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .join("\u0000");
  }
  const rawUrl = candidate.productUrl ?? candidate.sourceUrl;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.hash = "";
      url.searchParams.sort();
      return `${provider}\u0000${url.toString()}`;
    } catch {
      return `${provider}\u0000${rawUrl.trim().toLocaleLowerCase("en-US")}`;
    }
  }
  return `${provider}\u0000${candidate.name.trim().toLocaleLowerCase("en-US")}`;
}

export function reviewProductSourceCandidates(
  request: ProductSourcingRequest,
  decisions: readonly {
    candidateId: string;
    decision: "approved-for-intake" | "rejected";
  }[],
  now = new Date(),
): ProductSourcingRequest {
  if (request.status !== "open" && request.status !== "partially-fulfilled") {
    throw new TypeError("Source candidates can be reviewed only on an active request.");
  }
  if (!decisions.length) throw new TypeError("Review at least one source candidate.");
  const reviewedAt = now.toISOString();
  const byId = new Map(decisions.map((decision) => [decision.candidateId, decision.decision]));
  for (const candidateId of byId.keys()) {
    const candidate = request.sourceCandidates.find(({ id }) => id === candidateId);
    if (!candidate) throw new TypeError(`Source candidate "${candidateId}" does not exist.`);
    if (candidate.status !== "needs-review") {
      throw new TypeError(`Source candidate "${candidateId}" has already been reviewed.`);
    }
  }
  return productSourcingRequestSchema.parse({
    ...request,
    sourceCandidates: request.sourceCandidates.map((candidate) => {
      const status = byId.get(candidate.id);
      return status ? { ...candidate, status, reviewedAt } : candidate;
    }),
    updatedAt: reviewedAt,
  });
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return (
    (left ?? "").trim().toLocaleLowerCase("en-US") ===
    (right ?? "").trim().toLocaleLowerCase("en-US")
  );
}

export function linkProductSourceCandidate(
  request: ProductSourcingRequest,
  candidateId: string,
  productId: string,
  productSourceId: string,
  products: readonly Product[],
  sources: readonly ProductSourceRecord[],
  now = new Date(),
): ProductSourcingRequest {
  if (request.status !== "open" && request.status !== "partially-fulfilled") {
    throw new TypeError("Source intake can be linked only on an active request.");
  }
  const index = request.sourceCandidates.findIndex(({ id }) => id === candidateId);
  const candidate = request.sourceCandidates[index];
  if (!candidate || candidate.status !== "approved-for-intake") {
    throw new TypeError("Review and approve the source candidate before linking intake.");
  }
  const product = products.find(({ id }) => id === productId);
  if (!product || product.status !== "active") {
    throw new TypeError("The linked intake must be an active canonical Product.");
  }
  const source = sources.find(({ id }) => id === productSourceId);
  if (!source || source.productId !== product.id) {
    throw new TypeError("The source record must belong to the linked canonical Product.");
  }
  if (
    !sameText(candidate.provider, source.provider) ||
    (candidate.externalId && !sameText(candidate.externalId, source.externalId)) ||
    (candidate.marketplace && !sameText(candidate.marketplace, source.marketplace))
  ) {
    throw new TypeError("The reviewed candidate and source record identity do not match.");
  }
  const sourceCandidates = [...request.sourceCandidates];
  sourceCandidates[index] = {
    ...candidate,
    status: "linked-to-product",
    canonicalProductId: product.id,
    productSourceId: source.id,
  };
  return productSourcingRequestSchema.parse({
    ...request,
    sourceCandidates,
    updatedAt: now.toISOString(),
  });
}

export function catalogMatchesForRequest(
  request: ProductSourcingRequest,
  products: Product[],
  limit = 10,
): Product[] {
  return suggestProductsForSlot(
    products,
    {
      slotLabel: request.requiredCategory,
      slotIntent: request.intendedRole,
      searchTerms: [...request.searchTerms, request.audience, request.occasion],
    },
    limit,
  );
}

export function productSourcingReturnPath(request: ProductSourcingRequest): string {
  const { origin } = request;
  if (origin.kind === "candidate")
    return `/opportunities/${encodeURIComponent(origin.candidateId)}`;
  if (origin.kind === "brief") return `/opportunities/briefs/${encodeURIComponent(origin.briefId)}`;
  if (origin.kind === "guide-draft") return `/drafts/${encodeURIComponent(origin.guideDraftId)}`;
  return `/drafts/${encodeURIComponent(origin.guideDraftId)}#slot-${encodeURIComponent(origin.recommendationSlotId)}`;
}

export function assignSourcedProductToDraftSlot(
  request: ProductSourcingRequest,
  productId: string,
  draft: GuideDraft,
  content: ValidatedPublicContent,
  allowDuplicate = false,
): GuideDraft {
  if (request.origin.kind !== "recommendation-slot" || request.origin.guideDraftId !== draft.id) {
    throw new TypeError("The sourcing request does not originate from this GuideDraft slot.");
  }
  if (
    (request.status !== "partially-fulfilled" && request.status !== "fulfilled") ||
    !request.approvedProductIds.includes(productId)
  ) {
    throw new TypeError("Select the canonical Product on the sourcing request before assignment.");
  }
  return selectRecommendationProduct(
    draft,
    request.origin.recommendationSlotId,
    productId,
    content,
    allowDuplicate,
  );
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function productSourcingRequestPath(repositoryRoot: string, id: string): string {
  const parsed = requestId.safeParse(id);
  if (!parsed.success) throw new TypeError("The sourcing request ID is not safe.");
  return resolve(repositoryRoot, PRODUCT_SOURCING_REQUESTS_DIRECTORY, `${parsed.data}.json`);
}

export function readProductSourcingRequests(
  repositoryRoot = REPOSITORY_ROOT,
): ProductSourcingRequest[] {
  const directory = resolve(repositoryRoot, PRODUCT_SOURCING_REQUESTS_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("request_") && entry.name.endsWith(".json"),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const file = relative(repositoryRoot, resolve(directory, entry.name)).replaceAll("\\", "/");
      const id = entry.name.slice(0, -5);
      try {
        const parsed = productSourcingRequestSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) throw new TypeError(validationMessage(parsed.error));
        if (parsed.data.id !== id) throw new TypeError(`id must match filename stem "${id}".`);
        return parsed.data;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Invalid product sourcing request "${file}": ${reason}`, {
          cause: error,
        });
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export class ProductSourcingRequestStore {
  private readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(): ProductSourcingRequest[] {
    return readProductSourcingRequests(this.repositoryRoot);
  }

  get(id: string): ProductSourcingRequest {
    const request = this.list().find((item) => item.id === id);
    if (!request) throw new TypeError(`Product sourcing request "${id}" does not exist.`);
    return request;
  }

  async save(input: ProductSourcingRequest): Promise<ProductSourcingRequest> {
    const request = productSourcingRequestSchema.parse(input);
    await atomicWriteJson(productSourcingRequestPath(this.repositoryRoot, request.id), request);
    return request;
  }
}
