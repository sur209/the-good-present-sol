import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { Product, ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import {
  ProviderError,
  type GuideGenerationProvider,
  type ProviderCallMetadata,
} from "../../ai-provider.ts";
import type { GuideDraft } from "../../drafts.ts";
import {
  PRODUCT_CLASS_PROFILES,
  productClassProfileSchema,
  resolveProductClassProfile,
  type ProductClassProfile,
} from "../../editorial-guidance.ts";
import { atomicWriteJson, REPOSITORY_ROOT } from "../../repository.ts";
import type { EditorialBenchmark } from "./benchmarks.ts";
import type { ProductSourceCandidate, ProductSourcingRequest } from "./sourcing.ts";

export const PRODUCT_FIT_PROMPT_VERSION = "product-fit-evaluator-v1";
export const PRODUCT_FIT_RANKING_POLICY_VERSION = "product-fit-ranking-v1";
export const PRODUCT_FIT_EVALUATIONS_DIRECTORY = "editorial-data/product-fit-evaluations";
export const PRODUCT_FIT_ASSESSMENTS = ["positive", "neutral", "negative", "unknown"] as const;

const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const requestId = safeId.regex(/^request_/);
const candidateId = safeId.regex(/^source_candidate_/);
const timestamp = z.iso.datetime({ offset: true });

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const productFitDimensionSchema = z.strictObject({
  assessment: z.enum(PRODUCT_FIT_ASSESSMENTS),
  rationale: nonEmptyText,
});

const editorialFunctionalFitSchema = z.strictObject({
  productClassMatch: productFitDimensionSchema,
  slotSpecificity: productFitDimensionSchema,
  guideRelevance: productFitDimensionSchema,
  recipientFit: productFitDimensionSchema,
  contextFit: productFitDimensionSchema,
  budgetCompatibility: productFitDimensionSchema,
});

const consumerGiftValueSchema = z.strictObject({
  practicalUsefulness: productFitDimensionSchema,
  giftDesirability: productFitDimensionSchema,
  giftabilityPresentation: productFitDimensionSchema,
  easeOfChoosingCorrectly: productFitDimensionSchema,
  compatibilitySelectionRisk: productFitDimensionSchema,
  perceivedValue: productFitDimensionSchema,
  emotionalRelevanceMemorability: productFitDimensionSchema,
});

const evidenceOperationsSchema = z.strictObject({
  evidenceQuality: productFitDimensionSchema,
  maintenanceRisk: productFitDimensionSchema,
  commercialSuitability: productFitDimensionSchema,
  existingCatalogReuseOpportunity: productFitDimensionSchema,
});

const collectionQualitySchema = z.strictObject({
  inGuideDistinctiveness: productFitDimensionSchema,
  redundancyWithCurrentSelections: productFitDimensionSchema,
  repeatedProductClass: productFitDimensionSchema,
  repeatedFunctionalRole: productFitDimensionSchema,
});

export const productFitEvaluationSchema = z.strictObject({
  requestId,
  candidateId,
  interpretedProductClass: nonEmptyText,
  editorialFunctionalFit: editorialFunctionalFitSchema,
  consumerGiftValue: consumerGiftValueSchema,
  evidenceOperations: evidenceOperationsSchema,
  collectionQuality: collectionQualitySchema,
  missingEvidence: textList,
  diagnosticSummary: z.strictObject({
    providerResultQuality: nonEmptyText,
    searchPlanOrClassRisk: nonEmptyText,
    profileCoverage: nonEmptyText,
    fitConfidence: nonEmptyText,
  }),
});

export const productFitEvaluationBatchSchema = z.strictObject({
  batchSynthesis: nonEmptyText,
  evaluations: z.array(productFitEvaluationSchema).min(1).max(40),
});

export type ProductFitEvaluation = z.infer<typeof productFitEvaluationSchema>;
export type ProductFitEvaluationBatch = z.infer<typeof productFitEvaluationBatchSchema>;

export const PRODUCT_FIT_EVALUATION_FAILURE_CODES = [
  "missing-result",
  "malformed-result",
  "schema-invalid-result",
  "provider-failure",
] as const;

export type ProductFitEvaluationFailureCode = (typeof PRODUCT_FIT_EVALUATION_FAILURE_CODES)[number];

export interface ProductFitEvaluationFailure {
  requestId: string;
  candidateId: string;
  code: ProductFitEvaluationFailureCode;
}

const compactProfileSchema = productClassProfileSchema.pick({
  classId: true,
  importantAttributes: true,
  requiredAttributes: true,
  undesirableAttributes: true,
  compatibilityRisks: true,
  giftabilityConsiderations: true,
  maintenanceConsiderations: true,
  evaluationGuidance: true,
  version: true,
});

const productSummarySchema = z.strictObject({
  id: safeId,
  name: nonEmptyText,
  categories: textList,
});

const fitPromptCandidateSchema = z.strictObject({
  requestId,
  candidateId,
  requestContext: z.strictObject({
    intendedRole: nonEmptyText,
    requiredCategory: nonEmptyText,
    audience: nonEmptyText,
    occasion: nonEmptyText,
    budgetContext: nonEmptyText,
    mustHaveVerifiedFacts: textList,
    exclusions: textList,
    plannedProductClass: nonEmptyText,
  }),
  providerObservedEvidence: z.strictObject({
    evidenceDomain: z.literal("provider-observed"),
    sourceKind: nonEmptyText,
    provider: nonEmptyText,
    name: nonEmptyText,
    merchant: nonEmptyText.optional(),
    domain: nonEmptyText.optional(),
    sourceFacts: textList,
    observedPrice: nonEmptyText.optional(),
    observedRating: z.number().nonnegative().optional(),
    observedReviewCount: z.number().int().nonnegative().optional(),
    observedAt: timestamp.optional(),
  }),
  canonicalProductEvidence: z
    .strictObject({
      evidenceDomain: z.literal("canonical-verified-product"),
      productId: safeId,
      name: nonEmptyText,
      shortDescription: nonEmptyText,
      verifiedFacts: textList,
      categories: textList,
    })
    .optional(),
  deterministicEvidence: z.strictObject({
    evidenceDomain: z.literal("I.0-deterministic"),
    sourceFactCount: z.number().int().nonnegative(),
    hasObservedPrice: z.boolean(),
    inGuideCanonicalProductRepeat: z.boolean(),
    inGuideSelectedProducts: z.array(productSummarySchema),
    crossGuideReuseGuideIds: z.array(safeId),
    sameObservedNameCandidateIds: z.array(candidateId),
  }),
  productClassProfile: compactProfileSchema,
  profileMatch: z.enum(["specific", "generic-fallback"]),
  editorialBenchmarks: z.array(
    z.strictObject({
      evidenceDomain: z.literal("editor-decision-benchmark"),
      benchmarkId: safeId,
      canonicalProductId: safeId,
      productClass: nonEmptyText,
      audienceTags: textList,
      contextTags: textList,
      editorRationale: nonEmptyText,
      strongFitReasons: textList,
      attributesOrReasons: textList,
      version: z.number().int().positive(),
    }),
  ),
});

export const productFitPromptInputSchema = z.strictObject({
  candidates: z.array(fitPromptCandidateSchema).min(1).max(40),
});

export type ProductFitPromptInput = z.infer<typeof productFitPromptInputSchema>;

const responseDimensionExample = {
  assessment: "positive | neutral | negative | unknown",
  rationale: "...",
};

const productFitResponseShapeExample = {
  batchSynthesis: "...",
  evaluations: [
    {
      requestId: "copy the exact requestId",
      candidateId: "copy the exact candidateId",
      interpretedProductClass: "...",
      editorialFunctionalFit: Object.fromEntries(
        [
          "productClassMatch",
          "slotSpecificity",
          "guideRelevance",
          "recipientFit",
          "contextFit",
          "budgetCompatibility",
        ].map((key) => [key, responseDimensionExample]),
      ),
      consumerGiftValue: Object.fromEntries(
        [
          "practicalUsefulness",
          "giftDesirability",
          "giftabilityPresentation",
          "easeOfChoosingCorrectly",
          "compatibilitySelectionRisk",
          "perceivedValue",
          "emotionalRelevanceMemorability",
        ].map((key) => [key, responseDimensionExample]),
      ),
      evidenceOperations: Object.fromEntries(
        [
          "evidenceQuality",
          "maintenanceRisk",
          "commercialSuitability",
          "existingCatalogReuseOpportunity",
        ].map((key) => [key, responseDimensionExample]),
      ),
      collectionQuality: Object.fromEntries(
        [
          "inGuideDistinctiveness",
          "redundancyWithCurrentSelections",
          "repeatedProductClass",
          "repeatedFunctionalRole",
        ].map((key) => [key, responseDimensionExample]),
      ),
      missingEvidence: ["..."],
      diagnosticSummary: {
        providerResultQuality: "...",
        searchPlanOrClassRisk: "...",
        profileCoverage: "...",
        fitConfidence: "...",
      },
    },
  ],
};

export interface ProductFitSelection {
  request: ProductSourcingRequest;
  candidateId: string;
}

export interface PrepareProductFitContext {
  content: ValidatedPublicContent;
  drafts?: readonly GuideDraft[];
  benchmarks?: readonly EditorialBenchmark[];
  profiles?: readonly ProductClassProfile[];
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

function productSummary(product: Product): z.infer<typeof productSummarySchema> {
  return { id: product.id, name: product.name, categories: product.categories ?? [] };
}

function matchingBenchmarks(
  benchmarks: readonly EditorialBenchmark[],
  profile: ProductClassProfile,
  productClass: string,
  profiles: readonly ProductClassProfile[],
): EditorialBenchmark[] {
  return benchmarks
    .filter(
      (benchmark) =>
        benchmark.status === "active" &&
        (profile.classId === "generic"
          ? normalized(benchmark.productClass) === normalized(productClass)
          : resolveProductClassProfile(benchmark.productClass, profiles).classId ===
            profile.classId),
    )
    .slice(0, 5);
}

function promptCandidate(
  selection: ProductFitSelection,
  allSelections: readonly ProductFitSelection[],
  context: PrepareProductFitContext,
): z.infer<typeof fitPromptCandidateSchema> {
  const candidate = selection.request.sourceCandidates.find(
    ({ id }) => id === selection.candidateId,
  );
  if (!candidate) {
    throw new TypeError(
      `Source candidate "${selection.candidateId}" does not belong to "${selection.request.id}".`,
    );
  }
  const drafts = context.drafts ?? [];
  const draft = draftForRequest(selection.request, drafts);
  const productsById = new Map(context.content.products.map((product) => [product.id, product]));
  const selectedProductIds = new Set(
    draft?.recommendations.flatMap(({ productId }) => (productId ? [productId] : [])) ?? [],
  );
  const selectedProducts = [...selectedProductIds].flatMap((id) => {
    const product = productsById.get(id);
    return product ? [productSummary(product)] : [];
  });
  const canonicalProduct = candidate.canonicalProductId
    ? productsById.get(candidate.canonicalProductId)
    : undefined;
  const plannedProductClass =
    selection.request.searchPlan?.productClass ?? selection.request.requiredCategory;
  const profile = resolveProductClassProfile(plannedProductClass, context.profiles);
  const crossGuideReuseGuideIds = candidate.canonicalProductId
    ? context.content.guides
        .filter(
          (guide) =>
            guide.id !== draft?.id &&
            guide.recommendations.some(
              ({ productId: usedProductId }) => usedProductId === candidate.canonicalProductId,
            ),
        )
        .map(({ id }) => id)
        .sort()
    : [];
  const sameObservedNameCandidateIds = allSelections
    .filter(
      ({ request, candidateId: otherCandidateId }) =>
        request.id === selection.request.id &&
        otherCandidateId !== selection.candidateId &&
        normalized(
          request.sourceCandidates.find(({ id }) => id === otherCandidateId)?.name ?? "",
        ) === normalized(candidate.name),
    )
    .map(({ candidateId: id }) => id)
    .sort();
  return fitPromptCandidateSchema.parse({
    requestId: selection.request.id,
    candidateId: candidate.id,
    requestContext: {
      intendedRole: selection.request.intendedRole,
      requiredCategory: selection.request.requiredCategory,
      audience: selection.request.audience,
      occasion: selection.request.occasion,
      budgetContext: selection.request.budgetContext,
      mustHaveVerifiedFacts: selection.request.mustHaveVerifiedFacts,
      exclusions: selection.request.exclusions,
      plannedProductClass,
    },
    providerObservedEvidence: {
      evidenceDomain: "provider-observed",
      sourceKind: candidate.sourceKind,
      provider: candidate.provider,
      name: candidate.name,
      ...(candidate.merchant ? { merchant: candidate.merchant } : {}),
      ...(candidate.domain ? { domain: candidate.domain } : {}),
      sourceFacts: candidate.sourceFacts,
      ...(candidate.observedPrice ? { observedPrice: candidate.observedPrice } : {}),
      ...(candidate.observedRating !== undefined
        ? { observedRating: candidate.observedRating }
        : {}),
      ...(candidate.observedReviewCount !== undefined
        ? { observedReviewCount: candidate.observedReviewCount }
        : {}),
      ...(candidate.observedAt ? { observedAt: candidate.observedAt } : {}),
    },
    ...(canonicalProduct
      ? {
          canonicalProductEvidence: {
            evidenceDomain: "canonical-verified-product",
            productId: canonicalProduct.id,
            name: canonicalProduct.name,
            shortDescription: canonicalProduct.shortDescription,
            verifiedFacts: canonicalProduct.verifiedFacts ?? [],
            categories: canonicalProduct.categories ?? [],
          },
        }
      : {}),
    deterministicEvidence: {
      evidenceDomain: "I.0-deterministic",
      sourceFactCount: candidate.sourceFacts.length,
      hasObservedPrice: candidate.observedPrice !== undefined,
      inGuideCanonicalProductRepeat: Boolean(
        candidate.canonicalProductId && selectedProductIds.has(candidate.canonicalProductId),
      ),
      inGuideSelectedProducts: selectedProducts,
      crossGuideReuseGuideIds,
      sameObservedNameCandidateIds,
    },
    productClassProfile: {
      classId: profile.classId,
      importantAttributes: profile.importantAttributes,
      requiredAttributes: profile.requiredAttributes,
      undesirableAttributes: profile.undesirableAttributes,
      compatibilityRisks: profile.compatibilityRisks,
      giftabilityConsiderations: profile.giftabilityConsiderations,
      maintenanceConsiderations: profile.maintenanceConsiderations,
      evaluationGuidance: profile.evaluationGuidance,
      version: profile.version,
    },
    profileMatch: profile.classId === "generic" ? "generic-fallback" : "specific",
    editorialBenchmarks: matchingBenchmarks(
      context.benchmarks ?? [],
      profile,
      plannedProductClass,
      context.profiles ?? PRODUCT_CLASS_PROFILES,
    ).map((benchmark) => ({
      evidenceDomain: "editor-decision-benchmark",
      benchmarkId: benchmark.id,
      canonicalProductId: benchmark.canonicalProductId,
      productClass: benchmark.productClass,
      audienceTags: benchmark.audienceTags,
      contextTags: benchmark.contextTags,
      editorRationale: benchmark.editorRationale,
      strongFitReasons: benchmark.strongFitReasons,
      attributesOrReasons: benchmark.attributesOrReasons,
      version: benchmark.version,
    })),
  });
}

export function prepareProductFitEvaluationPrompt(
  selections: readonly ProductFitSelection[],
  context: PrepareProductFitContext,
) {
  if (!selections.length) throw new TypeError("Evaluate at least one product candidate.");
  const keys = selections.map(({ request, candidateId: id }) => `${request.id}:${id}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("A product candidate may appear only once in an evaluation batch.");
  }
  const input = productFitPromptInputSchema.parse({
    candidates: selections.map((selection) => promptCandidate(selection, selections, context)),
  });
  const prompt = `Evaluate this batch of product-source candidates as advisory AI interpretation.

Keep every dimension separate. A positive assessment always means favorable fit; for risk/repetition dimensions it means low or well-controlled risk, while negative means a material concern. Use unknown whenever the supplied evidence does not support a conclusion. Budget compatibility and perceived value must be unknown without usable price/band evidence. Provider-observed evidence remains observed evidence and must never be promoted to a verified Product fact. ProductClassProfile requirements identify evidence to look for; they do not prove an attribute. Editorial benchmarks are concise editor-controlled examples, not training data, selection instructions, or ranking boosts.

Evaluate: product class match; slot specificity; Guide relevance; recipient fit; occasion/career-stage/work-context fit; supported budget compatibility; practical usefulness; gift desirability; giftability/presentation; ease of choosing; compatibility/selection risk; perceived value; emotional relevance; evidence quality; maintenance risk; commercial suitability; catalog reuse opportunity; in-Guide distinctiveness; redundancy; repeated Product class; and repeated functional role. Keep in-Guide repetition separate from cross-Guide reuse. Do not calculate a total, name a winner, select/reject/canonicalize a Product, fulfill a request, assign a slot, or invent any fact.

diagnosticSummary must make later diagnosis possible: provider result quality, possible SearchPlan/class mismatch, specific-profile versus generic-fallback coverage, and confidence in this fit interpretation. missingEvidence lists facts still requiring observation or editor verification.

Return exactly one JSON object matching the supplied strict response schema, one evaluation for every requestId/candidateId pair and no additional fields.

Use exactly this response shape. Repeat the evaluation object once for every input pair, copy each pair's IDs exactly, and replace every placeholder. For assessment, choose exactly one listed enum value rather than copying the pipe-separated example:
${JSON.stringify(productFitResponseShapeExample, null, 2)}

Evaluation input:
${JSON.stringify(input, null, 2)}`;
  return { version: PRODUCT_FIT_PROMPT_VERSION, input, prompt };
}

const neutralDimension = (rationale: string) => ({ assessment: "neutral" as const, rationale });
const unknownDimension = (rationale: string) => ({ assessment: "unknown" as const, rationale });

export function mockProductFitEvaluation(input: ProductFitPromptInput): ProductFitEvaluationBatch {
  return productFitEvaluationBatchSchema.parse({
    batchSynthesis:
      "The batch preserves separate fit, gift-value, evidence, and collection signals for editor review.",
    evaluations: input.candidates.map((candidate) => {
      const providerEvidence = candidate.providerObservedEvidence;
      const deterministic = candidate.deterministicEvidence;
      const profileFallback = candidate.profileMatch === "generic-fallback";
      return {
        requestId: candidate.requestId,
        candidateId: candidate.candidateId,
        interpretedProductClass: candidate.requestContext.plannedProductClass,
        editorialFunctionalFit: {
          productClassMatch: neutralDimension(
            "The observed name is plausible but needs editor review.",
          ),
          slotSpecificity: neutralDimension(
            "The candidate is evaluated against the explicit slot.",
          ),
          guideRelevance: neutralDimension("The supplied Guide context is relevant but advisory."),
          recipientFit: neutralDimension("No recipient preference is verified."),
          contextFit: neutralDimension("The stated occasion and work context were considered."),
          budgetCompatibility: providerEvidence.observedPrice
            ? neutralDimension("An observed price exists but still requires current verification.")
            : unknownDimension("No observed price supports a budget comparison."),
        },
        consumerGiftValue: {
          practicalUsefulness: neutralDimension("Usefulness depends on the exact observed item."),
          giftDesirability: neutralDimension("Gift desirability remains an editorial judgment."),
          giftabilityPresentation: unknownDimension("Presentation evidence was not supplied."),
          easeOfChoosingCorrectly: neutralDimension("Selection criteria remain visible."),
          compatibilitySelectionRisk: neutralDimension(
            "Profile compatibility risks need checking.",
          ),
          perceivedValue: providerEvidence.observedPrice
            ? neutralDimension("Observed price allows review but not a verified value claim.")
            : unknownDimension("No price evidence supports perceived value."),
          emotionalRelevanceMemorability: unknownDimension(
            "No candidate-specific emotional evidence was supplied.",
          ),
        },
        evidenceOperations: {
          evidenceQuality: providerEvidence.sourceFacts.length
            ? neutralDimension("Provider observations exist but are not verified Product facts.")
            : unknownDimension("The provider supplied no source facts."),
          maintenanceRisk: neutralDimension("Commercial details require later rechecking."),
          commercialSuitability: neutralDimension("Commercial suitability needs editor review."),
          existingCatalogReuseOpportunity: candidate.canonicalProductEvidence
            ? { assessment: "positive", rationale: "A linked canonical Product is visible." }
            : neutralDimension("No linked canonical Product establishes a reuse opportunity."),
        },
        collectionQuality: {
          inGuideDistinctiveness: deterministic.inGuideCanonicalProductRepeat
            ? {
                assessment: "negative",
                rationale: "The same canonical Product is already in-Guide.",
              }
            : neutralDimension("No exact in-Guide Product repetition is visible."),
          redundancyWithCurrentSelections: neutralDimension(
            "Functional overlap needs comparison with current selections.",
          ),
          repeatedProductClass: neutralDimension("Class repetition requires contextual review."),
          repeatedFunctionalRole: neutralDimension("Functional-role repetition requires review."),
        },
        missingEvidence: providerEvidence.sourceFacts.length
          ? ["Verify candidate attributes before canonical intake."]
          : ["Provider result has no observed source facts.", "Verify attributes before intake."],
        diagnosticSummary: {
          providerResultQuality: providerEvidence.sourceFacts.length
            ? "Observed source evidence is present but unverified."
            : "Provider result quality is limited by missing source facts.",
          searchPlanOrClassRisk: "Confirm the planned class against the exact candidate.",
          profileCoverage: profileFallback
            ? "The generic fallback profile was used."
            : `Specific profile ${candidate.productClassProfile.classId} v${candidate.productClassProfile.version} was used.`,
          fitConfidence: "Mock evaluation is intentionally neutral and requires editor review.",
        },
      };
    }),
  });
}

const dimensionPaths = {
  critical: [
    "editorialFunctionalFit.productClassMatch",
    "editorialFunctionalFit.slotSpecificity",
    "editorialFunctionalFit.guideRelevance",
    "evidenceOperations.evidenceQuality",
  ],
  corePositive: [
    "editorialFunctionalFit.productClassMatch",
    "editorialFunctionalFit.guideRelevance",
    "consumerGiftValue.practicalUsefulness",
    "consumerGiftValue.giftDesirability",
    "evidenceOperations.evidenceQuality",
    "collectionQuality.inGuideDistinctiveness",
  ],
  collectionConcern: [
    "collectionQuality.inGuideDistinctiveness",
    "collectionQuality.redundancyWithCurrentSelections",
    "collectionQuality.repeatedProductClass",
    "collectionQuality.repeatedFunctionalRole",
  ],
} as const;

export const PRODUCT_FIT_RANKING_POLICY_V1 = {
  version: PRODUCT_FIT_RANKING_POLICY_VERSION,
  precedence: [
    "fewer negative critical dimensions",
    "more positive core dimensions",
    "fewer negative collection dimensions",
    "fewer unknown dimensions",
    "stable request/candidate ID tie-break",
  ],
  dimensionPaths,
  automaticWinner: false,
  totalScore: false,
} as const;

function allDimensions(evaluation: ProductFitEvaluation) {
  return [
    ...Object.values(evaluation.editorialFunctionalFit),
    ...Object.values(evaluation.consumerGiftValue),
    ...Object.values(evaluation.evidenceOperations),
    ...Object.values(evaluation.collectionQuality),
  ];
}

function dimensionAt(
  evaluation: ProductFitEvaluation,
  path: string,
): z.infer<typeof productFitDimensionSchema> {
  const [group, dimension] = path.split(".") as [
    keyof Pick<
      ProductFitEvaluation,
      "editorialFunctionalFit" | "consumerGiftValue" | "evidenceOperations" | "collectionQuality"
    >,
    string,
  ];
  return (evaluation[group] as Record<string, z.infer<typeof productFitDimensionSchema>>)[
    dimension
  ]!;
}

export const productFitOrderingSignalsSchema = z.strictObject({
  negativeCriticalDimensions: z.number().int().nonnegative(),
  positiveCoreDimensions: z.number().int().nonnegative(),
  negativeCollectionDimensions: z.number().int().nonnegative(),
  unknownDimensions: z.number().int().nonnegative(),
});

export function productFitOrderingSignals(evaluation: ProductFitEvaluation) {
  return productFitOrderingSignalsSchema.parse({
    negativeCriticalDimensions: dimensionPaths.critical.filter(
      (path) => dimensionAt(evaluation, path).assessment === "negative",
    ).length,
    positiveCoreDimensions: dimensionPaths.corePositive.filter(
      (path) => dimensionAt(evaluation, path).assessment === "positive",
    ).length,
    negativeCollectionDimensions: dimensionPaths.collectionConcern.filter(
      (path) => dimensionAt(evaluation, path).assessment === "negative",
    ).length,
    unknownDimensions: allDimensions(evaluation).filter(
      ({ assessment }) => assessment === "unknown",
    ).length,
  });
}

export function orderProductFitEvaluations(
  evaluations: readonly ProductFitEvaluation[],
): ProductFitEvaluation[] {
  return [...evaluations].sort((left, right) => {
    const a = productFitOrderingSignals(left);
    const b = productFitOrderingSignals(right);
    return (
      a.negativeCriticalDimensions - b.negativeCriticalDimensions ||
      b.positiveCoreDimensions - a.positiveCoreDimensions ||
      a.negativeCollectionDimensions - b.negativeCollectionDimensions ||
      a.unknownDimensions - b.unknownDimensions ||
      `${left.requestId}:${left.candidateId}`.localeCompare(
        `${right.requestId}:${right.candidateId}`,
      )
    );
  });
}

const providerUsageSchema = z.strictObject({
  requestId: nonEmptyText.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export const productFitEvaluationSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordType: z.literal("product-fit-evaluation"),
  id: safeId.regex(/^fit_evaluation_/),
  candidateRefs: z.array(z.strictObject({ requestId, candidateId })).min(1).max(40),
  input: productFitPromptInputSchema,
  aiInterpretation: productFitEvaluationBatchSchema,
  ordering: z.array(
    z.strictObject({
      requestId,
      candidateId,
      signals: productFitOrderingSignalsSchema,
    }),
  ),
  providerId: nonEmptyText,
  modelId: nonEmptyText.optional(),
  providerCallCount: z.literal(1),
  candidateCount: z.number().int().positive().max(40),
  providerUsage: providerUsageSchema.optional(),
  promptVersion: z.literal(PRODUCT_FIT_PROMPT_VERSION),
  rankingPolicyVersion: z.literal(PRODUCT_FIT_RANKING_POLICY_VERSION),
  prompt: nonEmptyText,
  evaluatedAt: timestamp,
});

export type ProductFitEvaluationSession = z.infer<typeof productFitEvaluationSessionSchema>;

function usefulUsage(metadata: ProviderCallMetadata | undefined) {
  if (!metadata) return undefined;
  const usage = providerUsageSchema.parse(metadata);
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}

const productFitEvaluationTransportSchema = z
  .object({
    batchSynthesis: z.unknown().optional(),
    evaluations: z.array(z.unknown()).max(40).optional(),
  })
  .passthrough();

const looseEvaluationIdentitySchema = z.object({ candidateId: z.string() }).passthrough();

export interface ProductFitEvaluationAttempt {
  session?: ProductFitEvaluationSession;
  failures: ProductFitEvaluationFailure[];
  malformedResultCount: number;
  providerError?: unknown;
}

function failureCodeForProviderError(error: unknown): ProductFitEvaluationFailureCode {
  if (!(error instanceof ProviderError)) return "provider-failure";
  if (error.code === "invalid-schema") return "schema-invalid-result";
  if (
    error.code === "empty-response" ||
    error.code === "invalid-json" ||
    error.code === "invalid-response" ||
    error.code === "truncated"
  ) {
    return "malformed-result";
  }
  return "provider-failure";
}

export async function evaluateProductFitBatchAttempt(
  selections: readonly ProductFitSelection[],
  context: PrepareProductFitContext & { provider: GuideGenerationProvider; now?: Date },
): Promise<ProductFitEvaluationAttempt> {
  const prepared = prepareProductFitEvaluationPrompt(selections, context);
  let response: z.infer<typeof productFitEvaluationTransportSchema>;
  try {
    response = await context.provider.generateStructured({
      operation: "product-fit-evaluations",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: productFitEvaluationTransportSchema,
      mockResponse: () => mockProductFitEvaluation(prepared.input),
    });
  } catch (providerError) {
    const code = failureCodeForProviderError(providerError);
    return {
      failures: prepared.input.candidates.map((candidate) => ({
        requestId: candidate.requestId,
        candidateId: candidate.candidateId,
        code,
      })),
      malformedResultCount: 0,
      providerError,
    };
  }

  const expectedCandidateIds = new Set(
    prepared.input.candidates.map((candidate) => candidate.candidateId),
  );
  const rawEvaluations = Array.isArray(response.evaluations) ? response.evaluations : [];
  const byCandidateId = new Map<string, unknown[]>();
  let malformedResultCount = Array.isArray(response.evaluations) ? 0 : 1;
  for (const raw of rawEvaluations) {
    const identity = looseEvaluationIdentitySchema.safeParse(raw);
    if (!identity.success || !expectedCandidateIds.has(identity.data.candidateId)) {
      malformedResultCount++;
      continue;
    }
    const grouped = byCandidateId.get(identity.data.candidateId) ?? [];
    grouped.push(raw);
    byCandidateId.set(identity.data.candidateId, grouped);
  }

  const evaluations: ProductFitEvaluation[] = [];
  const failures: ProductFitEvaluationFailure[] = [];
  for (const expected of prepared.input.candidates) {
    const raw = byCandidateId.get(expected.candidateId) ?? [];
    if (!raw.length) {
      failures.push({
        requestId: expected.requestId,
        candidateId: expected.candidateId,
        code: "missing-result",
      });
      continue;
    }
    if (raw.length !== 1) {
      failures.push({
        requestId: expected.requestId,
        candidateId: expected.candidateId,
        code: "malformed-result",
      });
      continue;
    }
    const parsed = productFitEvaluationSchema.safeParse(raw[0]);
    if (!parsed.success || parsed.data.requestId !== expected.requestId) {
      failures.push({
        requestId: expected.requestId,
        candidateId: expected.candidateId,
        code: "schema-invalid-result",
      });
      continue;
    }
    evaluations.push(parsed.data);
  }

  const synthesis = nonEmptyText.safeParse(response.batchSynthesis);
  if (!synthesis.success) malformedResultCount++;
  if (!evaluations.length) return { failures, malformedResultCount };

  const validKeys = new Set(
    evaluations.map((evaluation) => evaluation.requestId + ":" + evaluation.candidateId),
  );
  const input = productFitPromptInputSchema.parse({
    candidates: prepared.input.candidates.filter((candidate) =>
      validKeys.has(candidate.requestId + ":" + candidate.candidateId),
    ),
  });
  const aiInterpretation = productFitEvaluationBatchSchema.parse({
    batchSynthesis: synthesis.success
      ? synthesis.data
      : "Valid candidate evaluations preserved from a partial provider response.",
    evaluations,
  });
  const ordered = orderProductFitEvaluations(aiInterpretation.evaluations);
  const providerUsage = usefulUsage(context.provider.lastCallMetadata);
  return {
    session: productFitEvaluationSessionSchema.parse({
      schemaVersion: 1,
      recordType: "product-fit-evaluation",
      id: `fit_evaluation_${randomUUID()}`,
      candidateRefs: input.candidates.map((candidate) => ({
        requestId: candidate.requestId,
        candidateId: candidate.candidateId,
      })),
      input,
      aiInterpretation,
      ordering: ordered.map((evaluation) => ({
        requestId: evaluation.requestId,
        candidateId: evaluation.candidateId,
        signals: productFitOrderingSignals(evaluation),
      })),
      providerId: context.provider.providerId,
      ...(context.provider.modelId ? { modelId: context.provider.modelId } : {}),
      providerCallCount: 1,
      candidateCount: input.candidates.length,
      ...(providerUsage ? { providerUsage } : {}),
      promptVersion: prepared.version,
      rankingPolicyVersion: PRODUCT_FIT_RANKING_POLICY_VERSION,
      prompt: prepared.prompt,
      evaluatedAt: (context.now ?? new Date()).toISOString(),
    }),
    failures,
    malformedResultCount,
  };
}

export async function evaluateProductFitBatch(
  selections: readonly ProductFitSelection[],
  context: PrepareProductFitContext & { provider: GuideGenerationProvider; now?: Date },
): Promise<ProductFitEvaluationSession> {
  const attempt = await evaluateProductFitBatchAttempt(selections, context);
  if (attempt.providerError) throw attempt.providerError;
  if (attempt.failures.length || attempt.malformedResultCount || !attempt.session) {
    throw new ProviderError(
      "La respuesta del proveedor no evaluó cada candidato exactamente una vez.",
      "invalid-schema",
    );
  }
  return attempt.session;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function productFitEvaluationPath(repositoryRoot: string, id: string): string {
  productFitEvaluationSessionSchema.shape.id.parse(id);
  return resolve(repositoryRoot, PRODUCT_FIT_EVALUATIONS_DIRECTORY, `${id}.json`);
}

export class ProductFitEvaluationStore {
  readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(): ProductFitEvaluationSession[] {
    const directory = resolve(this.repositoryRoot, PRODUCT_FIT_EVALUATIONS_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = relative(this.repositoryRoot, resolve(directory, entry.name)).replaceAll(
          "\\",
          "/",
        );
        const parsed = productFitEvaluationSessionSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) {
          throw new TypeError(
            `Invalid product fit evaluation "${file}": ${validationMessage(parsed.error)}`,
          );
        }
        if (`${parsed.data.id}.json` !== entry.name) {
          throw new TypeError(`Invalid product fit evaluation "${file}": id must match filename.`);
        }
        return parsed.data;
      })
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt));
  }

  latestForCandidate(request: string, candidate: string): ProductFitEvaluationSession | undefined {
    requestId.parse(request);
    candidateId.parse(candidate);
    return this.list().find(({ candidateRefs }) =>
      candidateRefs.some(
        ({ requestId: storedRequest, candidateId: storedCandidate }) =>
          storedRequest === request && storedCandidate === candidate,
      ),
    );
  }

  async save(session: ProductFitEvaluationSession): Promise<void> {
    const parsed = productFitEvaluationSessionSchema.parse(session);
    await atomicWriteJson(productFitEvaluationPath(this.repositoryRoot, parsed.id), parsed);
  }
}
