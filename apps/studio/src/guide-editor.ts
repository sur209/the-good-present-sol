import { randomUUID } from "node:crypto";

import {
  amazonAffiliateUrlSchema,
  guidePath,
  productDisplayName,
  type GiftGuide,
  type Product,
  type ValidatedEditorialContent,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import {
  ProviderError,
  safeSchemaIssues,
  type GuideGenerationProvider,
  type SafeSchemaIssue,
} from "./ai-provider.ts";
import {
  DEFAULT_GIFT_COUNT,
  guideDraftSchema,
  guideOutlineSchema,
  guideQuestionnaireSchema,
  type GenerationMetadata,
  type GuideDraft,
  type GuideQuestionnaire,
} from "./drafts.ts";
import {
  generatedRecommendationSchema,
  generatedGuideSchema,
  generatedGuideMetadataSchema,
  FINAL_PROMPT_VERSION,
  mockFinalGuide,
  mockGuideMetadata,
  prepareGuideMetadataPrompt,
  prepareFinalPrompt,
  type GeneratedGuide,
} from "./final-prompt.ts";
import { mockGuideOutline, outlineQualityIssues, prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  generatedIdeaRecommendationSchema,
  IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
  IDEA_RECOMMENDATION_PROMPT_VERSION,
  mockIdeaRecommendation,
  prepareIdeaRecommendationBatchPrompt,
  prepareIdeaRecommendationPrompt,
  type GeneratedIdeaRecommendation,
} from "./idea-prompt.ts";
import {
  mockRecommendation,
  mockRecommendationFieldRepair,
  prepareRecommendationFieldRepairPrompt,
  prepareRecommendationPrompt,
  productBackedCopyFieldSchema,
  recommendationFieldRepairSchema,
  RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION,
  RECOMMENDATION_PROMPT_VERSION,
  type ProductBackedCopyField,
} from "./recommendation-prompt.ts";

type QuestionnaireInput = Partial<Record<keyof GuideQuestionnaire, string | undefined>>;

export const SAFE_PRODUCT_COPY_VERSION = "product-recommendation-deterministic-v1";
export const SAFE_IDEA_COPY_VERSION = "idea-recommendation-deterministic-v1";
export const MANUAL_EDITORIAL_COPY_VERSION = "manual-editorial-v1";

export const RECOMMENDATION_COPY_DIAGNOSTIC_CODES = [
  "recommendation-copy-provider-failure",
  "recommendation-copy-schema-invalid",
  "recommendation-copy-claim-invalid",
  "recommendation-copy-product-identity-invalid",
] as const;
export type RecommendationCopyDiagnosticCode =
  (typeof RECOMMENDATION_COPY_DIAGNOSTIC_CODES)[number];

export interface GenerationContractDiagnostic {
  code: string;
  contractVersion: string;
  providerId: string;
  modelId?: string;
  path?: string;
  expected?: string;
  received?: string;
  reason?: string;
  matched?: string;
  source?: string;
  identitySafe?: boolean;
  verifiedSafe?: boolean;
  classification?: string;
}

function generationDiagnostic(
  code: string,
  provider: GuideGenerationProvider,
  contractVersion: string,
  details: Partial<
    Pick<
      GenerationContractDiagnostic,
      | "classification"
      | "expected"
      | "identitySafe"
      | "matched"
      | "path"
      | "reason"
      | "received"
      | "source"
      | "verifiedSafe"
    >
  > = {},
): GenerationContractDiagnostic {
  return {
    code,
    contractVersion,
    providerId: provider.providerId,
    ...(provider.modelId ? { modelId: provider.modelId } : {}),
    ...details,
  };
}

export function formatGenerationContractDiagnostic(
  diagnostic: GenerationContractDiagnostic,
): string {
  return [
    diagnostic.code,
    diagnostic.path ? `path=${diagnostic.path}` : undefined,
    diagnostic.expected ? `expected=${diagnostic.expected}` : undefined,
    diagnostic.received ? `received=${diagnostic.received}` : undefined,
    diagnostic.reason ? `reason=${diagnostic.reason}` : undefined,
    diagnostic.matched ? `matched=${JSON.stringify(diagnostic.matched)}` : undefined,
    diagnostic.source ? `source=${diagnostic.source}` : undefined,
    diagnostic.identitySafe !== undefined ? `identitySafe=${diagnostic.identitySafe}` : undefined,
    diagnostic.verifiedSafe !== undefined ? `verifiedSafe=${diagnostic.verifiedSafe}` : undefined,
    diagnostic.classification ? `classification=${diagnostic.classification}` : undefined,
    `provider=${diagnostic.providerId}`,
    diagnostic.modelId ? `model=${diagnostic.modelId}` : undefined,
    `contract=${diagnostic.contractVersion}`,
  ]
    .filter(Boolean)
    .join(" ");
}

class RecommendationCopyValidationError extends TypeError {
  readonly diagnosticCode: RecommendationCopyDiagnosticCode;
  readonly reason: string;

  constructor(message: string, diagnosticCode: RecommendationCopyDiagnosticCode, reason: string) {
    super(message);
    this.name = "RecommendationCopyValidationError";
    this.diagnosticCode = diagnosticCode;
    this.reason = reason;
  }
}

export function normalizeQuestionnaire(input: QuestionnaireInput): GuideQuestionnaire {
  const text = (key: keyof GuideQuestionnaire): string | undefined => {
    const value = input[key]?.trim();
    return value || undefined;
  };
  const rawCount = text("giftCount");
  const giftCount = rawCount ? Number(rawCount) : DEFAULT_GIFT_COUNT;
  return guideQuestionnaireSchema.parse({
    ...(text("recipient") ? { recipient: text("recipient") } : {}),
    ...(text("ageRange") ? { ageRange: text("ageRange") } : {}),
    ...(text("occasion") ? { occasion: text("occasion") } : {}),
    giftCount,
    ...(text("budget") ? { budget: text("budget") } : {}),
    ...(text("interests") ? { interests: text("interests") } : {}),
    ...(text("avoid") ? { avoid: text("avoid") } : {}),
    ...(text("tone") ? { tone: text("tone") } : {}),
    ...(text("additional") ? { additional: text("additional") } : {}),
  });
}

function generationMetadata(
  provider: GuideGenerationProvider,
  promptVersion: string,
  prompt: string,
  now: Date,
): GenerationMetadata {
  return {
    providerId: provider.providerId,
    ...(provider.modelId ? { modelId: provider.modelId } : {}),
    generatedAt: now.toISOString(),
    promptVersion,
    prompt,
    validation: { success: true },
  };
}

export async function generateGuideOutline(
  draft: GuideDraft,
  content: ValidatedEditorialContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideDraft> {
  const blockedReason = outlineRegenerationBlockReason(draft);
  if (blockedReason) throw new TypeError(blockedReason);
  const prepared = prepareOutlinePrompt(draft, content);
  const generated = await provider.generateStructured({
    operation: "outline",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: guideOutlineSchema,
    mockResponse: () => mockGuideOutline(prepared.input),
  });
  const outline = guideOutlineSchema.parse(generated);
  const qualityIssues = outlineQualityIssues(outline);
  if (qualityIssues.length) {
    throw new TypeError(`The generated outline is too broad. ${qualityIssues.join(" ")}`);
  }
  if (outline.slots.some((slot, index) => slot.id !== prepared.input.slotIds[index])) {
    throw new TypeError("La respuesta cambiÃ³ los IDs estables asignados por el Studio.");
  }
  return guideDraftSchema.parse({
    ...draft,
    status: "outline-ready",
    outline,
    generationMetadata: generationMetadata(provider, prepared.version, prepared.prompt, now),
    recommendations: outline.slots.map((slot, index) => ({
      id: slot.id,
      position: index + 1,
      slotLabel: slot.label,
      slotIntent: slot.intent,
      searchTerms: slot.searchTerms,
      ...(slot.budgetHint ? { budgetHint: slot.budgetHint } : {}),
      editorialStatus: "needs-generation",
    })),
  });
}

const recommendationCopyFields = [
  "heading",
  "editorialDescription",
  "whyItFits",
  "bestFor",
  "selectionGuidance",
  "considerations",
  "editorialPromptVersion",
] as const;

export function outlineRegenerationBlockReason(draft: GuideDraft): string | undefined {
  const outlineSlots = draft.outline?.slots;
  const hasRecommendationWork =
    (outlineSlots && outlineSlots.length !== draft.recommendations.length) ||
    draft.recommendations.some((recommendation, index) => {
      const outlineSlot = outlineSlots?.[index];
      return Boolean(
        recommendation.productId ||
        recommendation.directAffiliateUrl ||
        recommendation.editorialStatus !== "needs-generation" ||
        recommendationCopyFields.some((field) => recommendation[field]) ||
        !outlineSlot ||
        recommendation.id !== outlineSlot.id ||
        recommendation.position !== index + 1 ||
        recommendation.slotLabel !== outlineSlot.label ||
        recommendation.slotIntent !== outlineSlot.intent ||
        recommendation.budgetHint !== outlineSlot.budgetHint ||
        JSON.stringify(recommendation.searchTerms) !== JSON.stringify(outlineSlot.searchTerms),
      );
    });
  return hasRecommendationWork
    ? "No se puede regenerar el esquema porque reemplazaría recomendaciones con trabajo editorial o comercial existente. El Studio bloquea esta acción para evitar perder cambios."
    : undefined;
}

function recommendationIndex(draft: GuideDraft, recommendationId: string): number {
  const index = draft.recommendations.findIndex(
    (recommendation) => recommendation.id === recommendationId,
  );
  if (index === -1) throw new TypeError(`No existe el slot "${recommendationId}".`);
  return index;
}

export function duplicateProductIds(draft: GuideDraft): string[] {
  const counts = new Map<string, number>();
  for (const recommendation of draft.recommendations) {
    if (recommendation.productId) {
      counts.set(recommendation.productId, (counts.get(recommendation.productId) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([productId]) => productId)
    .sort();
}

export function selectRecommendationProduct(
  draft: GuideDraft,
  recommendationId: string,
  productId: string,
  content: ValidatedPublicContent,
  allowDuplicate = false,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const product = content.products.find((item) => item.id === productId);
  if (!product || product.status !== "active") {
    throw new TypeError("Sólo se puede seleccionar un producto activo del catálogo.");
  }
  const recommendation = draft.recommendations[index]!;
  if (recommendation.productId === productId) return draft;
  const duplicate = draft.recommendations.some(
    (item, itemIndex) => itemIndex !== index && item.productId === productId,
  );
  if (duplicate && !allowDuplicate) {
    throw new TypeError("El producto ya está seleccionado. Confirmá explícitamente el duplicado.");
  }
  const recommendations = [...draft.recommendations];
  const { editorialPromptVersion: _editorialPromptVersion, ...unversioned } = recommendation;
  recommendations[index] = {
    ...unversioned,
    productId,
    editorialStatus:
      recommendation.productId ||
      recommendation.editorialDescription ||
      recommendation.whyItFits ||
      recommendation.selectionGuidance
        ? "needs-review"
        : "needs-generation",
  };
  return guideDraftSchema.parse({ ...draft, status: "selecting-products", recommendations });
}

export function clearRecommendationProduct(
  draft: GuideDraft,
  recommendationId: string,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const recommendation = draft.recommendations[index]!;
  const {
    productId: _productId,
    editorialPromptVersion: _editorialPromptVersion,
    ...withoutProduct
  } = recommendation;
  const recommendations = [...draft.recommendations];
  recommendations[index] = {
    ...withoutProduct,
    editorialStatus:
      recommendation.editorialDescription || recommendation.whyItFits
        ? "needs-review"
        : "needs-generation",
  };
  return guideDraftSchema.parse({ ...draft, status: "selecting-products", recommendations });
}

export function moveRecommendation(
  draft: GuideDraft,
  recommendationId: string,
  direction: -1 | 1,
): GuideDraft {
  const recommendations = [...draft.recommendations].sort(
    (left, right) => left.position - right.position,
  );
  const index = recommendations.findIndex(
    (recommendation) => recommendation.id === recommendationId,
  );
  if (index === -1) throw new TypeError(`No existe el slot "${recommendationId}".`);
  const target = index + direction;
  if (target < 0 || target >= recommendations.length) return draft;
  [recommendations[index], recommendations[target]] = [
    recommendations[target]!,
    recommendations[index]!,
  ];
  return guideDraftSchema.parse({
    ...draft,
    status: "selecting-products",
    recommendations: recommendations.map((recommendation, itemIndex) => ({
      ...recommendation,
      position: itemIndex + 1,
    })),
  });
}

export function removeRecommendation(draft: GuideDraft, recommendationId: string): GuideDraft {
  recommendationIndex(draft, recommendationId);
  const recommendations = draft.recommendations
    .filter((recommendation) => recommendation.id !== recommendationId)
    .sort((left, right) => left.position - right.position)
    .map((recommendation, index) => ({ ...recommendation, position: index + 1 }));
  return guideDraftSchema.parse({ ...draft, status: "selecting-products", recommendations });
}

export function addManualRecommendation(
  draft: GuideDraft,
  slotLabel: string,
  slotIntent?: string,
  searchTerms?: string[],
  id = `slot_${randomUUID()}`,
): GuideDraft {
  return guideDraftSchema.parse({
    ...draft,
    status: "selecting-products",
    recommendations: [
      ...draft.recommendations,
      {
        id,
        position: draft.recommendations.length + 1,
        slotLabel,
        ...(slotIntent ? { slotIntent } : {}),
        ...(searchTerms?.length ? { searchTerms } : {}),
        editorialStatus: "needs-generation",
      },
    ],
  });
}

function rejectGeneratedUrls(value: unknown): void {
  if (/(?:https?:\/\/|www\.)/i.test(JSON.stringify(value))) {
    throw new TypeError("La respuesta generada no puede contener URLs.");
  }
}

function assertExactRecommendations(draft: GuideDraft, generated: GeneratedGuide): void {
  const expected = [...draft.recommendations].sort((left, right) => left.position - right.position);
  if (generated.recommendations.length !== expected.length) {
    throw new TypeError("La respuesta cambió la cantidad de recomendaciones seleccionadas.");
  }
  generated.recommendations.forEach((recommendation, index) => {
    const slot = expected[index]!;
    if (
      recommendation.id !== slot.id ||
      recommendation.productId !== slot.productId ||
      recommendation.position !== slot.position
    ) {
      throw new TypeError("La respuesta cambió IDs, productos u orden de las recomendaciones.");
    }
  });
}

export async function generateFinalGuide(
  draft: GuideDraft,
  content: ValidatedPublicContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideDraft> {
  const prepared = prepareFinalPrompt(draft, content);
  const generated = generatedGuideSchema.parse(
    await provider.generateStructured({
      operation: "final-guide",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: generatedGuideSchema,
      mockResponse: () => mockFinalGuide(prepared.input),
    }),
  );
  rejectGeneratedUrls(generated);
  assertExactRecommendations(draft, generated);
  for (const recommendation of generated.recommendations) {
    const product = content.products.find(({ id }) => id === recommendation.productId)!;
    const slot = draft.recommendations.find(({ id }) => id === recommendation.id)!;
    if (
      productBackedCopyNeedsVerifiedFactsRepair(
        recommendation,
        product,
        undefined,
        productClaimContext(draft, slot),
      )
    ) {
      throw new TypeError("La guía contiene claims de Product sin respaldo en verifiedFacts.");
    }
  }
  const current = new Map(
    draft.recommendations.map((recommendation) => [recommendation.id, recommendation]),
  );
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    title: generated.title,
    excerpt: generated.excerpt,
    introduction: generated.introduction,
    conclusion: generated.conclusion,
    seoTitle: generated.seoTitle,
    seoDescription: generated.seoDescription,
    recommendations: generated.recommendations.map((recommendation) => {
      const existing = current.get(recommendation.id)!;
      const {
        heading: _heading,
        editorialDescription: _editorialDescription,
        whyItFits: _whyItFits,
        bestFor: _bestFor,
        selectionGuidance: _selectionGuidance,
        considerations: _considerations,
        editorialPromptVersion: _editorialPromptVersion,
        editorialStatus: _editorialStatus,
        ...slot
      } = existing;
      return {
        ...slot,
        ...recommendation,
        editorialPromptVersion: FINAL_PROMPT_VERSION,
        editorialStatus: "ready",
      };
    }),
    generationMetadata: generationMetadata(provider, prepared.version, prepared.prompt, now),
  });
}

const guideMetadataFields = ["excerpt", "introduction", "seoTitle", "seoDescription"] as const;

export function guideEditorialMetadataIsComplete(draft: GuideDraft): boolean {
  return guideMetadataFields.every((field) => Boolean(draft[field]));
}

function deterministicGuideMetadata(
  draft: GuideDraft,
  content: ValidatedEditorialContent,
): GuideDraft {
  const cluster = content.clusters.find(({ id }) => id === draft.clusterId);
  const title = draft.title ?? draft.outline?.provisionalTitle ?? cluster?.title ?? "Gift Guide";
  const audience = (
    draft.questionnaire.recipient ??
    draft.outline?.audienceSummary ??
    "the intended recipient"
  )
    .split(/[.;\n]/)[0]!
    .slice(0, 80)
    .trim();
  const giftContext = draft.recommendations[0]?.slotLabel ?? cluster?.title ?? "thoughtful gifts";
  const primaryIntent = draft.primaryIntent ?? "Choose a gift with a clear personal fit.";
  const editorialAngle = draft.outline?.editorialAngle;
  const excerpt = `${title} is a focused guide to ${giftContext.toLocaleLowerCase("en-US")} for ${audience}.`;
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    excerpt: draft.excerpt ?? excerpt,
    introduction:
      draft.introduction ??
      `Created for ${audience}, this guide follows a clear aim: ${primaryIntent}${/[.!?]$/.test(primaryIntent) ? "" : "."}${editorialAngle ? ` Its editorial focus is ${editorialAngle}${/[.!?]$/.test(editorialAngle) ? "" : "."}` : ""} The recommendations stay grounded in concrete choices such as ${giftContext.toLocaleLowerCase("en-US")}.`,
    seoTitle: draft.seoTitle ?? title.slice(0, 70),
    seoDescription: draft.seoDescription ?? excerpt.slice(0, 180),
  });
}

export interface GuideMetadataCompletion {
  draft: GuideDraft;
  actionsPerformed: string[];
  warnings: string[];
}

type ProductBackedEditorialCopy = Pick<
  GuideDraft["recommendations"][number],
  | "heading"
  | "editorialDescription"
  | "whyItFits"
  | "bestFor"
  | "selectionGuidance"
  | "considerations"
  | "editorialPromptVersion"
>;

const currentProductCopyVersions = new Set([
  FINAL_PROMPT_VERSION,
  RECOMMENDATION_PROMPT_VERSION,
  SAFE_PRODUCT_COPY_VERSION,
  MANUAL_EDITORIAL_COPY_VERSION,
]);

function claimWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

export type ObservedClaimSource = "listing-title" | "short-description";
export type ObservedClaimClassification =
  "identity-safe" | "verified-safe" | "observed-only" | "ambiguous";

export interface ObservedClaimMatch {
  matched: string;
  source: ObservedClaimSource;
  identitySafe: boolean;
  verifiedSafe: boolean;
  classification: ObservedClaimClassification;
}

export interface ProductClaimContext {
  productClass?: string;
  slotPurpose?: string;
  guideContext?: string[];
}

export function productClaimContext(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
): ProductClaimContext {
  return {
    productClass: slot.slotLabel,
    ...(slot.slotIntent ? { slotPurpose: slot.slotIntent } : {}),
    guideContext: [
      draft.title,
      draft.primaryIntent,
      draft.questionnaire.recipient,
      draft.outline?.audienceSummary,
      draft.outline?.editorialAngle,
    ].filter((value): value is string => Boolean(value)),
  };
}

function includesPhrase(words: string[], phrase: string[]): boolean {
  return words.some((_, index) => phrase.every((word, offset) => words[index + offset] === word));
}

function claimPhrases(value: string): string[][] {
  const words = claimWords(value);
  return [4, 3, 2].flatMap((length) =>
    words
      .slice(0, Math.max(0, words.length - length + 1))
      .map((_, index) => words.slice(index, index + length)),
  );
}

export function classifyObservedClaimMatches(
  value: string,
  product: Product,
  context: ProductClaimContext = {},
): ObservedClaimMatch[] {
  const bodyWords = claimWords(value);
  const identityPhrases = [product.brand, productDisplayName(product), context.productClass]
    .filter((item): item is string => Boolean(item))
    .map(claimWords);
  const verifiedPhrases = (product.verifiedFacts ?? []).map(claimWords);
  const contextPhrases = [context.slotPurpose, ...(context.guideContext ?? [])]
    .filter((item): item is string => Boolean(item))
    .map(claimWords);
  const matches: ObservedClaimMatch[] = [];
  const seen = new Set<string>();
  for (const [source, observed] of [
    ["listing-title", product.name],
    ["short-description", product.shortDescription],
  ] as const) {
    for (const phrase of claimPhrases(observed)) {
      if (!includesPhrase(bodyWords, phrase)) continue;
      const matched = phrase.join(" ");
      const key = `${source}:${matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const identitySafe = identityPhrases.some((words) => includesPhrase(words, phrase));
      const verifiedSafe = verifiedPhrases.some((words) => includesPhrase(words, phrase));
      matches.push({
        matched,
        source,
        identitySafe,
        verifiedSafe,
        classification: identitySafe
          ? "identity-safe"
          : verifiedSafe
            ? "verified-safe"
            : contextPhrases.some((words) => includesPhrase(words, phrase))
              ? "ambiguous"
              : "observed-only",
      });
    }
  }
  return matches;
}

export type ProductBackedCopyFailureReason =
  | "empty-copy"
  | "stale-contract"
  | "raw-listing-title"
  | "merchant-copy"
  | "listing-description-copy"
  | "unsupported-url"
  | "commerce-claim"
  | "internal-terminology"
  | "unsupported-numeric-claim"
  | "observed-listing-claim";

interface ProductBackedTextFailure {
  reason: ProductBackedCopyFailureReason;
  match?: ObservedClaimMatch;
}

function productBackedTextFailure(
  value: string,
  product: Product,
  context: ProductClaimContext = {},
): ProductBackedTextFailure | undefined {
  const body = value.toLocaleLowerCase("en-US");
  if (/(?:https?:\/\/|www\.)/i.test(body)) return { reason: "unsupported-url" };
  if (/\b(?:slot|sourcing|candidate|product[- ]backed|resolved product)\b/i.test(body)) {
    return { reason: "internal-terminology" };
  }
  const observedTitle = product.name.toLocaleLowerCase("en-US");
  const canonicalIdentity = productDisplayName(product).toLocaleLowerCase("en-US");
  if (observedTitle !== canonicalIdentity && body.includes(observedTitle)) {
    return { reason: "raw-listing-title" };
  }
  if (body.includes(product.merchant.toLocaleLowerCase("en-US"))) {
    return { reason: "merchant-copy" };
  }
  if (body.includes(product.shortDescription.toLocaleLowerCase("en-US"))) {
    return { reason: "listing-description-copy" };
  }
  if (
    /[$€£]\s?\d|\b(?:ratings?|reviews?|discounts?|in stock|available now|availability)\b/i.test(
      body,
    )
  ) {
    return { reason: "commerce-claim" };
  }
  const claims =
    body.match(
      /\b(?:upf|spf)\s*\d+\+?|\b\d+(?:\.\d+)?\s*(?:-|\s)?(?:count|pack|mg|g|kg|oz|ounces?|ml|liters?|inches?|cm|mm|hours?|watts?|volts?|mah|gb|servings?)\b/gi,
    ) ?? [];
  const verified = (product.verifiedFacts ?? [])
    .join(" ")
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/g, "");
  if (
    claims.some(
      (claim) => !verified.includes(claim.toLocaleLowerCase("en-US").replace(/[\s-]+/g, "")),
    )
  ) {
    return { reason: "unsupported-numeric-claim" };
  }
  const match = classifyObservedClaimMatches(body, product, context).find(
    ({ classification }) => classification === "observed-only" || classification === "ambiguous",
  );
  if (match) return { reason: "observed-listing-claim", match };
  return undefined;
}

export function productBackedCopyFailureReason(
  copy: ProductBackedEditorialCopy,
  product: Product,
  guidePromptVersion?: string,
  context: ProductClaimContext = {},
): ProductBackedCopyFailureReason | undefined {
  const body = [
    copy.heading,
    copy.editorialDescription,
    copy.whyItFits,
    copy.bestFor,
    copy.selectionGuidance,
    copy.considerations,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("en-US");
  if (!body) return "empty-copy";
  if (copy.editorialPromptVersion && !currentProductCopyVersions.has(copy.editorialPromptVersion)) {
    return "stale-contract";
  }
  if (
    !copy.editorialPromptVersion &&
    guidePromptVersion &&
    /^(?:final-guide|single-recommendation)-v/.test(guidePromptVersion) &&
    !currentProductCopyVersions.has(guidePromptVersion)
  ) {
    return "stale-contract";
  }
  return productBackedTextFailure(body, product, context)?.reason;
}

export function productBackedCopyNeedsVerifiedFactsRepair(
  copy: ProductBackedEditorialCopy,
  product: Product,
  guidePromptVersion?: string,
  context: ProductClaimContext = {},
): boolean {
  return Boolean(productBackedCopyFailureReason(copy, product, guidePromptVersion, context));
}

export async function completeGuideEditorialMetadata(
  draft: GuideDraft,
  content: ValidatedEditorialContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideMetadataCompletion> {
  if (guideEditorialMetadataIsComplete(draft)) {
    return { draft, actionsPerformed: [], warnings: [] };
  }
  const prepared = prepareGuideMetadataPrompt(draft, content);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const generated = generatedGuideMetadataSchema.partial().parse(
        await provider.generateStructured({
          operation: "guide-metadata",
          prompt: prepared.prompt,
          input: prepared.input,
          schema: generatedGuideMetadataSchema.partial(),
          mockResponse: () => mockGuideMetadata(prepared.input),
        }),
      );
      if (prepared.input.missingFields.some((field) => !generated[field])) {
        throw new ProviderError("guide-metadata-missing-fields", "invalid-schema");
      }
      rejectGeneratedUrls(generated);
      return {
        draft: guideDraftSchema.parse({
          ...draft,
          status: "editing",
          ...Object.fromEntries(
            prepared.input.missingFields.map((field) => [field, generated[field]]),
          ),
          generationMetadata: generationMetadata(provider, prepared.version, prepared.prompt, now),
        }),
        actionsPerformed: ["generated-guide-metadata"],
        warnings: [],
      };
    } catch (error) {
      const retryable =
        error instanceof z.ZodError ||
        (error instanceof ProviderError && !["authentication", "refusal"].includes(error.code));
      if (attempt === 0 && retryable) continue;
      break;
    }
  }
  return {
    draft: deterministicGuideMetadata(draft, content),
    actionsPerformed: ["generated-safe-guide-metadata-fallback"],
    warnings: ["guide-metadata-fallback-used"],
  };
}

export function applyDeterministicProductCopyFallback(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const slot = draft.recommendations[index]!;
  if (!slot.productId || !content.products.some(({ id }) => id === slot.productId)) {
    throw new TypeError("Product copy fallback requires an assigned published Product.");
  }
  const ideaFallback = applyDeterministicIdeaCopyFallback(draft, recommendationId).recommendations[
    index
  ]!;
  const copy = Object.fromEntries(
    ideaOnlyCopyFields.flatMap((field) => {
      const existing = slot[field];
      const value = existing && !ideaOnlyCopyDiagnostic(existing) ? existing : ideaFallback[field];
      return value ? [[field, value]] : [];
    }),
  );
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations: draft.recommendations.map((recommendation) =>
      recommendation.id === recommendationId
        ? {
            ...recommendation,
            ...copy,
            editorialPromptVersion: SAFE_PRODUCT_COPY_VERSION,
            editorialStatus: "ready",
          }
        : recommendation,
    ),
  });
}

type GeneratedProductRecommendation = z.infer<typeof generatedRecommendationSchema>;

function applyGeneratedProductRecommendation(
  draft: GuideDraft,
  recommendationId: string,
  generated: GeneratedProductRecommendation,
  provider: GuideGenerationProvider,
  prompt: string,
  now: Date,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const existing = draft.recommendations[index]!;
  const {
    heading: _heading,
    editorialDescription: _editorialDescription,
    whyItFits: _whyItFits,
    bestFor: _bestFor,
    considerations: _considerations,
    editorialPromptVersion: _editorialPromptVersion,
    editorialStatus: _editorialStatus,
    ...slot
  } = existing;
  const recommendations = [...draft.recommendations];
  recommendations[index] = {
    ...slot,
    ...generated,
    editorialPromptVersion: RECOMMENDATION_PROMPT_VERSION,
    editorialStatus: "ready",
  };
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations,
    generationMetadata: generationMetadata(provider, RECOMMENDATION_PROMPT_VERSION, prompt, now),
  });
}

export async function regenerateRecommendation(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideDraft> {
  const prepared = prepareRecommendationPrompt(draft, recommendationId, content);
  const response = await provider.generateStructured({
    operation: "single-recommendation",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: generatedRecommendationSchema,
    mockResponse: () => mockRecommendation(prepared.input),
  });
  const parsed = generatedRecommendationSchema.safeParse(response);
  if (!parsed.success) {
    throw new ProviderError(
      "La respuesta del proveedor no cumple el esquema editorial esperado.",
      "invalid-schema",
      { cause: parsed.error, schemaIssues: safeSchemaIssues(parsed.error, response) },
    );
  }
  const generated = parsed.data;
  try {
    rejectGeneratedUrls(generated);
  } catch {
    throw new RecommendationCopyValidationError(
      "La recomendación generada no puede contener URLs.",
      "recommendation-copy-claim-invalid",
      "unsupported-url",
    );
  }
  const index = recommendationIndex(draft, recommendationId);
  const existing = draft.recommendations[index]!;
  if (
    generated.id !== existing.id ||
    generated.productId !== existing.productId ||
    generated.position !== existing.position
  ) {
    throw new RecommendationCopyValidationError(
      "La respuesta cambió la identidad de la recomendación.",
      "recommendation-copy-product-identity-invalid",
      "id-productId-or-position-changed",
    );
  }
  const product = content.products.find(({ id }) => id === generated.productId)!;
  const safeGenerated = generated.heading
    ? generated
    : generatedRecommendationSchema.parse({
        ...generated,
        heading: applyDeterministicProductCopyFallback(draft, recommendationId, content)
          .recommendations[index]!.heading,
      });
  const claimFailure = productBackedCopyFailureReason(
    safeGenerated,
    product,
    undefined,
    productClaimContext(draft, existing),
  );
  if (claimFailure) {
    throw new RecommendationCopyValidationError(
      "La recomendación contiene claims sin respaldo en verifiedFacts.",
      "recommendation-copy-claim-invalid",
      claimFailure,
    );
  }
  return applyGeneratedProductRecommendation(
    draft,
    recommendationId,
    safeGenerated,
    provider,
    prepared.prompt,
    now,
  );
}

const productBackedCopyFields = productBackedCopyFieldSchema.options;

export interface ProductBackedCopyGeneration {
  draft: GuideDraft;
  diagnosticDetails: GenerationContractDiagnostic[];
  repairedFields: ProductBackedCopyField[];
  repairedClaims: Array<ObservedClaimMatch & { field: ProductBackedCopyField }>;
}

async function repairProductBackedRecommendationField(
  draft: GuideDraft,
  recommendationId: string,
  field: ProductBackedCopyField,
  content: ValidatedPublicContent,
  provider: GuideGenerationProvider,
): Promise<string> {
  const prepared = prepareRecommendationFieldRepairPrompt(draft, recommendationId, field, content);
  const response = await provider.generateStructured({
    operation: "recommendation-field-repair",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: recommendationFieldRepairSchema,
    mockResponse: () => mockRecommendationFieldRepair(prepared.input),
  });
  const parsed = recommendationFieldRepairSchema.safeParse(response);
  if (!parsed.success) {
    throw new ProviderError(
      "La reparación no cumple el esquema editorial esperado.",
      "invalid-schema",
      { cause: parsed.error, schemaIssues: safeSchemaIssues(parsed.error, response) },
    );
  }
  return parsed.data.value;
}

export async function generateProductBackedRecommendationWithRecovery(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<ProductBackedCopyGeneration> {
  const prepared = prepareRecommendationPrompt(draft, recommendationId, content);
  const response = await provider.generateStructured({
    operation: "single-recommendation",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: generatedRecommendationSchema,
    mockResponse: () => mockRecommendation(prepared.input),
  });
  const parsed = generatedRecommendationSchema.safeParse(response);
  if (!parsed.success) {
    throw new ProviderError(
      "La respuesta del proveedor no cumple el esquema editorial esperado.",
      "invalid-schema",
      { cause: parsed.error, schemaIssues: safeSchemaIssues(parsed.error, response) },
    );
  }
  const generated = parsed.data;
  const existing = draft.recommendations[recommendationIndex(draft, recommendationId)]!;
  if (
    generated.id !== existing.id ||
    generated.productId !== existing.productId ||
    generated.position !== existing.position
  ) {
    throw new RecommendationCopyValidationError(
      "La respuesta cambió la identidad de la recomendación.",
      "recommendation-copy-product-identity-invalid",
      "id-productId-or-position-changed",
    );
  }
  const product = content.products.find(({ id }) => id === generated.productId)!;
  const fallback = applyDeterministicProductCopyFallback(
    draft,
    recommendationId,
    content,
  ).recommendations.find(({ id }) => id === recommendationId)!;
  const safeCopy: Partial<Record<ProductBackedCopyField, string>> = {};
  const repairedFields: ProductBackedCopyField[] = [];
  const repairedClaims: ProductBackedCopyGeneration["repairedClaims"] = [];
  const diagnosticDetails: GenerationContractDiagnostic[] = [];
  const claimContext = productClaimContext(draft, existing);
  for (const field of productBackedCopyFields) {
    const value = generated[field];
    if (value === undefined) continue;
    const failure = productBackedTextFailure(value, product, claimContext);
    if (!failure) {
      safeCopy[field] = value;
      continue;
    }
    repairedFields.push(field);
    if (failure.match) repairedClaims.push({ field, ...failure.match });
    try {
      const repaired = await repairProductBackedRecommendationField(
        draft,
        recommendationId,
        field,
        content,
        provider,
      );
      const repairFailure = productBackedTextFailure(repaired, product, claimContext);
      if (!repairFailure) {
        safeCopy[field] = repaired;
        continue;
      }
      const match = repairFailure.match ?? failure.match;
      diagnosticDetails.push(
        generationDiagnostic(
          "recommendation-copy-claim-invalid",
          provider,
          RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION,
          {
            path: field,
            expected: "verified-facts-safe-string",
            received: "policy-violation",
            reason: repairFailure.reason,
            ...(match ?? {}),
          },
        ),
      );
    } catch (error) {
      diagnosticDetails.push(
        ...recommendationCopyFailureDiagnostics(error, provider).map((diagnostic) => ({
          ...diagnostic,
          contractVersion: RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION,
          path: field,
          ...(failure.match ?? {}),
        })),
      );
    }
    if (fallback[field]) safeCopy[field] = fallback[field];
  }
  if (fallback.heading) safeCopy.heading ??= fallback.heading;
  const safeGenerated = generatedRecommendationSchema.parse({
    id: generated.id,
    productId: generated.productId,
    position: generated.position,
    ...safeCopy,
  });
  return {
    draft: applyGeneratedProductRecommendation(
      draft,
      recommendationId,
      safeGenerated,
      provider,
      prepared.prompt,
      now,
    ),
    diagnosticDetails,
    repairedFields,
    repairedClaims,
  };
}

type IdeaOnlyEditorialCopy = Partial<
  Record<
    | "heading"
    | "editorialDescription"
    | "whyItFits"
    | "bestFor"
    | "selectionGuidance"
    | "considerations",
    string | undefined
  >
>;

const ideaOnlyCopyFields = [
  "heading",
  "editorialDescription",
  "whyItFits",
  "bestFor",
  "selectionGuidance",
  "considerations",
] as const;
type IdeaOnlyCopyField = (typeof ideaOnlyCopyFields)[number];

export const IDEA_COPY_DIAGNOSTIC_CODES = [
  "idea-copy-provider-failure",
  "idea-copy-schema-invalid",
  "idea-copy-product-leak",
  "idea-copy-merchant-leak",
  "idea-copy-asin-leak",
  "idea-copy-internal-terminology",
  "idea-copy-unsupported-numeric-claim",
] as const;
export type IdeaCopyDiagnosticCode = (typeof IDEA_COPY_DIAGNOSTIC_CODES)[number];

function schemaIssuesFrom(error: unknown): SafeSchemaIssue[] {
  if (error instanceof ProviderError) return error.schemaIssues ?? [];
  return error instanceof z.ZodError ? safeSchemaIssues(error) : [];
}

function schemaContractDiagnostics(
  code: string,
  error: unknown,
  provider: GuideGenerationProvider,
  contractVersion: string,
): GenerationContractDiagnostic[] {
  const issues = schemaIssuesFrom(error);
  if (issues.length) {
    return issues.map(({ path, expected, received }) =>
      generationDiagnostic(code, provider, contractVersion, { path, expected, received }),
    );
  }
  return [
    generationDiagnostic(code, provider, contractVersion, {
      reason: error instanceof ProviderError ? error.code : "schema-validation",
    }),
  ];
}

export function recommendationCopyFailureDiagnostics(
  error: unknown,
  provider: GuideGenerationProvider,
): GenerationContractDiagnostic[] {
  if (error instanceof RecommendationCopyValidationError) {
    return [
      generationDiagnostic(error.diagnosticCode, provider, RECOMMENDATION_PROMPT_VERSION, {
        reason: error.reason,
      }),
    ];
  }
  if (
    error instanceof z.ZodError ||
    (error instanceof ProviderError &&
      [
        "empty-response",
        "invalid-json",
        "invalid-response",
        "invalid-schema",
        "truncated",
      ].includes(error.code))
  ) {
    return schemaContractDiagnostics(
      "recommendation-copy-schema-invalid",
      error,
      provider,
      RECOMMENDATION_PROMPT_VERSION,
    );
  }
  return [
    generationDiagnostic(
      "recommendation-copy-provider-failure",
      provider,
      RECOMMENDATION_PROMPT_VERSION,
      { reason: error instanceof ProviderError ? error.code : "generation-failure" },
    ),
  ];
}

const ideaOnlyNumericClaimPattern =
  /[$€£]\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s?(?:[-–—]\s*)?(?:count|pack|mg|g|kg|oz|ounces?|ml|liters?|inches?|cm|mm|hours?|watts?|volts?|mah|gb|calories?|grams?|servings?|percent(?:age)?s?)\b/gi;

function ideaOnlyNumericClaims(value: string): string[] {
  return value.match(ideaOnlyNumericClaimPattern) ?? [];
}

function normalizedNumericClaim(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/\s*(?:[-–—])\s*|\s+/g, "-");
}

export function ideaOnlyEditorialContext(
  draft: GuideDraft,
  slot: GuideDraft["recommendations"][number],
): string[] {
  const questionnaire = Object.entries(draft.questionnaire).flatMap(([key, value]) =>
    key !== "giftCount" && typeof value === "string" ? [value] : [],
  );
  return [
    draft.title,
    draft.outline?.provisionalTitle,
    draft.outline?.audienceSummary,
    draft.outline?.editorialAngle,
    draft.primaryIntent,
    draft.budgetContext?.label,
    ...questionnaire,
    slot.slotLabel,
    slot.slotIntent,
    slot.budgetHint,
  ].filter((value): value is string => Boolean(value));
}

export function ideaOnlyCopyDiagnostic(
  value: string,
  editorialContext: readonly string[] = [],
): IdeaCopyDiagnosticCode | undefined {
  const copy = value.toLocaleLowerCase("en-US");
  if (/\b(?:asin\s*)?b0[a-z0-9]{8}\b/i.test(copy)) return "idea-copy-asin-leak";
  if (
    /\b(?:this slot|product class|recommendation(?:'?s)? purpose|structured input|editorial system|product enrichment|studio workflow)\b/i.test(
      copy,
    )
  ) {
    return "idea-copy-internal-terminology";
  }
  if (/\b(?:amazon|ebay|etsy|target|walmart)\b/i.test(copy)) {
    return "idea-copy-merchant-leak";
  }
  if (/(?:https?:\/\/|www\.)/i.test(copy)) {
    return "idea-copy-product-leak";
  }
  if (
    /\b(?:usd|price|costs?|ratings?|reviews?|discounts?|stock|availability|available now|in stock)\b/i.test(
      copy,
    )
  ) {
    return "idea-copy-unsupported-numeric-claim";
  }
  const groundedClaims = new Set(
    editorialContext.flatMap(ideaOnlyNumericClaims).map(normalizedNumericClaim),
  );
  if (
    ideaOnlyNumericClaims(copy).some((claim) => !groundedClaims.has(normalizedNumericClaim(claim)))
  ) {
    return "idea-copy-unsupported-numeric-claim";
  }
  return undefined;
}

export function ideaOnlyCopyHasUnsupportedClaims(
  generated: IdeaOnlyEditorialCopy,
  editorialContext: readonly string[] = [],
): boolean {
  return ideaOnlyCopyFields.some((field) => {
    const value = generated[field];
    return value ? Boolean(ideaOnlyCopyDiagnostic(value, editorialContext)) : false;
  });
}

const legacyGenericIdeaHeading = "A practical gift idea";
const legacyGenericConsiderations =
  "Confirm personal fit, compatibility, and care requirements before choosing.";

function normalizedEditorialText(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

export function recommendationHasLegacyIdeaFallback(
  slot: GuideDraft["recommendations"][number],
  audience?: string,
): boolean {
  const normalizedAudience = normalizedEditorialText(audience);
  return Boolean(
    slot.editorialPromptVersion === SAFE_IDEA_COPY_VERSION ||
    normalizedEditorialText(slot.heading) === normalizedEditorialText(legacyGenericIdeaHeading) ||
    normalizedEditorialText(slot.editorialDescription) ===
      normalizedEditorialText(
        `${slot.slotLabel} can make a thoughtful gift when it matches the recipient's real routine and preferences.`,
      ) ||
    /^choose among\b/i.test(slot.editorialDescription ?? "") ||
    /^it supports this recommendation'?s purpose:/i.test(slot.whyItFits ?? "") ||
    normalizedEditorialText(slot.considerations) ===
      normalizedEditorialText(legacyGenericConsiderations) ||
    (normalizedAudience.length >= 20 &&
      normalizedEditorialText(slot.heading).includes(normalizedAudience)),
  );
}

export function ideaOnlyRecommendationNeedsCopyRepair(draft: GuideDraft, slotId: string): boolean {
  const slot = draft.recommendations.find(({ id }) => id === slotId);
  if (!slot || slot.productId) return Boolean(slot?.productId);
  return (
    recommendationHasLegacyIdeaFallback(slot, draft.questionnaire.recipient) ||
    ideaOnlyCopyHasUnsupportedClaims(slot, ideaOnlyEditorialContext(draft, slot))
  );
}

export function applyDeterministicIdeaCopyFallback(
  draft: GuideDraft,
  recommendationId: string,
): GuideDraft {
  recommendationIndex(draft, recommendationId);
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations: draft.recommendations.map((slot) =>
      slot.id === recommendationId
        ? (() => {
            const label = slot.slotLabel.trim();
            const giftIdea = label.toLocaleLowerCase("en-US");
            return {
              ...slot,
              heading: label,
              editorialDescription: `A well-chosen ${giftIdea} turns an everyday need into a gift that feels considered and personal.`,
              whyItFits: `It gives the recipient a useful choice centered on ${giftIdea}.`,
              bestFor: `Someone who would appreciate a well-chosen ${giftIdea}`,
              selectionGuidance: `Compare ${giftIdea} options for fit, comfort, care needs, and the features the recipient will value most.`,
              considerations:
                "Personal preferences and ease of care may matter more than extra features.",
              editorialPromptVersion: SAFE_IDEA_COPY_VERSION,
              editorialStatus: "ready",
            };
          })()
        : slot,
    ),
  });
}

const recoverableIdeaRecommendationSchema = z
  .strictObject({
    id: generatedIdeaRecommendationSchema.shape.id,
    position: generatedIdeaRecommendationSchema.shape.position,
    heading: z.unknown().optional(),
    editorialDescription: z.unknown().optional(),
    whyItFits: z.unknown().optional(),
    bestFor: z.unknown().optional(),
    selectionGuidance: z.unknown().optional(),
    considerations: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    for (const field of ideaOnlyCopyFields.slice(0, -1)) {
      if (!Object.hasOwn(value, field)) {
        context.addIssue({ code: "custom", path: [field], message: "Required field is missing." });
      }
    }
  });

const recoverableIdeaRecommendationBatchSchema = z.strictObject({
  recommendations: z.array(z.unknown()),
});

const ideaOnlyFieldSchemas = {
  heading: generatedIdeaRecommendationSchema.shape.heading,
  editorialDescription: generatedIdeaRecommendationSchema.shape.editorialDescription,
  whyItFits: generatedIdeaRecommendationSchema.shape.whyItFits,
  bestFor: generatedIdeaRecommendationSchema.shape.bestFor,
  selectionGuidance: generatedIdeaRecommendationSchema.shape.selectionGuidance,
  considerations: generatedIdeaRecommendationSchema.shape.considerations,
} as const;

function applyGeneratedIdeaRecommendation(
  draft: GuideDraft,
  recommendationId: string,
  generated: GeneratedIdeaRecommendation,
  provider: GuideGenerationProvider,
  prompt: string,
  now: Date,
  promptVersion = IDEA_RECOMMENDATION_PROMPT_VERSION,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const existing = draft.recommendations[index]!;
  const {
    heading: _heading,
    editorialDescription: _editorialDescription,
    whyItFits: _whyItFits,
    bestFor: _bestFor,
    selectionGuidance: _selectionGuidance,
    considerations: _considerations,
    editorialPromptVersion: _editorialPromptVersion,
    editorialStatus: _editorialStatus,
    ...slot
  } = existing;
  const recommendations = [...draft.recommendations];
  recommendations[index] = {
    ...slot,
    ...generated,
    editorialPromptVersion: promptVersion,
    editorialStatus: "ready",
  };
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations,
    generationMetadata: generationMetadata(provider, promptVersion, prompt, now),
  });
}

export interface IdeaOnlyCopyGeneration {
  draft: GuideDraft;
  diagnostics: IdeaCopyDiagnosticCode[];
  diagnosticDetails: GenerationContractDiagnostic[];
  repairedFields: IdeaOnlyCopyField[];
  usedDeterministicFallback: boolean;
}

function failureDiagnostic(error: unknown): IdeaCopyDiagnosticCode {
  if (
    error instanceof z.ZodError ||
    (error instanceof ProviderError &&
      [
        "empty-response",
        "invalid-json",
        "invalid-response",
        "invalid-schema",
        "truncated",
      ].includes(error.code))
  ) {
    return "idea-copy-schema-invalid";
  }
  return "idea-copy-provider-failure";
}

function ideaFailureDiagnostics(
  error: unknown,
  provider: GuideGenerationProvider,
  contractVersion = IDEA_RECOMMENDATION_PROMPT_VERSION,
): GenerationContractDiagnostic[] {
  const code = failureDiagnostic(error);
  return code === "idea-copy-schema-invalid"
    ? schemaContractDiagnostics(code, error, provider, contractVersion)
    : [
        generationDiagnostic(code, provider, contractVersion, {
          reason: error instanceof ProviderError ? error.code : "generation-failure",
        }),
      ];
}

export async function generateIdeaOnlyRecommendationWithRecovery(
  draft: GuideDraft,
  recommendationId: string,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<IdeaOnlyCopyGeneration> {
  const prepared = prepareIdeaRecommendationPrompt(draft, recommendationId);
  let raw: z.infer<typeof recoverableIdeaRecommendationSchema>;
  try {
    const response = await provider.generateStructured({
      operation: "idea-recommendation",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: recoverableIdeaRecommendationSchema,
      mockResponse: () => mockIdeaRecommendation(prepared.input.recommendation),
    });
    const parsed = recoverableIdeaRecommendationSchema.safeParse(response);
    if (!parsed.success) {
      throw new ProviderError(
        "La respuesta del proveedor no cumple el esquema editorial esperado.",
        "invalid-schema",
        { cause: parsed.error, schemaIssues: safeSchemaIssues(parsed.error, response) },
      );
    }
    raw = parsed.data;
    const existing = draft.recommendations[recommendationIndex(draft, recommendationId)]!;
    if (raw.id !== existing.id || raw.position !== existing.position) {
      const path = raw.id !== existing.id ? "id" : "position";
      throw new ProviderError("The response changed recommendation identity.", "invalid-schema", {
        schemaIssues: [{ path, expected: "unchanged-input-value", received: "mismatched-value" }],
      });
    }
  } catch (error) {
    return {
      draft: applyDeterministicIdeaCopyFallback(draft, recommendationId),
      diagnostics: [failureDiagnostic(error)],
      diagnosticDetails: ideaFailureDiagnostics(error, provider),
      repairedFields: [...ideaOnlyCopyFields],
      usedDeterministicFallback: true,
    };
  }

  const fallback = applyDeterministicIdeaCopyFallback(draft, recommendationId).recommendations.find(
    ({ id }) => id === recommendationId,
  )!;
  const safeCopy: Record<string, string | undefined> = {};
  const diagnostics: IdeaCopyDiagnosticCode[] = [];
  const diagnosticDetails: GenerationContractDiagnostic[] = [];
  const repairedFields: IdeaOnlyCopyField[] = [];
  const editorialContext = ideaOnlyEditorialContext(
    draft,
    draft.recommendations[recommendationIndex(draft, recommendationId)]!,
  );
  for (const field of ideaOnlyCopyFields) {
    if (field === "considerations" && raw[field] === undefined) continue;
    const parsed = ideaOnlyFieldSchemas[field].safeParse(raw[field]);
    if (field === "considerations" && parsed.success && parsed.data === undefined) continue;
    const diagnostic =
      parsed.success && parsed.data !== undefined
        ? ideaOnlyCopyDiagnostic(parsed.data, editorialContext)
        : "idea-copy-schema-invalid";
    if (diagnostic) {
      diagnostics.push(diagnostic);
      if (diagnostic === "idea-copy-schema-invalid" && !parsed.success) {
        const issue = safeSchemaIssues(parsed.error, raw[field])[0];
        diagnosticDetails.push(
          generationDiagnostic(diagnostic, provider, IDEA_RECOMMENDATION_PROMPT_VERSION, {
            path: field,
            expected: issue?.expected ?? "valid-field-value",
            received: issue?.received ?? "invalid-value",
          }),
        );
      } else {
        diagnosticDetails.push(
          generationDiagnostic(diagnostic, provider, IDEA_RECOMMENDATION_PROMPT_VERSION, {
            path: field,
            expected: "policy-compliant-string",
            received: "policy-violation",
          }),
        );
      }
      repairedFields.push(field);
      if (field !== "considerations") safeCopy[field] = fallback[field];
    } else {
      safeCopy[field] = parsed.data;
    }
  }
  const generated = generatedIdeaRecommendationSchema.parse({
    id: raw.id,
    position: raw.position,
    ...safeCopy,
  });
  return {
    draft: applyGeneratedIdeaRecommendation(
      draft,
      recommendationId,
      generated,
      provider,
      prepared.prompt,
      now,
    ),
    diagnostics: [...new Set(diagnostics)],
    diagnosticDetails,
    repairedFields,
    usedDeterministicFallback: false,
  };
}

interface IdeaBatchAttempt {
  prompt: string;
  valid: Map<string, GeneratedIdeaRecommendation>;
  failures: Map<string, GenerationContractDiagnostic[]>;
}

function validateIdeaBatchItem(
  value: unknown,
  expected: { id: string; position: number },
  provider: GuideGenerationProvider,
  editorialContext: readonly string[] = [],
): GeneratedIdeaRecommendation | GenerationContractDiagnostic[] {
  const parsed = recoverableIdeaRecommendationSchema.safeParse(value);
  if (!parsed.success) {
    return ideaFailureDiagnostics(
      new ProviderError("The batched recommendation failed schema validation.", "invalid-schema", {
        cause: parsed.error,
        schemaIssues: safeSchemaIssues(parsed.error, value),
      }),
      provider,
      IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
    );
  }
  if (parsed.data.id !== expected.id || parsed.data.position !== expected.position) {
    const path = parsed.data.id !== expected.id ? "id" : "position";
    return ideaFailureDiagnostics(
      new ProviderError("The batched response changed recommendation identity.", "invalid-schema", {
        schemaIssues: [{ path, expected: "unchanged-input-value", received: "mismatched-value" }],
      }),
      provider,
      IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
    );
  }

  const copy: Record<string, string | undefined> = {};
  const diagnostics: GenerationContractDiagnostic[] = [];
  for (const field of ideaOnlyCopyFields) {
    if (field === "considerations" && parsed.data[field] === undefined) continue;
    const fieldResult = ideaOnlyFieldSchemas[field].safeParse(parsed.data[field]);
    if (field === "considerations" && fieldResult.success && fieldResult.data === undefined) {
      continue;
    }
    const diagnostic =
      fieldResult.success && fieldResult.data !== undefined
        ? ideaOnlyCopyDiagnostic(fieldResult.data, editorialContext)
        : "idea-copy-schema-invalid";
    if (diagnostic) {
      const issue = !fieldResult.success
        ? safeSchemaIssues(fieldResult.error, parsed.data[field])[0]
        : undefined;
      diagnostics.push(
        generationDiagnostic(diagnostic, provider, IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION, {
          path: field,
          expected: issue?.expected ?? "policy-compliant-string",
          received: issue?.received ?? "policy-violation",
        }),
      );
    } else {
      copy[field] = fieldResult.data;
    }
  }
  return diagnostics.length
    ? diagnostics
    : generatedIdeaRecommendationSchema.parse({
        id: expected.id,
        position: expected.position,
        ...copy,
      });
}

async function generateIdeaBatchAttempt(
  draft: GuideDraft,
  recommendationIds: readonly string[],
  provider: GuideGenerationProvider,
  operation: "idea-recommendation-batch" | "idea-recommendation-batch-repair",
): Promise<IdeaBatchAttempt> {
  const prepared = prepareIdeaRecommendationBatchPrompt(draft, recommendationIds);
  const valid = new Map<string, GeneratedIdeaRecommendation>();
  const failures = new Map<string, GenerationContractDiagnostic[]>();
  try {
    const response = await provider.generateStructured({
      operation,
      prompt: prepared.prompt,
      input: prepared.input,
      schema: recoverableIdeaRecommendationBatchSchema,
      mockResponse: () => ({
        recommendations: prepared.input.recommendations.map(mockIdeaRecommendation),
      }),
    });
    const parsed = recoverableIdeaRecommendationBatchSchema.safeParse(response);
    if (!parsed.success) {
      throw new ProviderError("The batched response failed schema validation.", "invalid-schema", {
        cause: parsed.error,
        schemaIssues: safeSchemaIssues(parsed.error, response),
      });
    }
    const resultsById = new Map<string, unknown[]>();
    for (const result of parsed.data.recommendations) {
      if (typeof result !== "object" || result === null || !("id" in result)) continue;
      const id = (result as { id?: unknown }).id;
      if (typeof id === "string") resultsById.set(id, [...(resultsById.get(id) ?? []), result]);
    }
    for (const recommendation of prepared.input.recommendations) {
      const matches = resultsById.get(recommendation.id) ?? [];
      if (matches.length !== 1) {
        failures.set(
          recommendation.id,
          ideaFailureDiagnostics(
            new ProviderError(
              "The batched response did not contain exactly one result for the recommendation.",
              "invalid-schema",
              {
                schemaIssues: [
                  {
                    path: "id",
                    expected: "exactly-one-result",
                    received: `result-count=${matches.length}`,
                  },
                ],
              },
            ),
            provider,
            IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
          ),
        );
        continue;
      }
      const result = validateIdeaBatchItem(
        matches[0],
        recommendation,
        provider,
        ideaOnlyEditorialContext(
          draft,
          draft.recommendations[recommendationIndex(draft, recommendation.id)]!,
        ),
      );
      if (Array.isArray(result)) failures.set(recommendation.id, result);
      else valid.set(recommendation.id, result);
    }
  } catch (error) {
    const diagnostics = ideaFailureDiagnostics(
      error,
      provider,
      IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
    );
    for (const id of recommendationIds) failures.set(id, diagnostics);
  }
  return { prompt: prepared.prompt, valid, failures };
}

export interface IdeaOnlyBatchCopyGeneration {
  draft: GuideDraft;
  slots: {
    slotId: string;
    warnings: string[];
  }[];
}

export async function generateIdeaOnlyRecommendationBatchWithRecovery(
  draft: GuideDraft,
  recommendationIds: readonly string[],
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<IdeaOnlyBatchCopyGeneration> {
  let completed = draft;
  const warnings = new Map(recommendationIds.map((id) => [id, [] as string[]]));
  const primary = await generateIdeaBatchAttempt(
    completed,
    recommendationIds,
    provider,
    "idea-recommendation-batch",
  );
  for (const id of recommendationIds) {
    const generated = primary.valid.get(id);
    if (generated) {
      completed = applyGeneratedIdeaRecommendation(
        completed,
        id,
        generated,
        provider,
        primary.prompt,
        now,
        IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
      );
    } else {
      warnings
        .get(id)!
        .push(...(primary.failures.get(id) ?? []).map(formatGenerationContractDiagnostic));
    }
  }

  const failedIds = recommendationIds.filter((id) => !primary.valid.has(id));
  const repair = failedIds.length
    ? await generateIdeaBatchAttempt(
        completed,
        failedIds,
        provider,
        "idea-recommendation-batch-repair",
      )
    : undefined;
  for (const id of failedIds) {
    const generated = repair?.valid.get(id);
    if (generated) {
      completed = applyGeneratedIdeaRecommendation(
        completed,
        id,
        generated,
        provider,
        repair!.prompt,
        now,
        IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
      );
    } else {
      warnings
        .get(id)!
        .push(...(repair?.failures.get(id) ?? []).map(formatGenerationContractDiagnostic));
      completed = applyDeterministicIdeaCopyFallback(completed, id);
      warnings.get(id)!.push("idea-editorial-copy-fallback-used");
    }
  }

  return {
    draft: completed,
    slots: recommendationIds.map((slotId) => ({
      slotId,
      warnings: warnings.get(slotId)!,
    })),
  };
}

function rejectUnsafeIdeaOnlyClaims(
  generated: GeneratedIdeaRecommendation,
  editorialContext: readonly string[] = [],
): void {
  rejectGeneratedUrls(generated);
  if (ideaOnlyCopyHasUnsupportedClaims(generated, editorialContext)) {
    throw new TypeError(
      "La idea generada no puede afirmar Products, comercios, precios, disponibilidad ni especificaciones sin respaldo.",
    );
  }
}

export async function generateIdeaOnlyRecommendation(
  draft: GuideDraft,
  recommendationId: string,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideDraft> {
  const prepared = prepareIdeaRecommendationPrompt(draft, recommendationId);
  const generated = generatedIdeaRecommendationSchema.parse(
    await provider.generateStructured({
      operation: "idea-recommendation",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: generatedIdeaRecommendationSchema,
      mockResponse: () => mockIdeaRecommendation(prepared.input.recommendation),
    }),
  );
  const index = recommendationIndex(draft, recommendationId);
  const existing = draft.recommendations[index]!;
  rejectUnsafeIdeaOnlyClaims(generated, ideaOnlyEditorialContext(draft, existing));
  if (generated.id !== existing.id || generated.position !== existing.position) {
    throw new TypeError("La respuesta cambió la identidad de la idea.");
  }
  return applyGeneratedIdeaRecommendation(
    draft,
    recommendationId,
    generated,
    provider,
    prepared.prompt,
    now,
  );
}

export interface GuideEditorialCopy {
  title?: string | undefined;
  excerpt?: string | undefined;
  introduction?: string | undefined;
  conclusion?: string | undefined;
  seoTitle?: string | undefined;
  seoDescription?: string | undefined;
}

export function updateGuideEditorialCopy(draft: GuideDraft, copy: GuideEditorialCopy): GuideDraft {
  return guideDraftSchema.parse({ ...draft, ...copy, status: "editing" });
}

export interface RecommendationEditorialCopy {
  heading?: string | undefined;
  editorialDescription?: string | undefined;
  whyItFits?: string | undefined;
  bestFor?: string | undefined;
  selectionGuidance?: string | undefined;
  considerations?: string | undefined;
}

export function updateRecommendationEditorialCopy(
  draft: GuideDraft,
  recommendationId: string,
  copy: RecommendationEditorialCopy,
  markReady = false,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const current = draft.recommendations[index]!;
  const updated = {
    ...current,
    ...copy,
    editorialPromptVersion: MANUAL_EDITORIAL_COPY_VERSION,
  };
  if (markReady && (!updated.editorialDescription || !updated.whyItFits)) {
    throw new TypeError(
      "Para marcarla lista se requieren descripción editorial y motivo de elección.",
    );
  }
  const recommendations = [...draft.recommendations];
  recommendations[index] = {
    ...updated,
    editorialStatus: markReady ? "ready" : current.editorialStatus,
  };
  return guideDraftSchema.parse({ ...draft, status: "editing", recommendations });
}

export function updateRecommendationDirectAffiliateUrl(
  draft: GuideDraft,
  recommendationId: string,
  directAffiliateUrl?: string,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const recommendations = [...draft.recommendations];
  const current = recommendations[index]!;
  if (directAffiliateUrl) {
    const parsed = amazonAffiliateUrlSchema.safeParse(directAffiliateUrl);
    if (!parsed.success) {
      throw new TypeError("Ingresá una URL HTTPS de un host Amazon aceptado.");
    }
    recommendations[index] = { ...current, directAffiliateUrl: parsed.data };
  } else {
    const { directAffiliateUrl: _directAffiliateUrl, ...withoutAffiliateUrl } = current;
    recommendations[index] = withoutAffiliateUrl;
  }
  return guideDraftSchema.parse({ ...draft, recommendations });
}

export interface GuideDraftValidation {
  errors: string[];
  readiness: GuideDraftReadiness;
  route?: string;
}

export interface GuideDraftReadiness {
  recommendationCount: number;
  editorialReadyCount: number;
  productResolvedCount: number;
  productPendingCount: number;
  editorialComplete: boolean;
  productComplete: boolean;
}

export function recommendationIsEditoriallyReady(
  recommendation: GuideDraft["recommendations"][number],
): boolean {
  return Boolean(
    recommendation.editorialStatus === "ready" &&
    recommendation.editorialDescription &&
    recommendation.whyItFits &&
    (recommendation.productId || recommendation.selectionGuidance || recommendation.considerations),
  );
}

export function guideDraftReadiness(draft: GuideDraft): GuideDraftReadiness {
  const recommendationCount = draft.recommendations.length;
  const editorialReadyCount = draft.recommendations.filter(recommendationIsEditoriallyReady).length;
  const productResolvedCount = draft.recommendations.filter(({ productId }) => productId).length;
  return {
    recommendationCount,
    editorialReadyCount,
    productResolvedCount,
    productPendingCount: recommendationCount - productResolvedCount,
    editorialComplete: recommendationCount > 0 && editorialReadyCount === recommendationCount,
    productComplete: recommendationCount > 0 && productResolvedCount === recommendationCount,
  };
}

export function validateGuideDraft(
  draft: GuideDraft,
  content: ValidatedEditorialContent & { products?: Product[] },
): GuideDraftValidation {
  const errors: string[] = [];
  const readiness = guideDraftReadiness(draft);
  for (const [field, label] of [
    ["clusterId", "Cluster"],
    ["slug", "Slug"],
    ["primaryAxis", "Eje principal"],
    ["primaryIntent", "Intención principal"],
    ["title", "Título"],
    ["excerpt", "Extracto"],
    ["introduction", "Introducción"],
    ["seoTitle", "Título SEO"],
    ["seoDescription", "Descripción SEO"],
  ] as const) {
    if (!draft[field]) errors.push(`${label} es obligatorio.`);
  }

  const cluster = draft.clusterId
    ? content.clusters.find((item) => item.id === draft.clusterId)
    : undefined;
  if (draft.clusterId && !cluster) errors.push("El cluster elegido no está publicado.");
  let route: string | undefined;
  if (cluster && draft.slug) {
    try {
      route = guidePath(cluster.slug, draft.slug);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const conflicting = content.guides.find(
      (guide) =>
        guide.id !== draft.id && guide.clusterId === draft.clusterId && guide.slug === draft.slug,
    );
    if (conflicting) errors.push(`El slug ya pertenece a la guía "${conflicting.title}".`);
  }

  const related = new Set<string>();
  for (const guideId of draft.relatedGuideIds) {
    if (related.has(guideId)) errors.push(`La guía relacionada "${guideId}" está repetida.`);
    related.add(guideId);
    if (guideId === draft.id) errors.push("Una guía no puede relacionarse consigo misma.");
    const guide = content.guides.find((item) => item.id === guideId);
    if (!guide || guide.clusterId !== draft.clusterId) {
      errors.push(`La guía relacionada "${guideId}" no está publicada en el mismo cluster.`);
    }
  }

  if (draft.recommendations.length === 0)
    errors.push("La guía necesita al menos una recomendación.");
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const recommendation of draft.recommendations) {
    if (ids.has(recommendation.id)) errors.push(`El ID "${recommendation.id}" está duplicado.`);
    ids.add(recommendation.id);
    if (positions.has(recommendation.position)) {
      errors.push(`La posición ${recommendation.position} está duplicada.`);
    }
    positions.add(recommendation.position);
    if (recommendation.editorialStatus !== "ready") {
      errors.push(`El slot "${recommendation.slotLabel}" no está listo para publicar.`);
    }
    if (!recommendation.editorialDescription || !recommendation.whyItFits) {
      errors.push(`El slot "${recommendation.slotLabel}" necesita descripción y motivo.`);
    }
    if (
      !recommendation.productId &&
      !recommendation.selectionGuidance &&
      !recommendation.considerations
    ) {
      errors.push(`La idea "${recommendation.slotLabel}" necesita guía de selección.`);
    }
    if (recommendation.productId) {
      const product = content.products?.find((item) => item.id === recommendation.productId);
      if (!product || product.status !== "active") {
        errors.push(`El producto "${recommendation.productId}" no existe o está inactivo.`);
      }
    }
  }

  return { errors, readiness, ...(route ? { route } : {}) };
}

export function reopenGuideDraft(
  guide: GiftGuide,
  content: ValidatedPublicContent,
  now = new Date(),
): GuideDraft {
  const timestamp = now.toISOString();
  const products = new Map(content.products.map((product) => [product.id, product]));
  return guideDraftSchema.parse({
    schemaVersion: 1,
    id: guide.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    draftType: "gift-guide",
    status: "editing",
    clusterId: guide.clusterId,
    slug: guide.slug,
    language: guide.language,
    primaryAxis: guide.primaryAxis,
    primaryIntent: guide.primaryIntent,
    ...(guide.taxonomies ? { taxonomies: guide.taxonomies } : {}),
    ...(guide.budgetContext ? { budgetContext: guide.budgetContext } : {}),
    relatedGuideIds: guide.relatedGuideIds ?? [],
    questionnaire: { giftCount: Math.min(20, Math.max(3, guide.recommendations.length)) },
    title: guide.title,
    excerpt: guide.excerpt,
    introduction: guide.introduction,
    ...(guide.conclusion ? { conclusion: guide.conclusion } : {}),
    seoTitle: guide.seoTitle,
    seoDescription: guide.seoDescription,
    recommendations: [...guide.recommendations]
      .sort((left, right) => left.position - right.position)
      .map((recommendation) => {
        const product = recommendation.productId
          ? products.get(recommendation.productId)
          : undefined;
        return {
          id: recommendation.id,
          position: recommendation.position,
          slotLabel:
            recommendation.heading ?? product?.name ?? `Gift idea ${recommendation.position}`,
          slotIntent: recommendation.whyItFits,
          searchTerms: product
            ? [product.name, product.merchant]
            : [recommendation.heading ?? `Gift idea ${recommendation.position}`],
          ...(recommendation.productId ? { productId: recommendation.productId } : {}),
          ...(recommendation.directAffiliateUrl
            ? { directAffiliateUrl: recommendation.directAffiliateUrl }
            : {}),
          ...(recommendation.heading ? { heading: recommendation.heading } : {}),
          editorialDescription: recommendation.editorialDescription,
          whyItFits: recommendation.whyItFits,
          ...(recommendation.bestFor ? { bestFor: recommendation.bestFor } : {}),
          ...(!recommendation.productId &&
          "selectionGuidance" in recommendation &&
          recommendation.selectionGuidance
            ? { selectionGuidance: recommendation.selectionGuidance }
            : {}),
          ...(recommendation.considerations
            ? { considerations: recommendation.considerations }
            : {}),
          editorialStatus: "ready",
        };
      }),
  });
}
