import { randomUUID } from "node:crypto";

import {
  guidePath,
  type GiftGuide,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import type { GuideGenerationProvider } from "./ai-provider.ts";
import {
  DEFAULT_GIFT_COUNT,
  guideDraftSchema,
  guideOutlineSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
  type GuideQuestionnaire,
} from "./drafts.ts";
import {
  generatedRecommendationSchema,
  generatedGuideSchema,
  prepareFinalPrompt,
  type GeneratedGuide,
} from "./final-prompt.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  prepareRecommendationPrompt,
  RECOMMENDATION_PROMPT_VERSION,
} from "./recommendation-prompt.ts";

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
    }),
  );
  rejectGeneratedUrls(generated);
  assertExactRecommendations(draft, generated);
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
        considerations: _considerations,
        editorialStatus: _editorialStatus,
        ...slot
      } = existing;
      return { ...slot, ...recommendation, editorialStatus: "ready" };
    }),
    generationMetadata: {
      providerId: provider.providerId,
      ...(provider.modelId ? { modelId: provider.modelId } : {}),
      generatedAt: now.toISOString(),
      promptVersion: prepared.version,
      prompt: prepared.prompt,
      validation: { success: true },
    },
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
  const generated = generatedRecommendationSchema.parse(
    await provider.generateStructured({
      operation: "single-recommendation",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: generatedRecommendationSchema,
    }),
  );
  rejectGeneratedUrls(generated);
  const index = recommendationIndex(draft, recommendationId);
  const existing = draft.recommendations[index]!;
  if (
    generated.id !== existing.id ||
    generated.productId !== existing.productId ||
    generated.position !== existing.position
  ) {
    throw new TypeError("La respuesta cambió la identidad de la recomendación.");
  }
  const {
    heading: _heading,
    editorialDescription: _editorialDescription,
    whyItFits: _whyItFits,
    bestFor: _bestFor,
    considerations: _considerations,
    editorialStatus: _editorialStatus,
    ...slot
  } = existing;
  const recommendations = [...draft.recommendations];
  recommendations[index] = { ...slot, ...generated, editorialStatus: "ready" };
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations,
    generationMetadata: {
      providerId: provider.providerId,
      ...(provider.modelId ? { modelId: provider.modelId } : {}),
      generatedAt: now.toISOString(),
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      prompt: prepared.prompt,
      validation: { success: true },
    },
  });
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
  const updated = { ...current, ...copy };
  if (markReady && (!updated.productId || !updated.editorialDescription || !updated.whyItFits)) {
    throw new TypeError(
      "Para marcarla lista se requieren producto, descripción editorial y motivo de elección.",
    );
  }
  const recommendations = [...draft.recommendations];
  recommendations[index] = {
    ...updated,
    editorialStatus: markReady ? "ready" : current.editorialStatus,
  };
  return guideDraftSchema.parse({ ...draft, status: "editing", recommendations });
}

export interface GuideDraftValidation {
  errors: string[];
  route?: string;
}

export function validateGuideDraft(
  draft: GuideDraft,
  content: ValidatedPublicContent,
): GuideDraftValidation {
  const errors: string[] = [];
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
    if (!recommendation.productId) {
      errors.push(`El slot "${recommendation.slotLabel}" no tiene producto.`);
      continue;
    }
    const product = content.products.find((item) => item.id === recommendation.productId);
    if (!product || product.status !== "active") {
      errors.push(`El producto "${recommendation.productId}" no existe o está inactivo.`);
    }
    if (recommendation.editorialStatus !== "ready") {
      errors.push(`El slot "${recommendation.slotLabel}" no está listo para publicar.`);
    }
    if (!recommendation.editorialDescription || !recommendation.whyItFits) {
      errors.push(`El slot "${recommendation.slotLabel}" necesita descripción y motivo.`);
    }
  }

  return { errors, ...(route ? { route } : {}) };
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
        const product = products.get(recommendation.productId)!;
        return {
          id: recommendation.id,
          position: recommendation.position,
          slotLabel: recommendation.heading ?? product.name,
          slotIntent: recommendation.whyItFits,
          searchTerms: [product.name, product.merchant],
          productId: recommendation.productId,
          ...(recommendation.heading ? { heading: recommendation.heading } : {}),
          editorialDescription: recommendation.editorialDescription,
          whyItFits: recommendation.whyItFits,
          ...(recommendation.bestFor ? { bestFor: recommendation.bestFor } : {}),
          ...(recommendation.considerations
            ? { considerations: recommendation.considerations }
            : {}),
          editorialStatus: "ready",
        };
      }),
  });
}
