import { productDestination } from "@the-good-present/content-schema";
import { z } from "zod";

import { guideDraftSchema, type GuideDraft } from "../../drafts.ts";
import {
  completeGuideEditorialMetadata,
  guideEditorialMetadataIsComplete,
  guideDraftReadiness,
  productClaimContext,
  productBackedCopyNeedsVerifiedFactsRepair,
  recommendationIsEditoriallyReady,
} from "../../guide-editor.ts";
import {
  autopilotResolutionOutcomeSchema,
  completeIdeaOnlyRecommendationCopy,
  completeProductBackedRecommendationCopy,
  ideaOnlyRecommendationNeedsCopyRepair,
  resolveRecommendationSlotAutonomously,
  type AutopilotDependencies,
  type AutopilotResolutionOutcome,
} from "./autopilot.ts";
import { findProductSourcingRequestForDraftSlot } from "./sourcing.ts";

export const GUIDE_AUTOPILOT_POLICY_VERSION = "guide-autopilot-v1";

// ponytail: DraftStore saves a whole Guide; keep slot execution serial until it supports CAS/merge.
export const GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS = 1;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

const compactSingleSlotOutcomeSchema = autopilotResolutionOutcomeSchema.pick({
  status: true,
  reasonCode: true,
  sourcingRequestId: true,
  productId: true,
  candidateId: true,
  resolutionStrategy: true,
  affiliateDestinationStatus: true,
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
    amazonDiscoveryCalls: z.number().int().nonnegative(),
    p2Calls: z.number().int().nonnegative(),
    productPendingFallbacks: z.number().int().nonnegative(),
    editorialGenerations: z.number().int().nonnegative(),
    nonBlockingFailures: z.number().int().nonnegative(),
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
  return compactSingleSlotOutcomeSchema.parse({
    status: result.status,
    reasonCode: result.reasonCode,
    sourcingRequestId: result.sourcingRequestId,
    ...(result.productId ? { productId: result.productId } : {}),
    ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    resolutionStrategy: result.resolutionStrategy,
    affiliateDestinationStatus: result.affiliateDestinationStatus,
  });
}

async function readGuideDraft(
  id: string,
  dependencies: Pick<AutopilotDependencies, "draftStore">,
): Promise<GuideDraft> {
  return guideDraftSchema.parse(await dependencies.draftStore.read(id));
}

function editorialGenerationCount(
  actions: readonly string[],
  warnings: readonly string[] = [],
): number {
  const productEditorialCopy =
    actions.includes("generated-product-editorial-copy") ||
    warnings.includes("product-editorial-copy-fallback-used");
  const recommendationCopy = actions.some((action) =>
    [
      "generated-product-recommendation-copy",
      "generated-safe-product-copy-fallback",
      "generated-idea-only-copy",
      "repaired-idea-only-copy-fields",
      "generated-safe-idea-only-fallback",
    ].includes(action),
  );
  return Number(productEditorialCopy) + Number(recommendationCopy);
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
  const execution = {
    maxConcurrentSlots: GUIDE_AUTOPILOT_MAX_CONCURRENT_SLOTS,
    peakConcurrentSlots: 0,
    productsReused: 0,
    productsCreated: 0,
    amazonDiscoveryCalls: 0,
    p2Calls: 0,
    productPendingFallbacks: 0,
    editorialGenerations: 0,
    nonBlockingFailures: 0,
  } as GuideAutopilotOutcome["execution"];

  if (draft.recommendations.length && !guideEditorialMetadataIsComplete(draft)) {
    const completion = await completeGuideEditorialMetadata(
      draft,
      dependencies.catalog.read(),
      dependencies.provider,
      now,
    );
    try {
      await dependencies.draftStore.save(completion.draft, now);
      draft = await readGuideDraft(draft.id, dependencies);
      execution.editorialGenerations += Number(completion.actionsPerformed.length > 0);
      guideWarnings.push(...completion.warnings);
    } catch {
      guideWarnings.push("guide-metadata-save-failed");
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

    if (
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
          dependencies,
          now,
        );
        await dependencies.draftStore.save(copy.draft, now);
        execution.editorialGenerations += editorialGenerationCount(
          copy.actionsPerformed,
          copy.warnings,
        );
        warnings.push(...copy.warnings);
      } catch {
        warnings.push("product-copy-completion-failed");
      }
    } else if (ideaOnlyRecommendationNeedsCopyRepair(draft, slot.id, content, sourcingRequest)) {
      action = "repaired-generic-idea-copy";
      try {
        const copy = await completeIdeaOnlyRecommendationCopy(
          draft,
          slot.id,
          dependencies,
          sourcingRequest,
          now,
        );
        await dependencies.draftStore.save(copy.draft, now);
        execution.editorialGenerations += editorialGenerationCount(
          copy.actionsPerformed,
          copy.warnings,
        );
        warnings.push(...copy.warnings);
      } catch {
        warnings.push("idea-copy-repair-failed");
      }
    } else if (recommendationIsEditoriallyReady(slot)) {
      action = "preserved-ready-product-pending-slot";
    } else {
      action = "single-slot-autopilot";
      try {
        const result = await resolveRecommendationSlotAutonomously(draft, slot.id, dependencies, {
          now,
        });
        singleSlotResult = compactSingleSlotResult(result);
        execution.productsReused += result.actionsPerformed.includes("reused-canonical-product")
          ? 1
          : 0;
        execution.productsCreated += result.actionsPerformed.includes("created-canonical-product")
          ? 1
          : 0;
        execution.amazonDiscoveryCalls += result.executionEvidence.providerCallCount;
        execution.p2Calls += result.executionEvidence.p2ProviderCallCount;
        execution.productPendingFallbacks += result.status === "resolved-idea-only" ? 1 : 0;
        execution.editorialGenerations += editorialGenerationCount(
          result.actionsPerformed,
          result.warnings,
        );
        warnings.push(...result.warnings);
        if (technicalFallbackReasons.has(result.reasonCode)) warnings.push(result.reasonCode);
      } catch {
        warnings.push("slot-autopilot-execution-failed");
      }
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
