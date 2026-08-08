import { randomUUID } from "node:crypto";

import type { ValidatedPublicContent } from "@the-good-present/content-schema";

import type { GuideGenerationProvider } from "./ai-provider.ts";
import {
  DEFAULT_GIFT_COUNT,
  guideDraftSchema,
  guideOutlineSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
  type GuideQuestionnaire,
} from "./drafts.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";

type QuestionnaireInput = Partial<Record<keyof GuideQuestionnaire, string | undefined>>;

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

export async function generateGuideOutline(
  draft: GuideDraft,
  content: ValidatedPublicContent,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<GuideDraft> {
  if (draft.recommendations.some((recommendation) => recommendation.productId)) {
    throw new TypeError("Quitá las selecciones de productos antes de regenerar el esquema.");
  }
  const prepared = prepareOutlinePrompt(draft, content);
  const generated = await provider.generateStructured({
    operation: "outline",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: guideOutlineSchema,
  });
  const outline = guideOutlineSchema.parse(generated);
  return guideDraftSchema.parse({
    ...draft,
    status: "outline-ready",
    outline,
    generationMetadata: {
      providerId: provider.providerId,
      ...(provider.modelId ? { modelId: provider.modelId } : {}),
      generatedAt: now.toISOString(),
      promptVersion: prepared.version,
      prompt: prepared.prompt,
      validation: { success: true },
    },
    recommendations: outline.slots.map((slot, index) => ({
      id: slot.id,
      position: index + 1,
      slotLabel: slot.label,
      slotIntent: slot.intent,
      searchTerms: slot.searchTerms,
      ...(slot.budgetHint ? { budgetHint: slot.budgetHint } : {}),
      editorialStatus: "unassigned",
    })),
  });
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
  recommendations[index] = {
    ...recommendation,
    productId,
    editorialStatus: recommendation.productId ? "needs-review" : "needs-generation",
  };
  return guideDraftSchema.parse({ ...draft, status: "selecting-products", recommendations });
}

export function clearRecommendationProduct(
  draft: GuideDraft,
  recommendationId: string,
): GuideDraft {
  const index = recommendationIndex(draft, recommendationId);
  const recommendation = draft.recommendations[index]!;
  const { productId: _productId, ...withoutProduct } = recommendation;
  const recommendations = [...draft.recommendations];
  recommendations[index] = { ...withoutProduct, editorialStatus: "unassigned" };
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
        editorialStatus: "unassigned",
      },
    ],
  });
}
