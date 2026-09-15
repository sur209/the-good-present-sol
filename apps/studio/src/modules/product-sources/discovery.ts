import type { Product } from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import type { GuideDraft } from "../../drafts.ts";
import { productSlotMatchScore } from "../../product-catalog.ts";
import type { EditorialBrief } from "../content-opportunity-lab/review.ts";
import {
  extractAmazonAsin,
  isApprovedAmazonUsHost,
  normalizeAmazonAsin,
  normalizeAmazonUrl,
} from "../affiliate-operations/amazon.ts";
import { isGoogleShoppingIntermediaryUrl } from "./records.ts";
import {
  PRODUCT_DISCOVERY_PROVIDERS,
  addProductSourceCandidates,
  productSourcingRequestSchema,
  type ProductSourceCandidate,
  type ProductSourceCandidateInput,
  type ProductDiscoveryMode,
  type ProductSourcingRequest,
} from "../product-intelligence/sourcing.ts";

export const PRODUCT_SEARCH_PLAN_PROMPT_VERSION = "product-search-plan-v1";
export const DEFAULT_PRODUCT_DISCOVERY_LIMITS = {
  maxQueriesPerSlot: 3,
  maxStoredCandidatesPerSlot: 4,
  maxRounds: 2,
  maxConcurrency: 2,
  maxProviderCallsPerRun: 3,
  reuseWindowMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const requestId = safeId.regex(/^request_/);
const timestamp = z.iso.datetime({ offset: true });
const optionalText = z.string().trim().min(1).optional();
const textList = z.array(nonEmptyText);

export const productSearchPlanningPromptInputSchema = z.strictObject({
  slots: z
    .array(
      z.strictObject({
        requestId,
        editorialProblem: nonEmptyText,
        useCase: nonEmptyText,
        intendedRole: nonEmptyText,
        requiredCategory: nonEmptyText,
        audience: nonEmptyText,
        occasion: nonEmptyText,
        budgetContext: nonEmptyText,
        mustHaveVerifiedFacts: textList,
        exclusions: textList,
        existingSearchTerms: textList.min(1),
        guide: z
          .strictObject({
            id: safeId,
            title: optionalText,
            primaryAxis: optionalText,
            primaryIntent: optionalText,
            taxonomies: textList,
            budgetContext: optionalText,
            questionnaire: z.strictObject({
              recipient: optionalText,
              ageRange: optionalText,
              occasion: optionalText,
              budget: optionalText,
              interests: optionalText,
              avoid: optionalText,
              tone: optionalText,
              additional: optionalText,
            }),
          })
          .optional(),
        recommendationSlot: z
          .strictObject({
            id: safeId,
            label: nonEmptyText,
            intent: optionalText,
            searchTerms: textList,
            budgetHint: optionalText,
          })
          .optional(),
        brief: z
          .strictObject({
            id: safeId,
            problemSolved: nonEmptyText,
            targetAudience: nonEmptyText,
            productRequirements: textList,
            risks: textList,
          })
          .optional(),
      }),
    )
    .min(1)
    .max(20),
});

export type ProductSearchPlanningPromptInput = z.infer<
  typeof productSearchPlanningPromptInputSchema
>;

export const plannedProductSearchSchema = z.strictObject({
  requestId,
  productClass: nonEmptyText,
  mustHaveAttributes: textList.max(10),
  usefulAttributes: textList.max(10),
  exclusions: textList.max(10),
  queries: textList.min(1).max(DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxQueriesPerSlot),
});

export const plannedProductSearchBatchSchema = z.strictObject({
  plans: z.array(plannedProductSearchSchema).min(1).max(20),
});

export type PlannedProductSearchBatch = z.infer<typeof plannedProductSearchBatchSchema>;

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap((value) => (value?.trim() ? [value.trim()] : [])))];
}

function draftForRequest(
  request: ProductSourcingRequest,
  drafts: readonly GuideDraft[],
): GuideDraft | undefined {
  const origin = request.origin;
  return origin.kind === "guide-draft" || origin.kind === "recommendation-slot"
    ? drafts.find(({ id }) => id === origin.guideDraftId)
    : undefined;
}

function briefForRequest(
  request: ProductSourcingRequest,
  draft: GuideDraft | undefined,
  briefs: readonly EditorialBrief[],
): EditorialBrief | undefined {
  const origin = request.origin;
  if (origin.kind === "brief") {
    return briefs.find(({ id }) => id === origin.briefId);
  }
  return draft ? briefs.find(({ guideDraftId }) => guideDraftId === draft.id) : undefined;
}

export function prepareProductSearchPlanningPrompt(
  requests: readonly ProductSourcingRequest[],
  drafts: readonly GuideDraft[] = [],
  briefs: readonly EditorialBrief[] = [],
) {
  const input = productSearchPlanningPromptInputSchema.parse({
    slots: requests.map((request) => {
      if (request.status !== "open" && request.status !== "partially-fulfilled") {
        throw new TypeError(`Product sourcing request "${request.id}" is not active.`);
      }
      const draft = draftForRequest(request, drafts);
      const origin = request.origin;
      const slot =
        origin.kind === "recommendation-slot"
          ? draft?.recommendations.find(({ id }) => id === origin.recommendationSlotId)
          : undefined;
      const brief = briefForRequest(request, draft, briefs);
      return {
        requestId: request.id,
        editorialProblem: brief?.problemSolved ?? draft?.primaryIntent ?? request.intendedRole,
        useCase: slot?.slotIntent ?? request.intendedRole,
        intendedRole: request.intendedRole,
        requiredCategory: request.requiredCategory,
        audience: request.audience,
        occasion: request.occasion,
        budgetContext: request.budgetContext,
        mustHaveVerifiedFacts: request.mustHaveVerifiedFacts,
        exclusions: request.exclusions,
        existingSearchTerms: request.searchTerms,
        ...(draft
          ? {
              guide: {
                id: draft.id,
                title: draft.title,
                primaryAxis: draft.primaryAxis,
                primaryIntent: draft.primaryIntent,
                taxonomies: unique(
                  Object.values(draft.taxonomies ?? {}).flatMap((values) => values ?? []),
                ),
                budgetContext: draft.budgetContext
                  ? `${draft.budgetContext.label}${draft.budgetContext.minimum !== undefined ? `; minimum ${draft.budgetContext.minimum} USD` : ""}${draft.budgetContext.maximum !== undefined ? `; maximum ${draft.budgetContext.maximum} USD` : ""}`
                  : undefined,
                questionnaire: {
                  recipient: draft.questionnaire.recipient,
                  ageRange: draft.questionnaire.ageRange,
                  occasion: draft.questionnaire.occasion,
                  budget: draft.questionnaire.budget,
                  interests: draft.questionnaire.interests,
                  avoid: draft.questionnaire.avoid,
                  tone: draft.questionnaire.tone,
                  additional: draft.questionnaire.additional,
                },
              },
            }
          : {}),
        ...(slot
          ? {
              recommendationSlot: {
                id: slot.id,
                label: slot.slotLabel,
                intent: slot.slotIntent,
                searchTerms: slot.searchTerms ?? [],
                budgetHint: slot.budgetHint,
              },
            }
          : {}),
        ...(brief
          ? {
              brief: {
                id: brief.id,
                problemSolved: brief.problemSolved,
                targetAudience: brief.targetAudience,
                productRequirements: brief.productRequirements,
                risks: brief.risks,
              },
            }
          : {}),
      };
    }),
  });

  const prompt = `Plan compact product discovery queries for the selected editorial sourcing slots.

For every slot, reason in this order: editorial problem -> use case -> Product class -> concrete query. Do not merely search the slot title. Use all known GuideDraft, recommendation-slot, I.2 sourcing request, questionnaire/brief, budget, and taxonomy context already supplied; never ask the editor to re-enter it. Preserve explicit must-have requirements and exclusions. Treat useful attributes as aids, not verified facts. Return 1-3 concise queries per slot.

Return exactly one JSON object with this shape and no additional fields:
{"plans":[{"requestId":"request_...","productClass":"...","mustHaveAttributes":["..."],"usefulAttributes":["..."],"exclusions":["..."],"queries":["..."]}]}

Planning input:
${JSON.stringify(input, null, 2)}`;
  return { version: PRODUCT_SEARCH_PLAN_PROMPT_VERSION, input, prompt };
}

export function mockProductSearchPlanning(
  input: ProductSearchPlanningPromptInput,
): PlannedProductSearchBatch {
  return plannedProductSearchBatchSchema.parse({
    plans: input.slots.map((slot) => ({
      requestId: slot.requestId,
      productClass: slot.requiredCategory,
      mustHaveAttributes: slot.mustHaveVerifiedFacts,
      usefulAttributes: unique([
        ...slot.existingSearchTerms,
        slot.recommendationSlot?.intent,
        slot.guide?.questionnaire.interests,
      ]).slice(0, 10),
      exclusions: slot.exclusions,
      queries: unique(
        slot.existingSearchTerms.map((term) =>
          [slot.editorialProblem, slot.useCase, slot.requiredCategory, term].join(" "),
        ),
      ).slice(0, DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxQueriesPerSlot),
    })),
  });
}

export async function generateProductSearchPlans(
  requests: readonly ProductSourcingRequest[],
  provider: GuideGenerationProvider,
  drafts: readonly GuideDraft[] = [],
  briefs: readonly EditorialBrief[] = [],
  now = new Date(),
): Promise<ProductSourcingRequest[]> {
  const prepared = prepareProductSearchPlanningPrompt(requests, drafts, briefs);
  const generated = await provider.generateStructured({
    operation: "product-search-plans",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: plannedProductSearchBatchSchema,
    mockResponse: () => mockProductSearchPlanning(prepared.input),
  });
  const expectedIds = requests.map(({ id }) => id).sort();
  const actualIds = generated.plans.map(({ requestId: id }) => id).sort();
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index])
  ) {
    throw new TypeError("The search-plan batch must return every selected request exactly once.");
  }
  const plans = new Map(generated.plans.map((plan) => [plan.requestId, plan]));
  return requests.map((request) => {
    const plan = plans.get(request.id)!;
    return productSourcingRequestSchema.parse({
      ...request,
      searchPlan: {
        productClass: plan.productClass,
        mustHaveAttributes: plan.mustHaveAttributes,
        usefulAttributes: plan.usefulAttributes,
        exclusions: plan.exclusions,
        queries: plan.queries,
        providerId: provider.providerId,
        ...(provider.modelId ? { modelId: provider.modelId } : {}),
        promptVersion: prepared.version,
        plannedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    });
  });
}

export interface ProductSearchPlanEdits {
  productClass: string;
  mustHaveAttributes: string[];
  usefulAttributes: string[];
  exclusions: string[];
  queries: string[];
}

export function updateProductSearchPlan(
  request: ProductSourcingRequest,
  edits: ProductSearchPlanEdits,
  now = new Date(),
): ProductSourcingRequest {
  if (!request.searchPlan) throw new TypeError("Generate a SearchPlan before editing it.");
  if (request.status !== "open" && request.status !== "partially-fulfilled") {
    throw new TypeError("Only an active sourcing request can edit its SearchPlan.");
  }
  return productSourcingRequestSchema.parse({
    ...request,
    searchPlan: { ...request.searchPlan, ...edits },
    updatedAt: now.toISOString(),
  });
}

export type ProductDiscoveryFailureCode =
  "configuration" | "quota" | "timeout" | "unavailable" | "malformed";

export class ProductDiscoveryError extends Error {
  readonly code: ProductDiscoveryFailureCode;
  readonly status?: number;

  constructor(
    message: string,
    code: ProductDiscoveryFailureCode,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProductDiscoveryError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface ProductDiscoveryQuery {
  query: string;
  candidateLimit: number;
  observedAt: string;
  discoveryMode?: ProductDiscoveryMode;
}

export interface ProductDiscoverySource {
  readonly providerId: (typeof PRODUCT_DISCOVERY_PROVIDERS)[number];
  readonly paidUsage: true;
  readonly supportedModes?: readonly ProductDiscoveryMode[];
  search(input: ProductDiscoveryQuery): Promise<ProductSourceCandidateInput[]>;
}

export function productDiscoverySourceSupportsMode(
  source: ProductDiscoverySource,
  mode: ProductDiscoveryMode,
): boolean {
  return (source.supportedModes ?? ["general"]).includes(mode);
}

function statusFailure(response: Response): ProductDiscoveryError {
  if (response.status === 401 || response.status === 403) {
    return new ProductDiscoveryError(
      "The discovery provider rejected its configured credentials.",
      "configuration",
      { status: response.status },
    );
  }
  if (response.status === 429) {
    return new ProductDiscoveryError(
      "The discovery provider quota or request limit is exhausted.",
      "quota",
      { status: response.status },
    );
  }
  return new ProductDiscoveryError("The discovery provider is unavailable.", "unavailable", {
    status: response.status,
  });
}

function abortFailure(cause: unknown): ProductDiscoveryError {
  return new ProductDiscoveryError("The discovery request timed out.", "timeout", { cause });
}

function sourceFacts(input: {
  asin?: string | undefined;
  brand?: string | undefined;
  merchant?: string | undefined;
  description?: string | undefined;
  price?: string | undefined;
  rating?: number | undefined;
  reviews?: number | undefined;
  imageUrl?: string | undefined;
  position?: number | undefined;
}): string[] {
  return unique([
    input.asin ? `Observed ASIN: ${input.asin}` : undefined,
    input.brand ? `Observed brand: ${input.brand}` : undefined,
    input.merchant ? `Observed merchant: ${input.merchant}` : undefined,
    input.description ? `Observed description: ${input.description}` : undefined,
    input.price ? `Observed price: ${input.price}` : undefined,
    input.rating !== undefined ? `Observed rating: ${input.rating}` : undefined,
    input.reviews !== undefined ? `Observed review count: ${input.reviews}` : undefined,
    input.imageUrl ? `Observed image reference: ${input.imageUrl}` : undefined,
    input.position !== undefined
      ? `Observed provider result position: ${input.position}`
      : undefined,
  ]);
}

function hostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US");
  } catch {
    return undefined;
  }
}

const serpApiGoogleShoppingItemSchema = z
  .object({
    title: nonEmptyText,
    product_id: z.union([z.string(), z.number()]).optional(),
    product_link: z.url({ protocol: /^https?$/ }),
    source: nonEmptyText.optional(),
    price: nonEmptyText.optional(),
    rating: z.number().nonnegative().optional(),
    reviews: z.number().int().nonnegative().optional(),
    snippet: nonEmptyText.optional(),
  })
  .passthrough();

const serpApiEnvelopeSchema = z
  .object({
    error: nonEmptyText.optional(),
    search_metadata: z.object({ status: z.string().optional() }).passthrough().optional(),
    shopping_results: z.array(serpApiGoogleShoppingItemSchema).optional(),
    inline_shopping_results: z.array(serpApiGoogleShoppingItemSchema).optional(),
  })
  .passthrough();

const serpApiAmazonItemSchema = z
  .object({
    position: z.number().int().positive().optional(),
    asin: nonEmptyText.optional(),
    brand: nonEmptyText.optional(),
    title: nonEmptyText,
    link: z.url({ protocol: /^https?$/ }),
    link_clean: z.url({ protocol: /^https?$/ }).optional(),
    thumbnail: z.url({ protocol: /^https?$/ }).optional(),
    price: nonEmptyText.optional(),
    rating: z.number().nonnegative().optional(),
    reviews: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const serpApiAmazonEnvelopeSchema = z
  .object({
    error: nonEmptyText.optional(),
    search_metadata: z.object({ status: z.string().optional() }).passthrough().optional(),
    organic_results: z.array(serpApiAmazonItemSchema).optional(),
  })
  .passthrough();

function serpApiPayloadError(error: string): ProductDiscoveryError {
  const code = /quota|limit|run out|exhaust/i.test(error)
    ? "quota"
    : /api.?key|credential|auth/i.test(error)
      ? "configuration"
      : "unavailable";
  return new ProductDiscoveryError("SerpAPI could not complete the search.", code);
}

function amazonProductUrl(
  item: z.infer<typeof serpApiAmazonItemSchema>,
  asin: string | undefined,
): string | undefined {
  for (const value of [item.link_clean, item.link]) {
    if (!value || !isApprovedAmazonUsHost(value)) continue;
    const urlAsin = extractAmazonAsin(value);
    if (urlAsin && (!asin || urlAsin === asin)) return normalizeAmazonUrl(value);
  }
  return undefined;
}

export class SerpApiProductDiscoverySource implements ProductDiscoverySource {
  readonly providerId = "serpapi" as const;
  readonly paidUsage = true as const;
  readonly supportedModes = ["general", "amazon"] as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(apiKey: string, timeoutMs: number, fetchImplementation: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = fetchImplementation;
  }

  async search(input: ProductDiscoveryQuery): Promise<ProductSourceCandidateInput[]> {
    const discoveryMode = input.discoveryMode ?? "general";
    const url = new URL("https://serpapi.com/search.json");
    url.search = new URLSearchParams(
      discoveryMode === "amazon"
        ? {
            engine: "amazon",
            k: input.query,
            api_key: this.apiKey,
            amazon_domain: "amazon.com",
            language: "en_US",
            output: "json",
          }
        : {
            engine: "google_shopping",
            q: input.query,
            api_key: this.apiKey,
            gl: "us",
            hl: "en",
            output: "json",
          },
    ).toString();
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: { accept: "application/json" },
        signal,
      });
    } catch (cause) {
      if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw abortFailure(cause);
      }
      throw new ProductDiscoveryError(
        "The SerpAPI discovery request could not connect.",
        "unavailable",
        { cause },
      );
    }
    if (!response.ok) throw statusFailure(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ProductDiscoveryError("SerpAPI returned malformed JSON.", "malformed", { cause });
    }
    if (discoveryMode === "amazon") {
      const parsed = serpApiAmazonEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ProductDiscoveryError(
          "SerpAPI returned an unexpected Amazon result shape.",
          "malformed",
          { cause: parsed.error },
        );
      }
      if (parsed.data.error) throw serpApiPayloadError(parsed.data.error);
      return (parsed.data.organic_results ?? []).slice(0, input.candidateLimit).map((item) => {
        const asin =
          (item.asin ? normalizeAmazonAsin(item.asin) : undefined) ??
          extractAmazonAsin(item.link_clean ?? item.link) ??
          extractAmazonAsin(item.link);
        const productUrl = amazonProductUrl(item, asin);
        const domain = hostname(productUrl ?? item.link);
        return {
          sourceKind: "serpapi" as const,
          provider: "SerpAPI",
          discoveryMode,
          ...(item.brand ? { brand: item.brand } : {}),
          ...(domain ? { domain } : {}),
          marketplace: "amazon.com",
          ...(asin ? { externalId: asin } : {}),
          sourceUrl: item.link,
          ...(productUrl ? { productUrl } : {}),
          name: item.title,
          sourceFacts: sourceFacts({
            asin,
            brand: item.brand,
            price: item.price,
            rating: item.rating,
            reviews: item.reviews,
            imageUrl: item.thumbnail,
            position: item.position,
          }),
          query: input.query,
          observedAt: input.observedAt,
          ...(item.price ? { observedPrice: item.price } : {}),
          ...(item.rating !== undefined ? { observedRating: item.rating } : {}),
          ...(item.reviews !== undefined ? { observedReviewCount: item.reviews } : {}),
          ...(item.thumbnail ? { observedImageUrl: item.thumbnail } : {}),
          ...(item.position !== undefined ? { providerResultPosition: item.position } : {}),
        };
      });
    }

    const parsed = serpApiEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProductDiscoveryError("SerpAPI returned an unexpected result shape.", "malformed", {
        cause: parsed.error,
      });
    }
    if (parsed.data.error) throw serpApiPayloadError(parsed.data.error);
    return [...(parsed.data.shopping_results ?? []), ...(parsed.data.inline_shopping_results ?? [])]
      .slice(0, input.candidateLimit)
      .map((item) => {
        const sourceUrl = item.product_link;
        const merchant = item.source;
        const domain = hostname(sourceUrl);
        const externalId = item.product_id === undefined ? undefined : String(item.product_id);
        return {
          sourceKind: "serpapi" as const,
          provider: "SerpAPI",
          discoveryMode,
          ...(merchant ? { merchant } : {}),
          ...(domain ? { domain } : {}),
          ...(externalId ? { externalId, marketplace: "google.com" } : {}),
          sourceUrl,
          ...(isGoogleShoppingIntermediaryUrl(sourceUrl) ? {} : { productUrl: sourceUrl }),
          name: item.title,
          sourceFacts: sourceFacts({
            merchant,
            description: item.snippet,
            price: item.price,
            rating: item.rating,
            reviews: item.reviews,
          }),
          query: input.query,
          observedAt: input.observedAt,
          ...(item.price ? { observedPrice: item.price } : {}),
          ...(item.rating !== undefined ? { observedRating: item.rating } : {}),
          ...(item.reviews !== undefined ? { observedReviewCount: item.reviews } : {}),
        };
      });
  }
}

const dataForSeoShoppingItemSchema = z
  .object({
    type: z.literal("shopping_element"),
    title: nonEmptyText,
    url: z.url({ protocol: /^https?$/ }),
    domain: nonEmptyText.nullish(),
    source: nonEmptyText.nullish(),
    description: nonEmptyText.nullish(),
    marketplace: nonEmptyText.nullish(),
    price: z.object({ displayed_price: nonEmptyText.nullish() }).passthrough().nullish(),
    rating: z
      .object({
        value: z.number().nonnegative().optional(),
        votes_count: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .nullish(),
    product_identifiers: z
      .object({
        product_id: z.union([z.string(), z.number()]).nullish(),
        data_docid: z.union([z.string(), z.number()]).nullish(),
        gid: z.union([z.string(), z.number()]).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const dataForSeoEnvelopeSchema = z
  .object({
    status_code: z.number().int(),
    status_message: z.string(),
    tasks: z.array(
      z
        .object({
          status_code: z.number().int(),
          status_message: z.string(),
          result: z
            .array(
              z
                .object({
                  items: z.array(z.unknown()).nullish(),
                })
                .passthrough(),
            )
            .nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class DataForSeoProductDiscoverySource implements ProductDiscoverySource {
  readonly providerId = "dataforseo" as const;
  readonly paidUsage = true as const;
  readonly supportedModes = ["general"] as const;
  private readonly login: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    login: string,
    password: string,
    timeoutMs: number,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.login = login;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = fetchImplementation;
  }

  async search(input: ProductDiscoveryQuery): Promise<ProductSourceCandidateInput[]> {
    if (input.discoveryMode === "amazon") {
      throw new ProductDiscoveryError(
        "Amazon-first discovery requires the configured SerpAPI provider.",
        "configuration",
      );
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString("base64")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify([
            { keyword: input.query, location_code: 2840, language_code: "en" },
          ]),
          signal,
        },
      );
    } catch (cause) {
      if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw abortFailure(cause);
      }
      throw new ProductDiscoveryError(
        "The DataForSEO discovery request could not connect.",
        "unavailable",
        { cause },
      );
    }
    if (!response.ok) throw statusFailure(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ProductDiscoveryError("DataForSEO returned malformed JSON.", "malformed", {
        cause,
      });
    }
    const parsed = dataForSeoEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProductDiscoveryError(
        "DataForSEO returned an unexpected result shape.",
        "malformed",
        { cause: parsed.error },
      );
    }
    if (
      parsed.data.status_code !== 20000 ||
      parsed.data.tasks.some(({ status_code }) => status_code !== 20000)
    ) {
      throw new ProductDiscoveryError("DataForSEO could not complete the search.", "unavailable");
    }
    const items = parsed.data.tasks.flatMap((task) =>
      (task.result ?? []).flatMap((result) =>
        (result.items ?? []).flatMap((container) => {
          if (!container || typeof container !== "object") return [];
          const record = container as { type?: unknown; items?: unknown };
          if (record.type !== "shopping" || !Array.isArray(record.items)) return [];
          return record.items.flatMap((item) => {
            const shopping = dataForSeoShoppingItemSchema.safeParse(item);
            return shopping.success ? [shopping.data] : [];
          });
        }),
      ),
    );
    return items.slice(0, input.candidateLimit).map((item) => {
      const domain = item.domain ?? hostname(item.url);
      const merchant = item.source ?? undefined;
      const identifier =
        item.product_identifiers?.product_id ??
        item.product_identifiers?.data_docid ??
        item.product_identifiers?.gid;
      const externalId =
        identifier === null || identifier === undefined ? undefined : String(identifier);
      const observedPrice = item.price?.displayed_price ?? undefined;
      const observedRating = item.rating?.value;
      const observedReviewCount = item.rating?.votes_count;
      return {
        sourceKind: "dataforseo" as const,
        provider: "DataForSEO",
        discoveryMode: "general" as const,
        ...(merchant ? { merchant } : {}),
        ...(domain ? { domain } : {}),
        ...(externalId && domain ? { externalId, marketplace: domain } : {}),
        sourceUrl: item.url,
        ...(isGoogleShoppingIntermediaryUrl(item.url) ? {} : { productUrl: item.url }),
        name: item.title,
        sourceFacts: sourceFacts({
          merchant,
          description: item.description ?? undefined,
          price: observedPrice,
          rating: observedRating,
          reviews: observedReviewCount,
        }),
        query: input.query,
        observedAt: input.observedAt,
        ...(observedPrice ? { observedPrice } : {}),
        ...(observedRating !== undefined ? { observedRating } : {}),
        ...(observedReviewCount !== undefined ? { observedReviewCount } : {}),
      };
    });
  }
}

export type ProductDiscoveryConfiguration =
  | { provider: "disabled" }
  | { provider: "serpapi"; apiKey: string; timeoutMs: number }
  | {
      provider: "dataforseo";
      login: string;
      password: string;
      timeoutMs: number;
      paidPolicy: "allow-paid-dataforseo";
    };

export function resolveProductDiscoveryConfiguration(
  environment: Record<string, string | undefined> = process.env,
): ProductDiscoveryConfiguration {
  const provider = environment.PRODUCT_DISCOVERY_PROVIDER?.trim() || "disabled";
  if (provider === "disabled") return { provider };
  if (!(PRODUCT_DISCOVERY_PROVIDERS as readonly string[]).includes(provider)) {
    throw new TypeError(
      'PRODUCT_DISCOVERY_PROVIDER must be "disabled", "serpapi", or "dataforseo".',
    );
  }
  const timeoutMs = Number(environment.PRODUCT_DISCOVERY_TIMEOUT_MS?.trim() || "8000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("PRODUCT_DISCOVERY_TIMEOUT_MS must be a positive integer.");
  }
  if (provider === "serpapi") {
    const apiKey = environment.SERPAPI_API_KEY?.trim();
    if (!apiKey) throw new TypeError("SERPAPI_API_KEY is required when SerpAPI is selected.");
    return { provider, apiKey, timeoutMs };
  }
  if (environment.DATAFORSEO_ENABLED?.trim() !== "true") {
    throw new TypeError("DataForSEO remains disabled until DATAFORSEO_ENABLED=true.");
  }
  if (environment.PRODUCT_DISCOVERY_PAID_POLICY?.trim() !== "allow-paid-dataforseo") {
    throw new TypeError("DataForSEO requires PRODUCT_DISCOVERY_PAID_POLICY=allow-paid-dataforseo.");
  }
  const login = environment.DATAFORSEO_LOGIN?.trim();
  const password = environment.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) {
    throw new TypeError("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are required.");
  }
  return {
    provider: "dataforseo",
    login,
    password,
    timeoutMs,
    paidPolicy: "allow-paid-dataforseo",
  };
}

export function createProductDiscoverySource(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): ProductDiscoverySource | undefined {
  const configuration = resolveProductDiscoveryConfiguration(environment);
  if (configuration.provider === "disabled") return undefined;
  return configuration.provider === "serpapi"
    ? new SerpApiProductDiscoverySource(
        configuration.apiKey,
        configuration.timeoutMs,
        fetchImplementation,
      )
    : new DataForSeoProductDiscoverySource(
        configuration.login,
        configuration.password,
        configuration.timeoutMs,
        fetchImplementation,
      );
}

interface ProductDiscoveryRunOptions {
  products: readonly Product[];
  allRequests?: readonly ProductSourcingRequest[];
  benchmarkProductIds?: readonly string[];
  slotResolved?: boolean;
  forceExternal?: boolean;
  skipCatalogReuse?: boolean;
  discoveryMode?: ProductDiscoveryMode;
  round?: number;
  now?: Date;
  limits?: Partial<{ [Key in keyof typeof DEFAULT_PRODUCT_DISCOVERY_LIMITS]: number }>;
}

function candidateInput(candidate: ProductSourceCandidate): ProductSourceCandidateInput {
  return {
    sourceKind: candidate.sourceKind,
    provider: candidate.provider,
    ...(candidate.discoveryMode ? { discoveryMode: candidate.discoveryMode } : {}),
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.merchant ? { merchant: candidate.merchant } : {}),
    ...(candidate.domain ? { domain: candidate.domain } : {}),
    ...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
    ...(candidate.externalId ? { externalId: candidate.externalId } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
    ...(candidate.productUrl ? { productUrl: candidate.productUrl } : {}),
    ...(candidate.affiliateUrl ? { affiliateUrl: candidate.affiliateUrl } : {}),
    ...(candidate.originalProductUrl ? { originalProductUrl: candidate.originalProductUrl } : {}),
    ...(candidate.originalAffiliateUrl
      ? { originalAffiliateUrl: candidate.originalAffiliateUrl }
      : {}),
    ...(candidate.trackingId ? { trackingId: candidate.trackingId } : {}),
    ...(candidate.urlWarnings ? { urlWarnings: candidate.urlWarnings } : {}),
    name: candidate.name,
    sourceFacts: candidate.sourceFacts,
    ...(candidate.query ? { query: candidate.query } : {}),
    ...(candidate.observedAt ? { observedAt: candidate.observedAt } : {}),
    ...(candidate.observedPrice ? { observedPrice: candidate.observedPrice } : {}),
    ...(candidate.observedRating !== undefined ? { observedRating: candidate.observedRating } : {}),
    ...(candidate.observedReviewCount !== undefined
      ? { observedReviewCount: candidate.observedReviewCount }
      : {}),
    ...(candidate.observedImageUrl ? { observedImageUrl: candidate.observedImageUrl } : {}),
    ...(candidate.providerResultPosition !== undefined
      ? { providerResultPosition: candidate.providerResultPosition }
      : {}),
  };
}

function sameDiscoveryContext(
  left: ProductSourcingRequest,
  right: ProductSourcingRequest,
): boolean {
  const normalize = (value: string) => value.trim().toLocaleLowerCase("en-US");
  return (
    normalize(left.requiredCategory) === normalize(right.requiredCategory) &&
    normalize(left.searchPlan?.productClass ?? left.requiredCategory) ===
      normalize(right.searchPlan?.productClass ?? right.requiredCategory)
  );
}

function compatibleCatalogProducts(
  request: ProductSourcingRequest,
  products: readonly Product[],
): Product[] {
  const requiredFacts = new Set(
    request.mustHaveVerifiedFacts.map((fact) => fact.trim().toLocaleLowerCase("en-US")),
  );
  return products.filter((product) => {
    if (product.status !== "active") return false;
    const facts = new Set(
      (product.verifiedFacts ?? []).map((fact) => fact.trim().toLocaleLowerCase("en-US")),
    );
    return (
      productSlotMatchScore(product, {
        slotLabel: request.requiredCategory,
        slotIntent: request.intendedRole,
        searchTerms: [...request.searchTerms, request.audience, request.occasion],
      }) >= 2 && [...requiredFacts].every((fact) => facts.has(fact))
    );
  });
}

function withDiscoveryRound(
  request: ProductSourcingRequest,
  round: number,
  provider: ProductDiscoverySource["providerId"],
  discoveryMode: ProductDiscoveryMode,
  status: ProductSourcingRequest["discoveryRounds"][number]["status"],
  queries: string[],
  providerCalls: number,
  storedCandidateCount: number,
  attemptedAt: string,
  failureCode?: ProductDiscoveryFailureCode,
  counts: { returnedCandidateCount?: number; reusedCandidateCount?: number } = {},
): ProductSourcingRequest {
  return productSourcingRequestSchema.parse({
    ...request,
    discoveryRounds: [
      ...request.discoveryRounds,
      {
        round,
        provider,
        discoveryMode,
        status,
        queries,
        providerCalls,
        storedCandidateCount,
        ...counts,
        attemptedAt,
        ...(failureCode ? { failureCode } : {}),
      },
    ],
    updatedAt: attemptedAt,
  });
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await work(values[index]!);
      }
    }),
  );
  return results;
}

export async function runProductDiscovery(
  request: ProductSourcingRequest,
  source: ProductDiscoverySource,
  options: ProductDiscoveryRunOptions,
): Promise<ProductSourcingRequest> {
  if (!request.searchPlan) throw new TypeError("Generate a product SearchPlan before discovery.");
  const discoveryMode = options.discoveryMode ?? "general";
  if (!productDiscoverySourceSupportsMode(source, discoveryMode)) {
    throw new TypeError(
      discoveryMode === "amazon"
        ? "Amazon-first discovery requires the configured SerpAPI provider."
        : "The configured discovery provider does not support general search.",
    );
  }
  const limits = { ...DEFAULT_PRODUCT_DISCOVERY_LIMITS, ...options.limits };
  const round = options.round ?? request.discoveryRounds.length + 1;
  if (round !== request.discoveryRounds.length + 1 || round > limits.maxRounds) {
    throw new TypeError(
      "A second and final discovery round requires an explicit next-round action.",
    );
  }
  const now = options.now ?? new Date();
  const attemptedAt = now.toISOString();
  const queries = request.searchPlan.queries.slice(
    0,
    discoveryMode === "amazon"
      ? 1
      : Math.min(limits.maxQueriesPerSlot, limits.maxProviderCallsPerRun),
  );
  if (options.slotResolved || request.approvedProductIds.length) {
    return withDiscoveryRound(
      request,
      round,
      source.providerId,
      discoveryMode,
      "skipped-resolved",
      queries,
      0,
      0,
      attemptedAt,
    );
  }
  const benchmarkProducts = new Set(options.benchmarkProductIds ?? []);
  if (
    !options.forceExternal &&
    !options.skipCatalogReuse &&
    (compatibleCatalogProducts(request, options.products).length ||
      options.products.some(({ id, status }) => status === "active" && benchmarkProducts.has(id)))
  ) {
    return withDiscoveryRound(
      request,
      round,
      source.providerId,
      discoveryMode,
      "reused-catalog",
      queries,
      0,
      0,
      attemptedAt,
    );
  }

  const recentThreshold = now.valueOf() - limits.reuseWindowMs;
  const recent = (options.allRequests ?? [])
    .filter((other) => other.id !== request.id && sameDiscoveryContext(request, other))
    .flatMap(({ sourceCandidates }) => sourceCandidates)
    .filter(
      (candidate) =>
        candidate.sourceKind === source.providerId &&
        (candidate.discoveryMode ?? "general") === discoveryMode &&
        candidate.status !== "rejected" &&
        candidate.query !== undefined &&
        queries.includes(candidate.query) &&
        candidate.observedAt !== undefined &&
        new Date(candidate.observedAt).valueOf() >= recentThreshold,
    );
  const discoveredCount = request.sourceCandidates.filter(
    (candidate) =>
      (candidate.sourceKind === "serpapi" || candidate.sourceKind === "dataforseo") &&
      (candidate.discoveryMode ?? "general") === discoveryMode,
  ).length;
  const available = Math.max(0, limits.maxStoredCandidatesPerSlot - discoveredCount);
  if (available === 0) {
    return withDiscoveryRound(
      request,
      round,
      source.providerId,
      discoveryMode,
      "reused-candidates",
      queries,
      0,
      0,
      attemptedAt,
    );
  }
  if (!options.forceExternal && recent.length) {
    const reused = addProductSourceCandidates(
      request,
      recent.slice(0, available).map(candidateInput),
      now,
    );
    return withDiscoveryRound(
      reused,
      round,
      source.providerId,
      discoveryMode,
      "reused-candidates",
      queries,
      0,
      reused.sourceCandidates.length - request.sourceCandidates.length,
      attemptedAt,
      undefined,
      { reusedCandidateCount: Math.min(recent.length, available) },
    );
  }

  const outcomes = await boundedMap(queries, limits.maxConcurrency, async (query) => {
    try {
      return {
        candidates: await source.search({
          query,
          candidateLimit: Math.min(
            DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxStoredCandidatesPerSlot,
            limits.maxStoredCandidatesPerSlot,
          ),
          observedAt: attemptedAt,
          discoveryMode,
        }),
      };
    } catch (error) {
      return {
        candidates: [] as ProductSourceCandidateInput[],
        error:
          error instanceof ProductDiscoveryError
            ? error
            : new ProductDiscoveryError(
                "The discovery provider failed unexpectedly.",
                "unavailable",
                { cause: error },
              ),
      };
    }
  });
  const returnedCandidates = outcomes.flatMap(({ candidates: found }) => found);
  const candidates = returnedCandidates.slice(0, available).map((candidate) => ({
    ...candidate,
    discoveryMode: candidate.discoveryMode ?? discoveryMode,
  }));
  const updated = candidates.length
    ? addProductSourceCandidates(request, candidates, now)
    : request;
  const storedCandidateCount = updated.sourceCandidates.length - request.sourceCandidates.length;
  const failures = outcomes.flatMap(({ error }) => (error ? [error] : []));
  const status = storedCandidateCount
    ? failures.length
      ? "partial"
      : "stored"
    : failures.length === outcomes.length
      ? "failed"
      : failures.length
        ? "partial"
        : "empty";
  return withDiscoveryRound(
    updated,
    round,
    source.providerId,
    discoveryMode,
    status,
    queries,
    outcomes.length,
    storedCandidateCount,
    attemptedAt,
    failures[0]?.code,
    { returnedCandidateCount: returnedCandidates.length },
  );
}
