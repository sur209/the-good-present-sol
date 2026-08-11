import { primaryAxisSchema, type ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";
import type { ProductSourcingRequest } from "./modules/product-intelligence/sourcing.ts";

export const IDEA_RECOMMENDATION_PROMPT_VERSION = "idea-recommendation-v1";

const nonEmptyText = z.string().trim().min(1);
const optionalText = nonEmptyText.optional();
const contentId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

export const generatedIdeaRecommendationSchema = z.strictObject({
  id: contentId,
  position: z.number().int().positive(),
  heading: nonEmptyText,
  editorialDescription: nonEmptyText,
  whyItFits: nonEmptyText,
  selectionGuidance: nonEmptyText,
  considerations: optionalText,
});

export const ideaRecommendationPromptInputSchema = z.strictObject({
  language: z.literal("en-US"),
  guide: z.strictObject({
    primaryAxis: primaryAxisSchema,
    primaryIntent: nonEmptyText,
    taxonomies: draftTaxonomiesSchema.optional(),
    budgetContext: draftBudgetContextSchema.optional(),
    questionnaire: guideQuestionnaireSchema,
  }),
  recommendation: z.strictObject({
    id: contentId,
    position: z.number().int().positive(),
    slotLabel: nonEmptyText,
    slotIntent: optionalText,
    productClass: nonEmptyText,
    audience: optionalText,
    budgetContext: optionalText,
    whatToLookFor: z.array(nonEmptyText).max(20),
    exclusions: z.array(nonEmptyText).max(20),
  }),
});

export type GeneratedIdeaRecommendation = z.infer<typeof generatedIdeaRecommendationSchema>;
export type IdeaRecommendationPromptInput = z.infer<typeof ideaRecommendationPromptInputSchema>;

export interface PreparedIdeaRecommendationPrompt {
  version: typeof IDEA_RECOMMENDATION_PROMPT_VERSION;
  input: IdeaRecommendationPromptInput;
  prompt: string;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function catalogSpecific(value: string, content: ValidatedPublicContent): boolean {
  const text = normalized(value);
  return content.products.some(
    (product) => text.includes(normalized(product.name)) || text === normalized(product.merchant),
  );
}

export function createIdeaRecommendationPromptInput(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
  request?: ProductSourcingRequest,
): IdeaRecommendationPromptInput {
  if (!draft.primaryAxis) throw new TypeError("Elegí un eje principal antes de generar la idea.");
  if (!draft.primaryIntent) throw new TypeError("Definí la intención principal antes de generar.");
  const slot = draft.recommendations.find(({ id }) => id === recommendationId);
  if (!slot) throw new TypeError(`No existe la recomendación "${recommendationId}".`);
  if (slot.productId) {
    throw new TypeError("La generación idea-only sólo acepta un slot sin Product.");
  }
  if (
    request &&
    (request.origin.kind !== "recommendation-slot" ||
      request.origin.guideDraftId !== draft.id ||
      request.origin.recommendationSlotId !== slot.id)
  ) {
    throw new TypeError("La solicitud I.2 no pertenece a este slot.");
  }

  const planned = request?.searchPlan;
  const rawProductClass = planned?.productClass ?? request?.requiredCategory ?? slot.slotLabel;
  const productClass = catalogSpecific(rawProductClass, content) ? "Gift idea" : rawProductClass;
  const whatToLookFor = [
    ...(planned?.mustHaveAttributes ?? request?.mustHaveVerifiedFacts ?? []),
    ...(planned?.usefulAttributes ?? []),
    ...(slot.searchTerms ?? []).filter((term) => !catalogSpecific(term, content)),
  ];
  const exclusions = [
    ...(planned?.exclusions ?? request?.exclusions ?? []),
    ...(draft.questionnaire.avoid ? [draft.questionnaire.avoid] : []),
  ];

  return ideaRecommendationPromptInputSchema.parse({
    language: "en-US",
    guide: {
      primaryAxis: draft.primaryAxis,
      primaryIntent: draft.primaryIntent,
      ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
      ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
      questionnaire: draft.questionnaire,
    },
    recommendation: {
      id: slot.id,
      position: slot.position,
      slotLabel: catalogSpecific(slot.slotLabel, content) ? productClass : slot.slotLabel,
      ...(slot.slotIntent && !catalogSpecific(slot.slotIntent, content)
        ? { slotIntent: slot.slotIntent }
        : {}),
      productClass,
      ...(request?.audience || draft.questionnaire.recipient
        ? { audience: request?.audience ?? draft.questionnaire.recipient }
        : {}),
      ...(request?.budgetContext || slot.budgetHint || draft.questionnaire.budget
        ? {
            budgetContext: request?.budgetContext ?? slot.budgetHint ?? draft.questionnaire.budget,
          }
        : {}),
      whatToLookFor: [...new Set(whatToLookFor)].slice(0, 20),
      exclusions: [...new Set(exclusions)].slice(0, 20),
    },
  });
}

export function buildIdeaRecommendationPrompt(input: IdeaRecommendationPromptInput): string {
  const validated = ideaRecommendationPromptInputSchema.parse(input);
  const shape = {
    id: "unchanged recommendation ID",
    position: 1,
    heading: "Generic gift-idea heading",
    editorialDescription: "Useful consumer guidance about the idea",
    whyItFits: "Why the idea serves this slot and audience",
    selectionGuidance: "Attributes to compare when choosing",
    considerations: "Optional tradeoffs or exclusions",
  };
  return `Write one idea-only recommendation for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Use this compact object-shape example:
${JSON.stringify(shape)}

Rules:
- Write original, useful, natural US English.
- Preserve the supplied recommendation ID and position.
- Present a gift idea and practical selection guidance, never a specific Product endorsement.
- Use only the slot, Guide, audience, budget, Product class, what-to-look-for, and exclusion context supplied below.
- Never name a Product, brand, model, merchant, marketplace, or affiliate program.
- Never return a URL, shopping CTA, price, rating, review count, discount, stock, or availability claim.
- Never present a Product-specific measurement or specification as fact.
- Do not use placeholder copy. Explain what makes a good choice and relevant tradeoffs.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareIdeaRecommendationPrompt(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
  request?: ProductSourcingRequest,
): PreparedIdeaRecommendationPrompt {
  const input = createIdeaRecommendationPromptInput(draft, recommendationId, content, request);
  return {
    version: IDEA_RECOMMENDATION_PROMPT_VERSION,
    input,
    prompt: buildIdeaRecommendationPrompt(input),
  };
}
