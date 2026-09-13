import { randomUUID } from "node:crypto";

import {
  productDestination,
  type Product,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import type { DraftStore } from "../../draft-store.ts";
import { guideDraftSchema, type GuideDraft } from "../../drafts.ts";
import {
  SAFE_IDEA_COPY_VERSION,
  applyDeterministicProductCopyFallback,
  formatGenerationContractDiagnostic,
  generateIdeaOnlyRecommendationWithRecovery,
  generateProductBackedRecommendationWithRecovery,
  ideaOnlyCopyHasUnsupportedClaims,
  ideaOnlyEditorialContext,
  recommendationCopyFailureDiagnostics,
  recommendationIsEditoriallyReady,
} from "../../guide-editor.ts";
import type { ProductCatalog } from "../../product-catalog.ts";
import {
  extractAmazonAsin,
  isApprovedAmazonUsHost,
  normalizeAmazonAsin,
} from "../affiliate-operations/amazon.ts";
import {
  DEFAULT_PRODUCT_DISCOVERY_LIMITS,
  productDiscoverySourceSupportsMode,
  runProductDiscovery,
  type ProductDiscoverySource,
} from "../product-sources/discovery.ts";
import {
  createProductSourceId,
  isGoogleShoppingIntermediaryUrl,
  productSourceRecordSchema,
  type ProductSourceRecord,
  type ProductSourceStore,
} from "../product-sources/records.ts";
import type { EditorialBenchmark } from "./benchmarks.ts";
import { generateProductEditorialCopy } from "./editorial-copy.ts";
import {
  PRODUCT_FIT_EVALUATION_FAILURE_CODES,
  evaluateProductFitBatchAttempt,
  orderProductFitEvaluations,
  productFitOrderingSignals,
  type ProductFitEvaluation,
  type ProductFitEvaluationFailure,
  type ProductFitEvaluationStore,
} from "./fit.ts";
import { commitManualProductIntake, prepareManualProductIntake } from "./intake.ts";
import {
  completeProductSourcingRequestAsIdeaOnly,
  createProductSourcingRequestForDraftSlot,
  findProductSourcingRequestForDraftSlot,
  assertProductSourcingOrigin,
  productSourcingRequestSchema,
  productSourcingRequestIsActive,
  selectCanonicalProductForRequest,
  assignSourcedProductToDraftSlot,
  catalogMatchesForRequest,
  type ProductSourceCandidate,
  type ProductSourcingRequest,
  type ProductSourcingRequestStore,
} from "./sourcing.ts";

export const AUTOPILOT_POLICY_VERSION = "single-slot-autopilot-v3";
export const AUTOPILOT_LIMITS = {
  maxDiscoveryCalls: 2,
  maxDiscoveryRounds: 2,
  maxCandidatesPerEvaluation: 8,
  maxCatalogCandidates: 4,
  maxP2ProviderCalls: 2,
  maxP2RecoveryCalls: 1,
} as const;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const candidateEvaluationFailureCodeSchema = z.enum(PRODUCT_FIT_EVALUATION_FAILURE_CODES);
const candidateEvaluationStatusSchema = z.enum(["valid", ...PRODUCT_FIT_EVALUATION_FAILURE_CODES]);
const autopilotReasonCodeSchema = z.enum([
  "product-selected",
  "no-candidate-passed-product-gate",
  "amazon-no-candidates",
  "amazon-provider-configuration",
  "amazon-provider-quota",
  "amazon-provider-timeout",
  "amazon-provider-unavailable",
  "amazon-provider-malformed",
  "amazon-discovery-unavailable",
  "evaluation-infrastructure-failed",
  "product-resolution-failed",
  "safe-terminal-write-failed",
  "no-trustworthy-product",
]);

type AutopilotReasonCode = z.infer<typeof autopilotReasonCodeSchema>;

const reasonExplanations: Record<AutopilotReasonCode, string> = {
  "product-selected": "Un candidato superó el gate automático P.2 y fue asignado como Product.",
  "no-candidate-passed-product-gate":
    "Se evaluaron candidatos, pero ninguno superó todos los controles obligatorios del gate P.2.",
  "amazon-no-candidates":
    "La búsqueda acotada en Amazon terminó sin devolver candidatos evaluables.",
  "amazon-provider-configuration":
    "La búsqueda en Amazon no pudo ejecutarse porque la configuración del proveedor era inválida.",
  "amazon-provider-quota":
    "La búsqueda en Amazon se detuvo porque no había cuota disponible del proveedor.",
  "amazon-provider-timeout":
    "La búsqueda en Amazon agotó el tiempo de espera antes de devolver candidatos utilizables.",
  "amazon-provider-unavailable":
    "La búsqueda en Amazon falló porque el proveedor configurado no estaba disponible.",
  "amazon-provider-malformed":
    "La búsqueda en Amazon devolvió datos inválidos y no fue seguro seleccionar un Product.",
  "amazon-discovery-unavailable":
    "No había un proveedor habilitado para buscar en Amazon tras revisar catálogo y candidatos existentes.",
  "evaluation-infrastructure-failed":
    "La llamada al proveedor P.2 o la validación de su respuesta falló; ningún candidato se trató como evaluado.",
  "product-resolution-failed":
    "Un candidato superó P.2, pero no se pudo guardar con seguridad el Product canónico o su asignación al slot exacto.",
  "safe-terminal-write-failed":
    "Autopilot no pudo persistir ni siquiera el resultado terminal seguro como idea.",
  "no-trustworthy-product":
    "Ningún candidato aportó evidencia suficiente para resolver un Product de forma segura.",
};

export const autopilotResolutionOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(AUTOPILOT_POLICY_VERSION),
  status: z.enum(["resolved-product", "resolved-idea-only", "failed"]),
  reasonCode: autopilotReasonCodeSchema,
  reasonExplanation: nonEmptyText,
  recommendationId: safeId,
  slotId: safeId,
  sourcingRequestId: safeId.regex(/^request_/),
  productId: safeId.optional(),
  candidateId: safeId.regex(/^source_candidate_/).optional(),
  resolutionStrategy: z.enum([
    "catalog-reuse",
    "existing-candidate",
    "amazon-discovery",
    "idea-only",
    "failed",
  ]),
  candidatePassedBecause: z.array(nonEmptyText),
  productNotUsedBecause: z.array(nonEmptyText),
  discoveryAttempts: z
    .array(
      z.strictObject({
        round: z.number().int().min(1).max(AUTOPILOT_LIMITS.maxDiscoveryRounds),
        provider: nonEmptyText,
        mode: z.literal("amazon"),
        status: nonEmptyText,
        providerCalls: z.number().int().nonnegative().max(1),
        storedCandidateCount: z.number().int().nonnegative(),
        returnedCandidateCount: z.number().int().nonnegative(),
        reusedCandidateCount: z.number().int().nonnegative(),
        failureCode: z
          .enum(["configuration", "quota", "timeout", "unavailable", "malformed"])
          .optional(),
      }),
    )
    .max(AUTOPILOT_LIMITS.maxDiscoveryRounds),
  executionEvidence: z.strictObject({
    catalogReuseAttempted: z.boolean(),
    catalogReuseResult: z.enum([
      "product-reused",
      "candidate-not-selected",
      "no-suitable-candidate",
    ]),
    catalogCandidatesConsidered: z.number().int().nonnegative(),
    recentSourceCandidatesConsidered: z.number().int().nonnegative(),
    amazonDiscoveryAttempted: z.boolean(),
    providerCallCount: z.number().int().nonnegative().max(AUTOPILOT_LIMITS.maxDiscoveryCalls),
    candidatesReturned: z.number().int().nonnegative(),
    candidatesEvaluated: z.number().int().nonnegative(),
    p2ProviderCallCount: z.number().int().nonnegative().max(AUTOPILOT_LIMITS.maxP2ProviderCalls),
    p2RecoveryAttempted: z.boolean(),
    candidatesRecovered: z.number().int().nonnegative(),
    p2Attempts: z
      .array(
        z.strictObject({
          kind: z.enum(["primary", "recovery"]),
          candidatesSent: z.number().int().positive(),
          candidatesEvaluated: z.number().int().nonnegative(),
          candidatesFailed: z.number().int().nonnegative(),
          unmappedMalformedResults: z.number().int().nonnegative(),
          candidateResults: z.array(
            z.strictObject({
              candidateId: safeId.regex(/^source_candidate_/),
              status: candidateEvaluationStatusSchema,
            }),
          ),
        }),
      )
      .max(AUTOPILOT_LIMITS.maxP2ProviderCalls),
    candidateEvaluationFailures: z.array(
      z.strictObject({
        candidateId: safeId.regex(/^source_candidate_/),
        name: nonEmptyText,
        reasonCode: candidateEvaluationFailureCodeSchema,
      }),
    ),
    bestCandidate: z
      .strictObject({
        candidateId: safeId.regex(/^source_candidate_/),
        name: nonEmptyText,
        p2GateFailures: z.array(nonEmptyText),
      })
      .optional(),
    searchRefinementAttempted: z.boolean(),
    discoveryRecoveryAttempted: z.boolean(),
    recoveryUsed: z.boolean(),
    sourcingBudgetExhausted: z.boolean(),
  }),
  affiliateDestinationStatus: z.enum([
    "available",
    "affiliate-destination-missing",
    "not-applicable",
  ]),
  actionsPerformed: z.array(nonEmptyText),
  warnings: z.array(nonEmptyText),
});

export type AutopilotResolutionOutcome = z.infer<typeof autopilotResolutionOutcomeSchema>;

export interface AutopilotDependencies {
  draftStore: DraftStore;
  catalog: ProductCatalog;
  sourcingStore: ProductSourcingRequestStore;
  sourceStore: ProductSourceStore;
  fitStore: ProductFitEvaluationStore;
  provider: GuideGenerationProvider;
  discoverySource?: ProductDiscoverySource | undefined;
  benchmarks?: readonly EditorialBenchmark[] | undefined;
}

export interface AutopilotOptions {
  now?: Date | undefined;
}

interface P2Diagnostics {
  providerCallCount: number;
  recoveryAttempted: boolean;
  candidatesRecovered: number;
  attempts: AutopilotResolutionOutcome["executionEvidence"]["p2Attempts"];
  failures: Map<string, ProductFitEvaluationFailure>;
}

export interface AutomaticCandidateAssessment {
  accepted: boolean;
  passedBecause: string[];
  rejectedBecause: string[];
}

export interface AutomaticCandidateChoice {
  candidate?: ProductSourceCandidate | undefined;
  evaluation?: ProductFitEvaluation | undefined;
  passedBecause: string[];
  rejectedBecause: string[];
}

const requiredPositiveDimensions = [
  ["editorialFunctionalFit", "productClassMatch"],
  ["editorialFunctionalFit", "slotSpecificity"],
  ["editorialFunctionalFit", "guideRelevance"],
  ["consumerGiftValue", "practicalUsefulness"],
  ["consumerGiftValue", "giftDesirability"],
  ["evidenceOperations", "evidenceQuality"],
] as const;

const hardStopDimensions = [
  ...requiredPositiveDimensions,
  ["consumerGiftValue", "compatibilitySelectionRisk"],
  ["evidenceOperations", "commercialSuitability"],
  ["collectionQuality", "inGuideDistinctiveness"],
  ["collectionQuality", "redundancyWithCurrentSelections"],
  ["collectionQuality", "repeatedProductClass"],
  ["collectionQuality", "repeatedFunctionalRole"],
] as const;

function normalized(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function assertExactSlotRequest(
  request: ProductSourcingRequest,
  draft: GuideDraft,
  slotId: string,
): void {
  assertProductSourcingOrigin(request.origin, { drafts: [draft] });
  if (
    request.origin.kind !== "recommendation-slot" ||
    request.origin.guideDraftId !== draft.id ||
    request.origin.recommendationSlotId !== slotId
  ) {
    throw new TypeError("Autopilot sourcing context does not belong to the exact target slot.");
  }
}

function dimension(
  evaluation: ProductFitEvaluation,
  path: (typeof hardStopDimensions)[number],
): { assessment: "positive" | "neutral" | "negative" | "unknown"; rationale: string } {
  const [group, name] = path;
  return (
    evaluation[group] as Record<
      string,
      { assessment: "positive" | "neutral" | "negative" | "unknown"; rationale: string }
    >
  )[name]!;
}

function candidateIsAmazon(candidate: ProductSourceCandidate): boolean {
  return (
    candidate.discoveryMode === "amazon" ||
    candidate.marketplace?.toLocaleLowerCase("en-US") === "amazon.com" ||
    Boolean(candidate.productUrl && isApprovedAmazonUsHost(candidate.productUrl))
  );
}

function candidateHasIdentity(candidate: ProductSourceCandidate): boolean {
  if (candidate.canonicalProductId && candidate.productSourceId) return true;
  if (candidate.sourceKind !== "serpapi" && candidate.sourceKind !== "dataforseo") return false;
  if (!candidate.sourceUrl || !candidate.observedAt || !candidate.sourceFacts.length) return false;
  if (candidateIsAmazon(candidate)) {
    const asin = candidate.externalId
      ? normalizeAmazonAsin(candidate.externalId)
      : extractAmazonAsin(candidate.productUrl ?? candidate.sourceUrl);
    return Boolean(
      asin &&
      candidate.productUrl &&
      isApprovedAmazonUsHost(candidate.productUrl) &&
      extractAmazonAsin(candidate.productUrl) === asin,
    );
  }
  return Boolean(candidate.merchant && (candidate.productUrl || candidate.externalId));
}

function exactExclusions(
  request: ProductSourcingRequest,
  candidate: ProductSourceCandidate,
): string[] {
  const evidence = normalized([candidate.name, ...candidate.sourceFacts].join(" "));
  return request.exclusions.filter((exclusion) => {
    const phrase = normalized(exclusion);
    return phrase.length >= 3 && evidence.includes(phrase);
  });
}

export function assessAutomaticProductCandidate(
  request: ProductSourcingRequest,
  candidate: ProductSourceCandidate,
  evaluation: ProductFitEvaluation,
  content: ValidatedPublicContent,
): AutomaticCandidateAssessment {
  if (evaluation.requestId !== request.id || evaluation.candidateId !== candidate.id) {
    throw new TypeError("The Product evaluation does not belong to this sourcing candidate.");
  }
  const rejectedBecause: string[] = [];
  const canonicalProduct = candidate.canonicalProductId
    ? content.products.find(({ id }) => id === candidate.canonicalProductId)
    : undefined;
  if (!candidateHasIdentity(candidate)) rejectedBecause.push("insufficient-product-identity");
  if (candidate.canonicalProductId && !canonicalProduct) {
    rejectedBecause.push("canonical-product-missing");
  }
  const missingRequiredFacts = request.mustHaveVerifiedFacts.filter(
    (required) =>
      !canonicalProduct?.verifiedFacts?.some((fact) => normalized(fact) === normalized(required)),
  );
  if (missingRequiredFacts.length) rejectedBecause.push("required-verified-facts-missing");
  if (exactExclusions(request, candidate).length) rejectedBecause.push("hard-exclusion-observed");
  for (const path of hardStopDimensions) {
    if (dimension(evaluation, path).assessment === "negative") {
      rejectedBecause.push(`negative-${path.join("-")}`);
    }
  }
  for (const path of requiredPositiveDimensions) {
    if (dimension(evaluation, path).assessment !== "positive") {
      rejectedBecause.push(`not-positive-${path.join("-")}`);
    }
  }
  const passedBecause =
    rejectedBecause.length === 0
      ? [
          "defensible-product-identity",
          "strong-product-class-and-slot-fit",
          "positive-functional-and-gift-value",
          "sufficient-evidence-quality",
          "no-hard-exclusion-or-collection-conflict",
        ]
      : [];
  return { accepted: rejectedBecause.length === 0, passedBecause, rejectedBecause };
}

function substantiveOrderingDifference(
  winner: ProductFitEvaluation,
  runnerUp: ProductFitEvaluation,
): boolean {
  const left = productFitOrderingSignals(winner);
  const right = productFitOrderingSignals(runnerUp);
  return (
    left.negativeCriticalDimensions !== right.negativeCriticalDimensions ||
    left.positiveCoreDimensions !== right.positiveCoreDimensions ||
    left.negativeCollectionDimensions !== right.negativeCollectionDimensions ||
    left.unknownDimensions !== right.unknownDimensions
  );
}

export function chooseAutomaticProductCandidate(
  request: ProductSourcingRequest,
  evaluations: readonly ProductFitEvaluation[],
  content: ValidatedPublicContent,
): AutomaticCandidateChoice {
  const candidates = new Map(
    request.sourceCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const assessed = evaluations.flatMap((evaluation) => {
    const candidate = candidates.get(evaluation.candidateId);
    if (!candidate || candidate.status === "rejected") return [];
    return [
      {
        candidate,
        evaluation,
        assessment: assessAutomaticProductCandidate(request, candidate, evaluation, content),
      },
    ];
  });
  const accepted = orderProductFitEvaluations(
    assessed.filter(({ assessment }) => assessment.accepted).map(({ evaluation }) => evaluation),
  );
  if (!accepted.length) {
    return {
      passedBecause: [],
      rejectedBecause: unique(
        assessed.flatMap(({ assessment }) => assessment.rejectedBecause).length
          ? assessed.flatMap(({ assessment }) => assessment.rejectedBecause)
          : ["no-evaluable-candidate"],
      ),
    };
  }
  const winner = accepted[0]!;
  if (accepted[1] && !substantiveOrderingDifference(winner, accepted[1])) {
    return {
      passedBecause: [],
      rejectedBecause: ["ambiguous-candidates-without-clear-winner"],
    };
  }
  const selected = assessed.find(
    ({ evaluation }) => evaluation.candidateId === winner.candidateId,
  )!;
  return {
    candidate: selected.candidate,
    evaluation: winner,
    passedBecause: selected.assessment.passedBecause,
    rejectedBecause: [],
  };
}

function candidateKind(source: ProductSourceRecord): ProductSourceCandidate["sourceKind"] {
  if (source.sourceKind === "serpapi" || source.sourceKind === "dataforseo") {
    return source.sourceKind;
  }
  if (source.sourceKind === "amazon-creators-api") return "amazon-creators-api";
  return "manual";
}

function attachCatalogCandidates(
  request: ProductSourcingRequest,
  content: ValidatedPublicContent,
  sources: readonly ProductSourceRecord[],
  now: Date,
): ProductSourcingRequest {
  const candidates = [...request.sourceCandidates];
  for (const product of catalogMatchesForRequest(
    request,
    content.products,
    AUTOPILOT_LIMITS.maxCatalogCandidates,
  )) {
    const source = sources.find(
      (record) => record.productId === product.id && record.sourceStatus === "active",
    );
    if (!source) continue;
    const existing = candidates.find(
      (candidate) =>
        candidate.status !== "rejected" &&
        (candidate.productSourceId === source.id ||
          (candidate.provider === source.provider &&
            candidate.marketplace === source.marketplace &&
            candidate.externalId === source.externalId)),
    );
    const linked = {
      ...(existing ?? {
        id: `source_candidate_${randomUUID()}`,
        sourceKind: candidateKind(source),
        provider: source.provider,
        ...(source.marketplace ? { marketplace: source.marketplace } : {}),
        ...(source.externalId ? { externalId: source.externalId } : {}),
        ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
        ...(product.productUrl ? { productUrl: product.productUrl } : {}),
        ...(product.brand ? { brand: product.brand } : {}),
        merchant: product.merchant,
        name: product.name,
        sourceFacts: source.sourceFacts ?? [],
        addedAt: now.toISOString(),
      }),
      status: "linked-to-product" as const,
      canonicalProductId: product.id,
      productSourceId: source.id,
      reviewedAt: existing?.reviewedAt ?? now.toISOString(),
    };
    if (existing) candidates[candidates.indexOf(existing)] = linked;
    else candidates.push(linked);
  }
  return productSourcingRequestSchema.parse({
    ...request,
    sourceCandidates: candidates,
    updatedAt:
      candidates.length === request.sourceCandidates.length ? request.updatedAt : now.toISOString(),
  });
}

function fallbackSearchPlan(request: ProductSourcingRequest, now: Date): ProductSourcingRequest {
  return productSourcingRequestSchema.parse({
    ...request,
    searchPlan: {
      productClass: request.requiredCategory,
      mustHaveAttributes: request.mustHaveVerifiedFacts.slice(0, 10),
      usefulAttributes: request.searchTerms.slice(0, 10),
      exclusions: request.exclusions.slice(0, 10),
      queries: unique([request.searchTerms[0], request.requiredCategory]).slice(0, 3),
      providerId: "autopilot-context",
      promptVersion: AUTOPILOT_POLICY_VERSION,
      plannedAt: now.toISOString(),
    },
    updatedAt: now.toISOString(),
  });
}

function comparableUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function reconcileProduct(
  candidate: ProductSourceCandidate,
  content: ValidatedPublicContent,
  sources: readonly ProductSourceRecord[],
): { product: Product; source?: ProductSourceRecord | undefined } | undefined {
  const byId = candidate.canonicalProductId
    ? content.products.find(({ id }) => id === candidate.canonicalProductId)
    : undefined;
  if (byId) {
    return {
      product: byId,
      source: sources.find(({ id }) => id === candidate.productSourceId),
    };
  }
  const source = candidate.externalId
    ? sources.find(
        (record) =>
          normalized(record.marketplace) === normalized(candidate.marketplace) &&
          normalized(record.externalId) === normalized(candidate.externalId),
      )
    : undefined;
  if (source) {
    const product = content.products.find(({ id }) => id === source.productId);
    if (product) return { product, source };
  }
  const productUrl = comparableUrl(candidate.productUrl);
  const product = content.products.find(
    (item) =>
      (productUrl && comparableUrl(item.productUrl) === productUrl) ||
      (normalized(item.name) === normalized(candidate.name) &&
        normalized(item.brand) === normalized(candidate.brand) &&
        normalized(item.merchant) === normalized(candidate.merchant)),
  );
  return product ? { product } : undefined;
}

function sourceForCandidate(
  candidate: ProductSourceCandidate,
  productId: string,
  now: Date,
): ProductSourceRecord {
  return productSourceRecordSchema.parse({
    id: createProductSourceId(),
    productId,
    sourceKind: candidate.sourceKind,
    provider: candidate.provider,
    ...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
    ...(candidate.externalId ? { externalId: candidate.externalId } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
    importMethod:
      candidate.sourceKind === "serpapi" ||
      candidate.sourceKind === "dataforseo" ||
      candidate.sourceKind === "amazon-creators-api"
        ? "api"
        : "manual",
    importedAt: now.toISOString(),
    ...(candidate.observedAt ? { lastSynchronizedAt: candidate.observedAt } : {}),
    sourceStatus: "active",
    notes: "Created by Autopilot v1 after the structured automatic Product gate passed.",
    ...(candidate.sourceFacts.length ? { sourceFacts: candidate.sourceFacts } : {}),
  });
}

async function canonicalProductForCandidate(
  request: ProductSourcingRequest,
  candidate: ProductSourceCandidate,
  dependencies: AutopilotDependencies,
  now: Date,
  actions: string[],
  warnings: string[],
): Promise<{ product: Product; source: ProductSourceRecord; created: boolean }> {
  let content = dependencies.catalog.read();
  let sources = dependencies.sourceStore.list(content.products);
  const reconciled = reconcileProduct(candidate, content, sources);
  if (reconciled) {
    let source = reconciled.source;
    if (!source) {
      source = await dependencies.sourceStore.save(
        sourceForCandidate(candidate, reconciled.product.id, now),
        content.products,
      );
      actions.push("persisted-provenance");
    }
    actions.push("reused-canonical-product");
    return { product: reconciled.product, source, created: false };
  }

  const productClass = request.searchPlan?.productClass ?? request.requiredCategory;
  const productUrl = isGoogleShoppingIntermediaryUrl(candidate.productUrl)
    ? undefined
    : candidate.productUrl;
  const asin = candidateIsAmazon(candidate)
    ? (normalizeAmazonAsin(candidate.externalId ?? "") ??
      extractAmazonAsin(productUrl ?? candidate.sourceUrl ?? ""))
    : undefined;
  const preview = prepareManualProductIntake(
    {
      ...(productUrl ? { productUrl } : {}),
      ...(asin ? { asin } : {}),
      name: candidate.name,
      ...(candidate.brand ? { brand: candidate.brand } : {}),
      merchant:
        candidate.merchant ?? (candidateIsAmazon(candidate) ? "Amazon" : candidate.provider),
      shortDescription: `A ${productClass.toLocaleLowerCase("en-US")} option selected for this recommendation.`,
      sourceFacts: candidate.sourceFacts,
      verifiedFacts: [],
      verifiedFactsConfirmed: false,
      categories: [productClass],
      status: "active",
      provenanceNotes:
        "Created by Autopilot v1 after the structured automatic Product gate passed.",
      discoveryProvenance: {
        sourceKind: candidate.sourceKind as "serpapi" | "dataforseo",
        provider: candidate.provider,
        ...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
        ...(candidate.externalId ? { externalId: candidate.externalId } : {}),
        ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
        observedAt: candidate.observedAt!,
      },
    },
    dependencies.catalog.root,
  );
  if (preview.errors.length) throw new TypeError("automatic-canonical-intake-rejected");
  const committed = await commitManualProductIntake(preview, dependencies.catalog.root);
  actions.push("created-canonical-product", "persisted-provenance");

  let product = committed.product;
  try {
    const copy = await generateProductEditorialCopy(request, candidate, dependencies.provider);
    product = await dependencies.catalog.save({
      ...product,
      shortDescription: copy.shortDescription,
    });
    actions.push("generated-product-editorial-copy");
  } catch {
    warnings.push("product-editorial-copy-fallback-used");
  }
  content = dependencies.catalog.read();
  sources = dependencies.sourceStore.list(content.products);
  return {
    product,
    source: sources.find(({ id }) => id === committed.source.id) ?? committed.source,
    created: true,
  };
}

function linkCandidateAutomatically(
  request: ProductSourcingRequest,
  candidateId: string,
  productId: string,
  sourceId: string,
  now: Date,
): ProductSourcingRequest {
  const candidate = request.sourceCandidates.find(({ id }) => id === candidateId);
  if (!candidate) throw new TypeError("The accepted candidate disappeared from its request.");
  return productSourcingRequestSchema.parse({
    ...request,
    sourceCandidates: request.sourceCandidates.map((item) =>
      item.id === candidateId
        ? {
            ...item,
            status: "linked-to-product",
            canonicalProductId: productId,
            productSourceId: sourceId,
            reviewedAt: item.reviewedAt ?? now.toISOString(),
          }
        : item,
    ),
    updatedAt: now.toISOString(),
  });
}

export interface ProductBackedCopyCompletion {
  draft: GuideDraft;
  actionsPerformed: string[];
  warnings: string[];
}

export async function completeProductBackedRecommendationCopy(
  draft: GuideDraft,
  slotId: string,
  dependencies: Pick<AutopilotDependencies, "catalog" | "provider">,
  now = new Date(),
): Promise<ProductBackedCopyCompletion> {
  const slot = draft.recommendations.find(({ id }) => id === slotId);
  if (!slot?.productId) {
    throw new TypeError("Product-backed copy completion requires an assigned Product.");
  }
  dependencies.catalog.get(slot.productId);
  try {
    const generation = await generateProductBackedRecommendationWithRecovery(
      draft,
      slotId,
      dependencies.catalog.read(),
      dependencies.provider,
      now,
    );
    return {
      draft: generation.draft,
      actionsPerformed: [
        generation.repairedFields.length
          ? "repaired-product-recommendation-copy-fields"
          : "generated-product-recommendation-copy",
      ],
      warnings: generation.diagnosticDetails.map(formatGenerationContractDiagnostic),
    };
  } catch (error) {
    return {
      draft: applyDeterministicProductCopyFallback(draft, slotId, dependencies.catalog.read()),
      actionsPerformed: ["generated-safe-product-copy-fallback"],
      warnings: recommendationCopyFailureDiagnostics(error, dependencies.provider).map(
        formatGenerationContractDiagnostic,
      ),
    };
  }
}

const legacyGenericIdeaHeading = "A practical gift idea";
const legacyGenericConsiderations =
  "Confirm personal fit, compatibility, and care requirements before choosing.";

export function recommendationHasLegacyIdeaFallback(
  slot: GuideDraft["recommendations"][number],
  audience?: string,
): boolean {
  const normalizedAudience = normalized(audience);
  return Boolean(
    slot.editorialPromptVersion === SAFE_IDEA_COPY_VERSION ||
    normalized(slot.heading) === normalized(legacyGenericIdeaHeading) ||
    normalized(slot.editorialDescription) ===
      normalized(
        `${slot.slotLabel} can make a thoughtful gift when it matches the recipient's real routine and preferences.`,
      ) ||
    /^choose among\b/i.test(slot.editorialDescription ?? "") ||
    /^it supports this recommendation'?s purpose:/i.test(slot.whyItFits ?? "") ||
    normalized(slot.considerations) === normalized(legacyGenericConsiderations) ||
    (normalizedAudience.length >= 20 && normalized(slot.heading).includes(normalizedAudience)),
  );
}

export function ideaOnlyRecommendationNeedsCopyRepair(
  draft: GuideDraft,
  slotId: string,
  content: ValidatedPublicContent,
  request?: ProductSourcingRequest,
): boolean {
  const slot = draft.recommendations.find(({ id }) => id === slotId)!;
  if (slot.productId) return true;
  return (
    recommendationHasLegacyIdeaFallback(slot, draft.questionnaire.recipient) ||
    ideaOnlyCopyHasUnsupportedClaims(slot, content, request, ideaOnlyEditorialContext(draft, slot))
  );
}

export async function completeIdeaOnlyRecommendationCopy(
  draft: GuideDraft,
  slotId: string,
  dependencies: Pick<AutopilotDependencies, "catalog" | "provider">,
  request?: ProductSourcingRequest,
  now = new Date(),
): Promise<ProductBackedCopyCompletion> {
  const generation = await generateIdeaOnlyRecommendationWithRecovery(
    draft,
    slotId,
    dependencies.catalog.read(),
    dependencies.provider,
    request,
    now,
  );
  if (generation.usedDeterministicFallback) {
    return {
      draft: generation.draft,
      actionsPerformed: ["generated-safe-idea-only-fallback"],
      warnings: [
        ...generation.diagnosticDetails.map(formatGenerationContractDiagnostic),
        "idea-editorial-copy-fallback-used",
      ],
    };
  }
  return {
    draft: generation.draft,
    actionsPerformed: [
      generation.repairedFields.length
        ? "repaired-idea-only-copy-fields"
        : "generated-idea-only-copy",
    ],
    warnings: generation.diagnosticDetails.map(formatGenerationContractDiagnostic),
  };
}

async function saveDraftAndRequest(
  originalDraft: GuideDraft,
  nextDraft: GuideDraft,
  request: ProductSourcingRequest,
  dependencies: AutopilotDependencies,
  now: Date,
): Promise<void> {
  await dependencies.draftStore.save(nextDraft, now);
  try {
    await dependencies.sourcingStore.save(request);
  } catch (error) {
    await dependencies.draftStore.save(originalDraft, now);
    throw error;
  }
}

function discoveryAttempts(
  request: ProductSourcingRequest,
  fromIndex: number,
): AutopilotResolutionOutcome["discoveryAttempts"] {
  return request.discoveryRounds.slice(fromIndex).map((round) => ({
    round: round.round,
    provider: round.provider,
    mode: "amazon" as const,
    status: round.status,
    providerCalls: round.providerCalls,
    storedCandidateCount: round.storedCandidateCount,
    returnedCandidateCount: round.returnedCandidateCount ?? round.storedCandidateCount,
    reusedCandidateCount:
      round.reusedCandidateCount ??
      (round.status === "reused-candidates" ? round.storedCandidateCount : 0),
    ...(round.failureCode ? { failureCode: round.failureCode } : {}),
  }));
}

function executionEvidence(
  request: ProductSourcingRequest,
  discoveryStart: number,
  catalogCandidatesConsidered: number,
  evaluations: readonly ProductFitEvaluation[],
  p2: P2Diagnostics,
  content: ValidatedPublicContent,
  actions: readonly string[],
  sourcingBudgetExhausted = false,
): AutopilotResolutionOutcome["executionEvidence"] {
  const attempts = discoveryAttempts(request, discoveryStart);
  const candidateById = new Map(
    request.sourceCandidates
      .filter(({ status }) => status !== "rejected")
      .map((candidate) => [candidate.id, candidate]),
  );
  const ordered = orderProductFitEvaluations(
    evaluations.filter(({ candidateId }) => candidateById.has(candidateId)),
  );
  const bestEvaluation = ordered[0];
  const bestCandidate = bestEvaluation ? candidateById.get(bestEvaluation.candidateId) : undefined;
  const p2GateFailures =
    bestCandidate && bestEvaluation
      ? assessAutomaticProductCandidate(request, bestCandidate, bestEvaluation, content)
          .rejectedBecause
      : [];
  const canonicalCandidateConsidered = request.sourceCandidates.some(
    ({ canonicalProductId }) => canonicalProductId,
  );
  const discoveryRecoveryAttempted = actions.includes(
    "retried-amazon-discovery-after-provider-failure",
  );
  return {
    catalogReuseAttempted: true,
    catalogReuseResult:
      actions.includes("fulfilled-originating-sourcing-request") &&
      actions.includes("reused-canonical-product")
        ? "product-reused"
        : canonicalCandidateConsidered
          ? "candidate-not-selected"
          : "no-suitable-candidate",
    catalogCandidatesConsidered,
    recentSourceCandidatesConsidered: attempts.reduce(
      (sum, attempt) => sum + attempt.reusedCandidateCount,
      0,
    ),
    amazonDiscoveryAttempted: attempts.length > 0,
    providerCallCount: attempts.reduce((sum, attempt) => sum + attempt.providerCalls, 0),
    candidatesReturned: attempts.reduce((sum, attempt) => sum + attempt.returnedCandidateCount, 0),
    candidatesEvaluated: new Set(evaluations.map(({ candidateId }) => candidateId)).size,
    p2ProviderCallCount: p2.providerCallCount,
    p2RecoveryAttempted: p2.recoveryAttempted,
    candidatesRecovered: p2.candidatesRecovered,
    p2Attempts: p2.attempts,
    candidateEvaluationFailures: [...p2.failures.values()].map((failure) => ({
      candidateId: failure.candidateId,
      name: candidateById.get(failure.candidateId)?.name ?? failure.candidateId,
      reasonCode: failure.code,
    })),
    ...(bestCandidate
      ? {
          bestCandidate: {
            candidateId: bestCandidate.id,
            name: bestCandidate.name,
            p2GateFailures,
          },
        }
      : {}),
    searchRefinementAttempted: actions.includes("refined-amazon-search"),
    discoveryRecoveryAttempted,
    recoveryUsed: p2.recoveryAttempted || discoveryRecoveryAttempted,
    sourcingBudgetExhausted,
  };
}

function ideaOnlyReasonCode(
  request: ProductSourcingRequest,
  discoveryStart: number,
  evaluations: readonly ProductFitEvaluation[],
  warnings: readonly string[],
  p2: P2Diagnostics,
  amazonDiscoveryAvailable: boolean,
): AutopilotReasonCode {
  const attempts = discoveryAttempts(request, discoveryStart);
  const latestAttempt = attempts.at(-1);
  const failedAttempt = latestAttempt?.status === "failed" ? latestAttempt : undefined;
  if (failedAttempt?.failureCode) return `amazon-provider-${failedAttempt.failureCode}`;
  if (warnings.includes("amazon-discovery-failed")) return "amazon-provider-unavailable";
  if (evaluations.length) return "no-candidate-passed-product-gate";
  if (p2.failures.size) return "evaluation-infrastructure-failed";
  if (
    attempts.length &&
    attempts.every(
      ({ returnedCandidateCount, reusedCandidateCount }) =>
        returnedCandidateCount === 0 && reusedCandidateCount === 0,
    )
  ) {
    return "amazon-no-candidates";
  }
  return amazonDiscoveryAvailable ? "no-trustworthy-product" : "amazon-discovery-unavailable";
}

function outcome(
  draft: GuideDraft,
  request: ProductSourcingRequest,
  fields: Omit<
    AutopilotResolutionOutcome,
    "schemaVersion" | "policyVersion" | "recommendationId" | "slotId" | "sourcingRequestId"
  >,
): AutopilotResolutionOutcome {
  const slotId =
    request.origin.kind === "recommendation-slot"
      ? request.origin.recommendationSlotId
      : draft.recommendations[0]!.id;
  return autopilotResolutionOutcomeSchema.parse({
    schemaVersion: 1,
    policyVersion: AUTOPILOT_POLICY_VERSION,
    recommendationId: slotId,
    slotId,
    sourcingRequestId: request.id,
    ...fields,
  });
}

async function completeIdeaOnly(
  draft: GuideDraft,
  slotId: string,
  request: ProductSourcingRequest,
  dependencies: AutopilotDependencies,
  now: Date,
  actions: string[],
  warnings: string[],
  rejectedBecause: string[],
  reasonCode: AutopilotReasonCode,
  discoveryStart: number,
  catalogCandidatesConsidered: number,
  evaluations: readonly ProductFitEvaluation[],
  p2: P2Diagnostics,
  sourcingBudgetExhausted = false,
): Promise<AutopilotResolutionOutcome> {
  let completedDraft: GuideDraft;
  const existingSlot = draft.recommendations.find(({ id }) => id === slotId)!;
  if (
    recommendationIsEditoriallyReady(existingSlot) &&
    !recommendationHasLegacyIdeaFallback(existingSlot, draft.questionnaire.recipient)
  ) {
    completedDraft = draft;
    actions.push("preserved-ready-idea-copy");
  } else {
    const copy = await completeIdeaOnlyRecommendationCopy(
      draft,
      slotId,
      dependencies,
      request,
      now,
    );
    completedDraft = copy.draft;
    actions.push(...copy.actionsPerformed);
    warnings.push(...copy.warnings);
  }
  const completedRequest = completeProductSourcingRequestAsIdeaOnly(request, now);
  try {
    await saveDraftAndRequest(draft, completedDraft, completedRequest, dependencies, now);
  } catch {
    return outcome(draft, request, {
      status: "failed",
      reasonCode: "safe-terminal-write-failed",
      reasonExplanation: reasonExplanations["safe-terminal-write-failed"],
      resolutionStrategy: "failed",
      candidatePassedBecause: [],
      productNotUsedBecause: unique([...rejectedBecause, "safe-terminal-write-failed"]),
      discoveryAttempts: discoveryAttempts(request, discoveryStart),
      executionEvidence: executionEvidence(
        request,
        discoveryStart,
        catalogCandidatesConsidered,
        evaluations,
        p2,
        dependencies.catalog.read(),
        actions,
        sourcingBudgetExhausted,
      ),
      affiliateDestinationStatus: "not-applicable",
      actionsPerformed: actions,
      warnings: unique([...warnings, "infrastructure-failure"]),
    });
  }
  actions.push(
    "completed-editorial-copy-with-product-pending",
    "completed-originating-sourcing-attempt",
  );
  return outcome(draft, completedRequest, {
    status: "resolved-idea-only",
    reasonCode,
    reasonExplanation: reasonExplanations[reasonCode],
    resolutionStrategy: "idea-only",
    candidatePassedBecause: [],
    productNotUsedBecause: unique(
      rejectedBecause.length ? rejectedBecause : ["no-trustworthy-product"],
    ),
    discoveryAttempts: discoveryAttempts(completedRequest, discoveryStart),
    executionEvidence: executionEvidence(
      completedRequest,
      discoveryStart,
      catalogCandidatesConsidered,
      evaluations,
      p2,
      dependencies.catalog.read(),
      actions,
      sourcingBudgetExhausted,
    ),
    affiliateDestinationStatus: "not-applicable",
    actionsPerformed: actions,
    warnings: unique(warnings),
  });
}

export async function resolveRecommendationSlotAutonomously(
  draft: GuideDraft,
  slotId: string,
  dependencies: AutopilotDependencies,
  options: AutopilotOptions = {},
): Promise<AutopilotResolutionOutcome> {
  const now = options.now ?? new Date();
  const slot = draft.recommendations.find(({ id }) => id === slotId);
  if (!slot) throw new TypeError(`The recommendation slot "${slotId}" does not exist.`);
  if (slot.productId) throw new TypeError("Autopilot accepts only an unresolved Product slot.");

  const actions: string[] = [];
  const warnings: string[] = [];
  let request = findProductSourcingRequestForDraftSlot(
    dependencies.sourcingStore.list(),
    draft.id,
    slotId,
  );
  if (!request || !productSourcingRequestIsActive(request)) {
    request = createProductSourcingRequestForDraftSlot(draft, slot, undefined, now);
    await dependencies.sourcingStore.save(request);
    actions.push("created-originating-sourcing-request");
  }
  assertExactSlotRequest(request, draft, slotId);
  const discoveryStart = request.discoveryRounds.length;

  if (!request.searchPlan) {
    request = fallbackSearchPlan(request, now);
    actions.push("created-deterministic-search-plan");
    request = await dependencies.sourcingStore.save(request);
    assertExactSlotRequest(request, draft, slotId);
  }

  const content = dependencies.catalog.read();
  const catalogCandidatesConsidered = catalogMatchesForRequest(
    request,
    content.products,
    AUTOPILOT_LIMITS.maxCatalogCandidates,
  ).length;
  const catalogAttached = attachCatalogCandidates(
    request,
    content,
    dependencies.sourceStore.list(content.products),
    now,
  );
  actions.push("inspected-canonical-catalog");
  if (catalogAttached.sourceCandidates.length !== request.sourceCandidates.length) {
    request = await dependencies.sourcingStore.save(catalogAttached);
  } else {
    request = catalogAttached;
  }

  const evaluations: ProductFitEvaluation[] = [];
  const handledCandidateIds = new Set<string>();
  const p2: P2Diagnostics = {
    providerCallCount: 0,
    recoveryAttempted: false,
    candidatesRecovered: 0,
    attempts: [],
    failures: new Map(),
  };
  const runP2Attempt = async (
    candidates: readonly ProductSourceCandidate[],
    kind: "primary" | "recovery",
  ) => {
    if (p2.providerCallCount >= AUTOPILOT_LIMITS.maxP2ProviderCalls) {
      throw new TypeError("Autopilot exceeded its P.2 provider call limit.");
    }
    p2.providerCallCount++;
    const attempt = await evaluateProductFitBatchAttempt(
      candidates.map(({ id }) => ({ request: request!, candidateId: id })),
      {
        content: dependencies.catalog.read(),
        drafts: [draft],
        benchmarks: dependencies.benchmarks ?? [],
        provider: dependencies.provider,
        now,
      },
    );
    const failureByCandidateId = new Map(
      attempt.failures.map((failure) => [failure.candidateId, failure.code]),
    );
    p2.attempts.push({
      kind,
      candidatesSent: candidates.length,
      candidatesEvaluated: attempt.session?.aiInterpretation.evaluations.length ?? 0,
      candidatesFailed: attempt.failures.length,
      unmappedMalformedResults: attempt.malformedResultCount,
      candidateResults: candidates.map(({ id }) => ({
        candidateId: id,
        status: failureByCandidateId.get(id) ?? "valid",
      })),
    });
    return attempt;
  };
  const evaluateNewCandidates = async (): Promise<void> => {
    const candidates = request!.sourceCandidates
      .filter(({ id, status }) => status !== "rejected" && !handledCandidateIds.has(id))
      .slice(0, AUTOPILOT_LIMITS.maxCandidatesPerEvaluation);
    if (!candidates.length) return;
    const primary = await runP2Attempt(candidates, "primary");
    const primaryFailedTechnically =
      !primary.session || primary.failures.length > 0 || primary.malformedResultCount > 0;
    let accepted = primary;
    if (primaryFailedTechnically && !p2.recoveryAttempted) {
      p2.recoveryAttempted = true;
      accepted = await runP2Attempt(candidates, "recovery");
      const recoveredIds = new Set(
        accepted.session?.aiInterpretation.evaluations.map(({ candidateId }) => candidateId) ?? [],
      );
      p2.candidatesRecovered = primary.failures.filter(({ candidateId }) =>
        recoveredIds.has(candidateId),
      ).length;
    }
    const acceptedFailedTechnically =
      !accepted.session || accepted.failures.length > 0 || accepted.malformedResultCount > 0;
    if (acceptedFailedTechnically) {
      for (const failure of accepted.failures) p2.failures.set(failure.candidateId, failure);
      if (accepted.malformedResultCount) {
        warnings.push("candidate-evaluation-response-malformed");
        for (const candidate of candidates) {
          if (!p2.failures.has(candidate.id)) {
            p2.failures.set(candidate.id, {
              requestId: request!.id,
              candidateId: candidate.id,
              code: "malformed-result",
            });
          }
        }
      }
    } else if (accepted.session) {
      await dependencies.fitStore.save(accepted.session);
      evaluations.push(...accepted.session.aiInterpretation.evaluations);
      actions.push(
        p2.recoveryAttempted
          ? "recovered-candidate-evaluations-with-structured-p2"
          : "evaluated-candidates-with-structured-p2",
      );
    }
    for (const candidate of candidates) handledCandidateIds.add(candidate.id);
  };

  const hadCandidatesBeforeDiscovery = request.sourceCandidates.some(
    ({ status }) => status !== "rejected",
  );
  await evaluateNewCandidates();

  let choice = chooseAutomaticProductCandidate(request, evaluations, dependencies.catalog.read());
  let strategy: AutopilotResolutionOutcome["resolutionStrategy"] = "existing-candidate";
  if (choice.candidate?.canonicalProductId) strategy = "catalog-reuse";
  const amazonDiscoveryAvailable = Boolean(
    dependencies.discoverySource &&
    productDiscoverySourceSupportsMode(dependencies.discoverySource, "amazon"),
  );

  if (
    !choice.candidate &&
    !hadCandidatesBeforeDiscovery &&
    dependencies.discoverySource &&
    amazonDiscoveryAvailable
  ) {
    while (request.discoveryRounds.length < AUTOPILOT_LIMITS.maxDiscoveryRounds) {
      const round = request.discoveryRounds.length + 1;
      let discovered: ProductSourcingRequest;
      try {
        discovered = await runProductDiscovery(request, dependencies.discoverySource, {
          products: dependencies.catalog.read().products,
          allRequests: dependencies.sourcingStore.list().filter(({ id }) => id !== request!.id),
          skipCatalogReuse: true,
          discoveryMode: "amazon",
          round,
          now,
          limits: {
            maxRounds: AUTOPILOT_LIMITS.maxDiscoveryRounds,
            maxProviderCallsPerRun: 1,
            maxStoredCandidatesPerSlot:
              DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxStoredCandidatesPerSlot *
              AUTOPILOT_LIMITS.maxDiscoveryRounds,
          },
        });
      } catch {
        warnings.push("amazon-discovery-failed");
        break;
      }
      request = await dependencies.sourcingStore.save(discovered);
      assertExactSlotRequest(request, draft, slotId);
      actions.push(
        round === discoveryStart + 1 ? "ran-amazon-discovery" : "retried-amazon-discovery",
      );
      const attempt = discoveryAttempts(request, discoveryStart).at(-1)!;
      if (attempt.status !== "failed" || !attempt.failureCode) break;
      if (!["timeout", "unavailable", "malformed"].includes(attempt.failureCode)) break;
      if (request.discoveryRounds.length >= AUTOPILOT_LIMITS.maxDiscoveryRounds) break;
      actions.push("retried-amazon-discovery-after-provider-failure");
    }
    await evaluateNewCandidates();
    choice = chooseAutomaticProductCandidate(request, evaluations, dependencies.catalog.read());
    if (choice.candidate) strategy = "amazon-discovery";
  }

  const providerCalls = discoveryAttempts(request, discoveryStart).reduce(
    (sum, attempt) => sum + attempt.providerCalls,
    0,
  );
  if (providerCalls > AUTOPILOT_LIMITS.maxDiscoveryCalls) {
    throw new TypeError("Autopilot exceeded its external provider call limit.");
  }
  if (p2.providerCallCount > AUTOPILOT_LIMITS.maxP2ProviderCalls) {
    throw new TypeError("Autopilot exceeded its P.2 provider call limit.");
  }
  if (p2.failures.size) {
    warnings.push(
      evaluations.length ? "candidate-evaluation-partial-failure" : "candidate-evaluation-failed",
    );
  }

  if (!choice.candidate) {
    const reasonCode = ideaOnlyReasonCode(
      request,
      discoveryStart,
      evaluations,
      warnings,
      p2,
      amazonDiscoveryAvailable,
    );
    const latestDiscoveryAttempt = discoveryAttempts(request, discoveryStart).at(-1);
    const sourcingBudgetExhausted =
      (p2.providerCallCount >= AUTOPILOT_LIMITS.maxP2ProviderCalls &&
        evaluations.length === 0 &&
        p2.failures.size > 0) ||
      (providerCalls >= AUTOPILOT_LIMITS.maxDiscoveryCalls &&
        latestDiscoveryAttempt?.status === "failed");
    return completeIdeaOnly(
      draft,
      slotId,
      request,
      dependencies,
      now,
      actions,
      warnings,
      choice.rejectedBecause,
      reasonCode,
      discoveryStart,
      catalogCandidatesConsidered,
      evaluations,
      p2,
      sourcingBudgetExhausted,
    );
  }

  const requestBeforeProductResolution = request;
  try {
    const resolved = await canonicalProductForCandidate(
      request,
      choice.candidate,
      dependencies,
      now,
      actions,
      warnings,
    );
    if (!resolved.created) strategy = "catalog-reuse";
    request = linkCandidateAutomatically(
      request,
      choice.candidate.id,
      resolved.product.id,
      resolved.source.id,
      now,
    );
    request = selectCanonicalProductForRequest(
      request,
      resolved.product.id,
      dependencies.catalog.read().products,
      "fulfilled",
      now,
    );
    const assignedDraft = assignSourcedProductToDraftSlot(
      request,
      resolved.product.id,
      draft,
      dependencies.catalog.read(),
      false,
    );
    const copy = await completeProductBackedRecommendationCopy(
      assignedDraft,
      slotId,
      dependencies,
      now,
    );
    actions.push(...copy.actionsPerformed);
    warnings.push(...copy.warnings);
    await saveDraftAndRequest(draft, copy.draft, request, dependencies, now);
    actions.push("fulfilled-originating-sourcing-request", "assigned-product-to-exact-slot");
    const product = dependencies.catalog.get(resolved.product.id);
    return outcome(draft, request, {
      status: "resolved-product",
      reasonCode: "product-selected",
      reasonExplanation: reasonExplanations["product-selected"],
      productId: product.id,
      candidateId: choice.candidate.id,
      resolutionStrategy: strategy,
      candidatePassedBecause: choice.passedBecause,
      productNotUsedBecause: [],
      discoveryAttempts: discoveryAttempts(request, discoveryStart),
      executionEvidence: executionEvidence(
        request,
        discoveryStart,
        catalogCandidatesConsidered,
        evaluations,
        p2,
        dependencies.catalog.read(),
        actions,
      ),
      affiliateDestinationStatus: productDestination(product)
        ? "available"
        : "affiliate-destination-missing",
      actionsPerformed: actions,
      warnings: unique(warnings),
    });
  } catch {
    warnings.push("automatic-product-resolution-failed");
    return completeIdeaOnly(
      draft,
      slotId,
      requestBeforeProductResolution,
      dependencies,
      now,
      actions,
      warnings,
      ["canonical-or-assignment-write-failed"],
      "product-resolution-failed",
      discoveryStart,
      catalogCandidatesConsidered,
      evaluations,
      p2,
    );
  }
}
