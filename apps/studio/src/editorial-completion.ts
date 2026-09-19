import type { ValidatedEditorialContent } from "@the-good-present/content-schema";
import { z } from "zod";

import type {
  GuideGenerationProvider,
  ProviderCallMetadata,
  StructuredGenerationRequest,
} from "./ai-provider.ts";
import { StaleDraftError, type DraftStore } from "./draft-store.ts";
import {
  editorialCompletionExecutionSchema,
  editorialCompletionStatusSchema,
  guideDraftSchema,
  type GuideDraft,
} from "./drafts.ts";
import {
  completeGuideEditorialMetadata,
  generateIdeaOnlyRecommendationBatchWithRecovery,
  guideDraftReadiness,
  guideEditorialMetadataIsComplete,
  ideaOnlyRecommendationNeedsCopyRepair,
  recommendationIsEditoriallyReady,
} from "./guide-editor.ts";

export const EDITORIAL_COMPLETION_POLICY_VERSION = "editorial-completion-v1";

export const editorialCompletionOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(EDITORIAL_COMPLETION_POLICY_VERSION),
  guideId: z.string().trim().min(1),
  status: editorialCompletionStatusSchema,
  reasonCode: z.enum([
    "guide-completed",
    "guide-completed-with-warnings",
    "guide-has-no-recommendations",
    "editorial-completion-failed",
  ]),
  counts: z.strictObject({
    totalRecommendations: z.number().int().nonnegative(),
    editorialReady: z.number().int().nonnegative(),
  }),
  execution: editorialCompletionExecutionSchema,
  slots: z.array(
    z.strictObject({
      slotId: z.string().trim().min(1),
      position: z.number().int().positive(),
      action: z.enum([
        "preserved-ready-copy",
        "generated-idea-copy",
        "product-copy-requires-enrichment",
      ]),
      editorialReady: z.boolean(),
      warnings: z.array(z.string().trim().min(1)),
    }),
  ),
  warnings: z.array(z.string().trim().min(1)),
});

export type EditorialCompletionOutcome = z.infer<typeof editorialCompletionOutcomeSchema>;

export interface EditorialCompletionDependencies {
  content: ValidatedEditorialContent;
  draftStore: DraftStore;
  provider: GuideGenerationProvider;
}

type ProviderCategory = "editorial" | "guideMetadata";

interface ProviderCounter {
  calls: number;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

function addProviderUsage(counter: ProviderCounter, metadata?: ProviderCallMetadata): void {
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = metadata?.[key];
    if (value !== undefined) counter.usage[key] = (counter.usage[key] ?? 0) + value;
  }
}

function observedProvider(
  provider: GuideGenerationProvider,
  counters: Record<ProviderCategory, ProviderCounter>,
  invocations: { batch: number; repair: number },
): GuideGenerationProvider {
  return {
    providerId: provider.providerId,
    ...(provider.modelId ? { modelId: provider.modelId } : {}),
    get lastCallMetadata() {
      return provider.lastCallMetadata;
    },
    async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
      if (request.operation === "idea-recommendation-batch") invocations.batch++;
      if (request.operation === "idea-recommendation-batch-repair") invocations.repair++;
      const counter =
        counters[request.operation === "guide-metadata" ? "guideMetadata" : "editorial"];
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

function providerUsage(counters: Record<ProviderCategory, ProviderCounter>) {
  const usage = Object.fromEntries(
    Object.entries(counters)
      .filter(([, counter]) => Object.keys(counter.usage).length)
      .map(([category, counter]) => [category, counter.usage]),
  );
  return Object.keys(usage).length ? usage : undefined;
}

async function readGuideDraft(store: DraftStore, id: string): Promise<GuideDraft> {
  return guideDraftSchema.parse(await store.read(id));
}

export async function completeGuideEditorially(
  initialDraft: GuideDraft,
  dependencies: EditorialCompletionDependencies,
  now = new Date(),
): Promise<EditorialCompletionOutcome> {
  let draft = guideDraftSchema.parse(initialDraft);
  const counters: Record<ProviderCategory, ProviderCounter> = {
    editorial: { calls: 0, usage: {} },
    guideMetadata: { calls: 0, usage: {} },
  };
  const invocations = { batch: 0, repair: 0 };
  const provider = observedProvider(dependencies.provider, counters, invocations);
  const guideWarnings: string[] = [];
  const slotWarnings = new Map<string, string[]>();

  if (draft.recommendations.length && !guideEditorialMetadataIsComplete(draft)) {
    const completion = await completeGuideEditorialMetadata(
      draft,
      dependencies.content,
      provider,
      now,
    );
    try {
      await dependencies.draftStore.save(completion.draft, now, draft);
      draft = await readGuideDraft(dependencies.draftStore, draft.id);
      guideWarnings.push(...completion.warnings);
    } catch (error) {
      if (error instanceof StaleDraftError) throw error;
      guideWarnings.push("guide-metadata-save-failed");
    }
  }

  const recommendationIds = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .filter(
      (slot) =>
        !slot.productId &&
        (ideaOnlyRecommendationNeedsCopyRepair(draft, slot.id) ||
          !recommendationIsEditoriallyReady(slot)),
    )
    .map(({ id }) => id);
  if (recommendationIds.length) {
    try {
      const completion = await generateIdeaOnlyRecommendationBatchWithRecovery(
        draft,
        recommendationIds,
        provider,
        now,
      );
      await dependencies.draftStore.save(completion.draft, now, draft);
      draft = await readGuideDraft(dependencies.draftStore, draft.id);
      for (const slot of completion.slots) slotWarnings.set(slot.slotId, slot.warnings);
    } catch (error) {
      if (error instanceof StaleDraftError) throw error;
      for (const id of recommendationIds) slotWarnings.set(id, ["idea-copy-repair-failed"]);
    }
  }

  const slots = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .map((slot): EditorialCompletionOutcome["slots"][number] => {
      const generatedWarnings = slotWarnings.get(slot.id);
      const warnings =
        generatedWarnings ??
        (slot.productId && !recommendationIsEditoriallyReady(slot)
          ? ["product-copy-requires-explicit-enrichment"]
          : []);
      return {
        slotId: slot.id,
        position: slot.position,
        action: generatedWarnings
          ? "generated-idea-copy"
          : slot.productId && !recommendationIsEditoriallyReady(slot)
            ? "product-copy-requires-enrichment"
            : "preserved-ready-copy",
        editorialReady: recommendationIsEditoriallyReady(slot),
        warnings,
      };
    });
  const readiness = guideDraftReadiness(draft);
  const warnings = [
    ...guideWarnings.map((warning) => `guide:${warning}`),
    ...slots.flatMap((slot) => slot.warnings.map((warning) => `${slot.slotId}:${warning}`)),
  ];
  const empty = readiness.recommendationCount === 0;
  const status =
    empty || !readiness.editorialComplete
      ? "failed"
      : warnings.length
        ? "completed-with-warnings"
        : "completed";
  const usage = providerUsage(counters);

  const outcome = editorialCompletionOutcomeSchema.parse({
    schemaVersion: 1,
    policyVersion: EDITORIAL_COMPLETION_POLICY_VERSION,
    guideId: draft.id,
    status,
    reasonCode: empty
      ? "guide-has-no-recommendations"
      : status === "failed"
        ? "editorial-completion-failed"
        : status === "completed-with-warnings"
          ? "guide-completed-with-warnings"
          : "guide-completed",
    counts: {
      totalRecommendations: readiness.recommendationCount,
      editorialReady: readiness.editorialReadyCount,
    },
    execution: {
      editorialCalls: counters.editorial.calls,
      editorialBatchCalls: invocations.batch,
      editorialRepairCalls: invocations.repair,
      guideMetadataCalls: counters.guideMetadata.calls,
      ...(usage ? { providerUsage: usage } : {}),
    },
    slots,
    warnings,
  });
  await dependencies.draftStore.save(
    {
      ...draft,
      latestEditorialCompletion: {
        completedAt: now.toISOString(),
        policyVersion: outcome.policyVersion,
        status: outcome.status,
        execution: outcome.execution,
        warnings: outcome.warnings,
      },
    },
    now,
    draft,
  );
  return outcome;
}
