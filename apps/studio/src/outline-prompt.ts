import { primaryAxisSchema, type ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";

export const OUTLINE_PROMPT_VERSION = "outline-v1";

function stableSlotIds(draft: GuideDraft): string[] {
  const existing = [...draft.recommendations].sort((left, right) => left.position - right.position);
  const used = new Set(existing.map((recommendation) => recommendation.id));
  return Array.from({ length: draft.questionnaire.giftCount }, (_, index) => {
    const existingId = existing[index]?.id;
    if (existingId) return existingId;
    const base = `${draft.id}_slot-${index + 1}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return id;
  });
}

export const outlinePromptInputSchema = z
  .strictObject({
    language: z.literal("en-US"),
    currency: z.literal("USD"),
    cluster: z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      excerpt: z.string().min(1),
      introduction: z.string().min(1),
    }),
    primaryAxis: primaryAxisSchema,
    primaryIntent: z.string().trim().min(1),
    taxonomies: draftTaxonomiesSchema.optional(),
    budgetContext: draftBudgetContextSchema.optional(),
    questionnaire: guideQuestionnaireSchema,
    requestedRecommendationCount: z.number().int().min(3).max(20),
    slotIds: z.array(z.string().trim().min(1)).min(3).max(20),
  })
  .superRefine((input, context) => {
    if (input.slotIds.length !== input.requestedRecommendationCount) {
      context.addIssue({
        code: "custom",
        path: ["slotIds"],
        message: "The server-assigned slot ID count must match the requested recommendation count.",
      });
    }
    if (new Set(input.slotIds).size !== input.slotIds.length) {
      context.addIssue({
        code: "custom",
        path: ["slotIds"],
        message: "Server-assigned slot IDs must be unique.",
      });
    }
  });

export type OutlinePromptInput = z.infer<typeof outlinePromptInputSchema>;

export interface PreparedOutlinePrompt {
  version: typeof OUTLINE_PROMPT_VERSION;
  input: OutlinePromptInput;
  prompt: string;
}

export function buildOutlinePrompt(input: OutlinePromptInput): string {
  const validated = outlinePromptInputSchema.parse(input);
  const shape = {
    provisionalTitle: "Natural US English title",
    audienceSummary: "Who this guide helps",
    editorialAngle: "How the slots work together",
    recommendationCount: validated.requestedRecommendationCount,
    slots: [
      {
        id: validated.slotIds[0]!,
        label: "Generic gift-slot label",
        intent: "Need this slot addresses",
        searchTerms: ["catalog search term"],
        budgetHint: "optional USD context",
      },
    ],
  };
  return `You create a gift-guide outline for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Use this compact object-shape example (the slots array must contain exactly the requested count):
${JSON.stringify(shape)}

Rules:
- Write public-facing text in natural US English and use USD context.
- Make conservative assumptions when optional information is missing.
- Respect the selected cluster, primary axis, primary intent, taxonomies, budget, and questionnaire.
- Generate only an outline and editorial gift slots with catalog search terms.
- Do not select or name a commercial product, merchant, affiliate URL, price, rating, review, discount, stock state, availability claim, or unsupported specification.
- Do not write the complete guide or product-specific claims.
- Do not suggest additional public pages, taxonomy combinations, routes, or article ideas.
- Preserve the supplied slot IDs exactly and return them in the supplied order.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareOutlinePrompt(
  draft: GuideDraft,
  content: ValidatedPublicContent,
): PreparedOutlinePrompt {
  if (!draft.clusterId) throw new TypeError("Elegí un cluster antes de generar el esquema.");
  const cluster = content.clusters.find((item) => item.id === draft.clusterId);
  if (!cluster) throw new TypeError("El cluster elegido no está publicado.");
  if (!draft.primaryAxis)
    throw new TypeError("Elegí un eje principal antes de generar el esquema.");
  if (!draft.primaryIntent) {
    throw new TypeError("Definí la intención principal antes de generar el esquema.");
  }

  const input = outlinePromptInputSchema.parse({
    language: "en-US",
    currency: "USD",
    cluster: {
      id: cluster.id,
      title: cluster.title,
      excerpt: cluster.excerpt,
      introduction: cluster.introduction,
    },
    primaryAxis: draft.primaryAxis,
    primaryIntent: draft.primaryIntent,
    ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
    ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
    questionnaire: draft.questionnaire,
    requestedRecommendationCount: draft.questionnaire.giftCount,
    slotIds: stableSlotIds(draft),
  });
  return { version: OUTLINE_PROMPT_VERSION, input, prompt: buildOutlinePrompt(input) };
}
