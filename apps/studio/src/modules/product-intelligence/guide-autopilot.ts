import { productDestination } from "@the-good-present/content-schema";
import { z } from "zod";

import type {
  GuideGenerationProvider,
  ProviderCallMetadata,
  StructuredGenerationRequest,
} from "../../ai-provider.ts";
import { guideDraftSchema, type GuideDraft } from "../../drafts.ts";
import {
  completeGuideEditorialMetadata,
  guideEditorialMetadataIsComplete,
  guideDraftReadiness,
  generateIdeaOnlyRecommendationBatchWithRecovery,
  productClaimContext,
  productBackedCopyNeedsVerifiedFactsRepair,
  recommendationIsEditoriallyReady,
} from "../../guide-editor.ts";
import {
  autopilotResolutionOutcomeSchema,
  completeProductBackedRecommendationCopy,
  ideaOnlyRecommendationNeedsCopyRepair,
  resolveRecommendationSlotAutonomously,
  type AutopilotDependencies,
  type AutopilotResolutionOutcome,
} from "./autopilot.ts";
import { findProductSourcingRequestForDraftSlot } from "./sourcing.ts";

export const GUIDE_AUTOPILOT_POLICY_VERSION = "guide-autopilot-v5";

// ponytail: DraftStore saves a whole Guide; keep slot execution serial until it supports CAS/merge.
export const GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS = 1;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const providerUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

const compactSingleSlotOutcomeSchema = autopilotResolutionOutcomeSchema
  .pick({
    status: true,
    reasonCode: true,
    sourcingRequestId: true,
    productId: true,
    candidateId: true,
    resolutionStrategy: true,
    affiliateDestinationStatus: true,
  })
  .extend({
    sourcing: z.strictObject({
      catalogReuseAttempted: z.boolean(),
      catalogReuseResult:
        autopilotResolutionOutcomeSchema.shape.executionEvidence.shape.catalogReuseResult,
      externalDiscoveryCalls: z.number().int().nonnegative(),
      p2Calls: z.number().int().nonnegative(),
      recoveryUsed: z.boolean(),
      budgetExhausted: z.boolean(),
    }),
  });

export const guideAutopilotOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(GUIDE_AUTOPILOT_POLICY_VERSION),
  guideId: safeId,
  status: z.enum(["completed", "completed-with-warnings", "failed"]),
  reasonCode: z.enum([
    "guide-completed",
    "guide-completed-with-warnings",
    "slot-editorial-completion-failed",
    "guide-has-no-recommendations",
  ]),
  reasonExplanation: nonEmptyText,
  counts: z.strictObject({
    totalRecommendations: z.number().int().nonnegative(),
    editorialReady: z.number().int().nonnegative(),
    productResolved: z.number().int().nonnegative(),
    productPending: z.number().int().nonnegative(),
    affiliateReady: z.number().int().nonnegative(),
    affiliatePending: z.number().int().nonnegative(),
    genericRecommendations: z.number().int().nonnegative(),
    slotsWithWarnings: z.number().int().nonnegative(),
  }),
  execution: z.strictObject({
    maxConcurrentSlots: z.literal(GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS),
    peakConcurrentSlots: z.number().int().min(0).max(GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS),
    productsReused: z.number().int().nonnegative(),
    productsCreated: z.number().int().nonnegative(),
    externalDiscoveryCalls: z.number().int().nonnegative(),
    productPlanningCalls: z.number().int().nonnegative(),
    p2Calls: z.number().int().nonnegative(),
    editorialCalls: z.number().int().nonnegative(),
    editorialBatchCalls: z.number().int().nonnegative(),
    editorialRepairCalls: z.number().int().nonnegative(),
    guideMetadataCalls: z.number().int().nonnegative(),
    technicalRetries: z.number().int().nonnegative(),
    slotsStoppedBySourcingBudget: z.number().int().nonnegative(),
    productPendingFallbacks: z.number().int().nonnegative(),
    nonBlockingFailures: z.number().int().nonnegative(),
    providerUsage: z
      .strictObject({
        productPlanning: providerUsageSchema.optional(),
        p2: providerUsageSchema.optional(),
        editorial: providerUsageSchema.optional(),
        guideMetadata: providerUsageSchema.optional(),
      })
      .optional(),
  }),
  slots: z.array(
    z.strictObject({
      slotId: safeId,
      recommendationId: safeId,
      position: z.number().int().positive(),
      status: z.enum(["product-resolved", "product-pending", "failed"]),
      action: z.enum([
        "preserved-ready-product-slot",
        "preserved-ready-product-pending-slot",
        "repaired-generic-idea-copy",
        "completed-product-copy",
        "single-slot-autopilot",
      ]),
      editorialReady: z.boolean(),
      productId: safeId.optional(),
      singleSlotResult: compactSingleSlotOutcomeSchema.optional(),
      warnings: z.array(nonEmptyText),
    }),
  ),
  warnings: z.array(nonEmptyText),
});

export type GuideAutopilotOutcome = z.infer<typeof guideAutopilotOutcomeSchema>;

export interface GuideAutopilotOptions {
  now?: Date | undefined;
  sourceProducts?: boolean | undefined;
}

const technicalFallbackReasons = new Set<AutopilotResolutionOutcome["reasonCode"]>([
  "amazon-provider-configuration",
  "amazon-provider-quota",
  "amazon-provider-timeout",
  "amazon-provider-unavailable",
  "amazon-provider-malformed",
  "evaluation-infrastructure-failed",
  "product-resolution-failed",
  "safe-terminal-write-failed",
]);

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function compactSingleSlotResult(result: AutopilotResolutionOutcome) {
  const evidence = result.executionEvidence;
  return compactSingleSlotOutcomeSchema.parse({
    status: result.status,
    reasonCode: result.reasonCode,
    sourcingRequestId: result.sourcingRequestId,
    ...(result.productId ? { productId: result.productId } : {}),
    ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    resolutionStrategy: result.resolutionStrategy,
    affiliateDestinationStatus: result.affiliateDestinationStatus,
    sourcing: {
      catalogReuseAttempted: evidence.catalogReuseAttempted,
      catalogReuseResult: evidence.catalogReuseResult,
      externalDiscoveryCalls: evidence.providerCallCount,
      p2Calls: evidence.p2ProviderCallCount,
      recoveryUsed: evidence.recoveryUsed,
      budgetExhausted: evidence.sourcingBudgetExhausted,
    },
  });
}

async function readGuideDraft(
  id: string,
  dependencies: Pick<AutopilotDependencies, "draftStore">,
): Promise<GuideDraft> {
  return guideDraftSchema.parse(await dependencies.draftStore.read(id));
}

type ProviderCallCategory = "productPlanning" | "p2" | "editorial" | "guideMetadata";

interface ProviderCallCounter {
  calls: number;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

function providerCallCategory(
  operation: StructuredGenerationRequest<unknown>["operation"],
): ProviderCallCategory {
  if (operation === "product-search-plans") return "productPlanning";
  if (operation === "product-fit-evaluations") return "p2";
  if (operation === "guide-metadata") return "guideMetadata";
  return "editorial";
}

function addProviderUsage(counter: ProviderCallCounter, metadata?: ProviderCallMetadata): void {
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = metadata?.[key];
    if (value !== undefined) counter.usage[key] = (counter.usage[key] ?? 0) + value;
  }
}

function observedProvider(
  provider: GuideGenerationProvider,
  counters: Record<ProviderCallCategory, ProviderCallCounter>,
  editorialInvocations: { batch: number; repair: number },
): GuideGenerationProvider {
  return {
    providerId: provider.providerId,
    ...(provider.modelId ? { modelId: provider.modelId } : {}),
    get lastCallMetadata() {
      return provider.lastCallMetadata;
    },
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "idea-recommendation-batch") editorialInvocations.batch++;
      if (request.operation === "idea-recommendation-batch-repair") editorialInvocations.repair++;
      const counter = counters[providerCallCategory(request.operation)];
      const previousMetadata = provider.lastCallMetadata;
      counter.calls++;
      try {
        return await provider.generateStructured(request);
      } finally {
        if (provider.lastCallMetadata !== previousMetadata) {
          addProviderUsage(counter, provider.lastCallMetadata);
        }
      }
    },
  };
}

function providerUsage(
  counters: Record<ProviderCallCategory, ProviderCallCounter>,
): GuideAutopilotOutcome["execution"]["providerUsage"] {
  const usage = Object.fromEntries(
    Object.entries(counters)
      .filter(([, counter]) => Object.keys(counter.usage).length > 0)
      .map(([category, counter]) => [category, counter.usage]),
  );
  return Object.keys(usage).length ? usage : undefined;
}

export async function completeGuideAutonomously(
  initialDraft: GuideDraft,
  dependencies: AutopilotDependencies,
  options: GuideAutopilotOptions = {},
): Promise<GuideAutopilotOutcome> {
  const now = options.now ?? new Date();
  let draft = guideDraftSchema.parse(initialDraft);
  const slots: GuideAutopilotOutcome["slots"] = [];
  const guideWarnings: string[] = [];
  const providerCalls: Record<ProviderCallCategory, ProviderCallCounter> = {
    productPlanning: { calls: 0, usage: {} },
    p2: { calls: 0, usage: {} },
    editorial: { calls: 0, usage: {} },
    guideMetadata: { calls: 0, usage: {} },
  };
  const editorialInvocations = { batch: 0, repair: 0 };
  const trackedDependencies = {
    ...dependencies,
    provider: observedProvider(dependencies.provider, providerCalls, editorialInvocations),
  };
  const execution = {
    maxConcurrentSlots: GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS,
    peakConcurrentSlots: 0,
    productsReused: 0,
    productsCreated: 0,
    externalDiscoveryCalls: 0,
    productPlanningCalls: 0,
    p2Calls: 0,
    editorialCalls: 0,
    editorialBatchCalls: 0,
    editorialRepairCalls: 0,
    guideMetadataCalls: 0,
    technicalRetries: 0,
    slotsStoppedBySourcingBudget: 0,
    productPendingFallbacks: 0,
    nonBlockingFailures: 0,
  } as GuideAutopilotOutcome["execution"];

  if (draft.recommendations.length && !guideEditorialMetadataIsComplete(draft)) {
    const completion = await completeGuideEditorialMetadata(
      draft,
      dependencies.catalog.read(),
      trackedDependencies.provider,
      now,
    );
    try {
      await dependencies.draftStore.save(completion.draft, now);
      draft = await readGuideDraft(draft.id, dependencies);
      guideWarnings.push(...completion.warnings);
    } catch {
      guideWarnings.push("guide-metadata-save-failed");
    }
  }

  const batchedIdeaWarnings = new Map<string, string[]>();
  if (!options.sourceProducts) {
    const content = dependencies.catalog.read();
    const recommendationIds = [...draft.recommendations]
      .sort((left, right) => left.position - right.position)
      .filter((slot) => {
        if (slot.productId) return false;
        const request = findProductSourcingRequestForDraftSlot(
          dependencies.sourcingStore.list(),
          draft.id,
          slot.id,
        );
        return (
          ideaOnlyRecommendationNeedsCopyRepair(draft, slot.id, content, request) ||
          !recommendationIsEditoriallyReady(slot)
        );
      })
      .map(({ id }) => id);
    if (recommendationIds.length) {
      const requests = new Map(
        recommendationIds.flatMap((id) => {
          const request = findProductSourcingRequestForDraftSlot(
            dependencies.sourcingStore.list(),
            draft.id,
            id,
          );
          return request ? [[id, request] as const] : [];
        }),
      );
      try {
        const completion = await generateIdeaOnlyRecommendationBatchWithRecovery(
          draft,
          recommendationIds,
          content,
          trackedDependencies.provider,
          requests,
          now,
        );
        await dependencies.draftStore.save(completion.draft, now);
        draft = await readGuideDraft(draft.id, dependencies);
        for (const slot of completion.slots) {
          batchedIdeaWarnings.set(slot.slotId, slot.warnings);
        }
      } catch {
        for (const id of recommendationIds) {
          batchedIdeaWarnings.set(id, ["idea-copy-repair-failed"]);
        }
      }
    }
  }

  for (const originalSlot of [...draft.recommendations].sort(
    (left, right) => left.position - right.position,
  )) {
    execution.peakConcurrentSlots = 1;
    draft = await readGuideDraft(draft.id, dependencies);
    const slot = draft.recommendations.find(({ id }) => id === originalSlot.id)!;
    let action: GuideAutopilotOutcome["slots"][number]["action"];
    let singleSlotResult: ReturnType<typeof compactSingleSlotResult> | undefined;
    let warnings: string[] = [];
    const content = dependencies.catalog.read();
    const product = slot.productId
      ? content.products.find(({ id }) => id === slot.productId)
      : undefined;
    const sourcingRequest = !slot.productId
      ? findProductSourcingRequestForDraftSlot(dependencies.sourcingStore.list(), draft.id, slot.id)
      : undefined;

    if (batchedIdeaWarnings.has(slot.id)) {
      action = "repaired-generic-idea-copy";
      warnings.push(...batchedIdeaWarnings.get(slot.id)!);
    } else if (
      product &&
      recommendationIsEditoriallyReady(slot) &&
      !productBackedCopyNeedsVerifiedFactsRepair(
        slot,
        product,
        draft.generationMetadata?.promptVersion,
        productClaimContext(draft, slot),
      )
    ) {
      action = "preserved-ready-product-slot";
    } else if (slot.productId) {
      action = "completed-product-copy";
      try {
        const copy = await completeProductBackedRecommendationCopy(
          draft,
          slot.id,
          trackedDependencies,
          now,
        );
        await dependencies.draftStore.save(copy.draft, now);
        warnings.push(...copy.warnings);
      } catch {
        warnings.push("product-copy-completion-failed");
      }
    } else if (options.sourceProducts) {
      action = "single-slot-autopilot";
      try {
        const result = await resolveRecommendationSlotAutonomously(
          draft,
          slot.id,
          trackedDependencies,
          { now },
        );
        singleSlotResult = compactSingleSlotResult(result);
        execution.productsReused += result.actionsPerformed.includes("reused-canonical-product")
          ? 1
          : 0;
        execution.productsCreated += result.actionsPerformed.includes("created-canonical-product")
          ? 1
          : 0;
        execution.externalDiscoveryCalls += result.executionEvidence.providerCallCount;
        execution.technicalRetries +=
          Number(result.executionEvidence.p2RecoveryAttempted) +
          Number(result.executionEvidence.discoveryRecoveryAttempted);
        execution.slotsStoppedBySourcingBudget += Number(
          result.executionEvidence.sourcingBudgetExhausted,
        );
        execution.productPendingFallbacks += result.status === "resolved-idea-only" ? 1 : 0;
        warnings.push(...result.warnings);
        if (technicalFallbackReasons.has(result.reasonCode)) warnings.push(result.reasonCode);
      } catch {
        warnings.push("slot-autopilot-execution-failed");
      }
    } else {
      action = "preserved-ready-product-pending-slot";
    }

    draft = await readGuideDraft(draft.id, dependencies);
    const completedSlot = draft.recommendations.find(({ id }) => id === slot.id)!;
    warnings = unique(warnings);
    execution.nonBlockingFailures += warnings.length;
    slots.push({
      slotId: completedSlot.id,
      recommendationId: completedSlot.id,
      position: completedSlot.position,
      status: recommendationIsEditoriallyReady(completedSlot)
        ? completedSlot.productId
          ? "product-resolved"
          : "product-pending"
        : "failed",
      action,
      editorialReady: recommendationIsEditoriallyReady(completedSlot),
      ...(completedSlot.productId ? { productId: completedSlot.productId } : {}),
      ...(singleSlotResult ? { singleSlotResult } : {}),
      warnings,
    });
  }

  draft = await readGuideDraft(draft.id, dependencies);
  const readiness = guideDraftReadiness(draft);
  const content = dependencies.catalog.read();
  const products = new Map(content.products.map((product) => [product.id, product]));
  const productBacked = draft.recommendations.filter(({ productId }) => productId);
  const affiliateReady = productBacked.filter(({ productId }) => {
    const product = productId ? products.get(productId) : undefined;
    return product ? Boolean(productDestination(product)) : false;
  }).length;
  const warnings = slots.flatMap((slot) =>
    slot.warnings.map((warning) => `${slot.slotId}:${warning}`),
  );
  warnings.unshift(...guideWarnings.map((warning) => `guide:${warning}`));
  execution.nonBlockingFailures += guideWarnings.length;
  execution.productPlanningCalls = providerCalls.productPlanning.calls;
  execution.p2Calls = providerCalls.p2.calls;
  execution.editorialCalls = providerCalls.editorial.calls;
  execution.editorialBatchCalls = editorialInvocations.batch;
  execution.editorialRepairCalls = editorialInvocations.repair;
  execution.guideMetadataCalls = providerCalls.guideMetadata.calls;
  const usage = providerUsage(providerCalls);
  if (usage) execution.providerUsage = usage;
  const status = !readiness.editorialComplete
    ? "failed"
    : warnings.length
      ? "completed-with-warnings"
      : "completed";
  const empty = readiness.recommendationCount === 0;
  const reasonCode = empty
    ? "guide-has-no-recommendations"
    : status === "failed"
      ? "slot-editorial-completion-failed"
      : status === "completed-with-warnings"
        ? "guide-completed-with-warnings"
        : "guide-completed";
  const reasonExplanation = empty
    ? "La guía no contiene recomendaciones que Autopilot pueda completar."
    : status === "failed"
      ? "Uno o más slots no pudieron quedar editorialmente utilizables; los demás se conservaron."
      : status === "completed-with-warnings"
        ? "Todos los slots quedaron editorialmente listos, con fallas técnicas no bloqueantes registradas."
        : "Todos los slots quedaron editorialmente listos; los Products pendientes no bloquean la guía.";

  return guideAutopilotOutcomeSchema.parse({
    schemaVersion: 1,
    policyVersion: GUIDE_AUTOPILOT_POLICY_VERSION,
    guideId: draft.id,
    status,
    reasonCode,
    reasonExplanation,
    counts: {
      totalRecommendations: readiness.recommendationCount,
      editorialReady: readiness.editorialReadyCount,
      productResolved: readiness.productResolvedCount,
      productPending: readiness.productPendingCount,
      affiliateReady,
      affiliatePending: productBacked.length - affiliateReady,
      genericRecommendations: readiness.productPendingCount,
      slotsWithWarnings: slots.filter((slot) => slot.warnings.length).length,
    },
    execution,
    slots,
    warnings,
  });
}
