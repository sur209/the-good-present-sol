import type { ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideDraft } from "./drafts.ts";
import {
  createFinalPromptInput,
  finalPromptInputSchema,
  finalRecommendationInputSchema,
  type FinalPromptInput,
} from "./final-prompt.ts";

export const RECOMMENDATION_PROMPT_VERSION = "single-recommendation-v1";

export const recommendationPromptInputSchema = finalPromptInputSchema
  .omit({ recommendations: true })
  .extend({ recommendation: finalRecommendationInputSchema });

export type RecommendationPromptInput = z.infer<typeof recommendationPromptInputSchema>;

export interface PreparedRecommendationPrompt {
  version: typeof RECOMMENDATION_PROMPT_VERSION;
  input: RecommendationPromptInput;
  prompt: string;
}

export function buildRecommendationPrompt(input: RecommendationPromptInput): string {
  const validated = recommendationPromptInputSchema.parse(input);
  const shape = {
    id: "unchanged recommendation ID",
    productId: "unchanged selected product ID",
    position: 1,
    heading: "Editorial heading",
    editorialDescription: "Original product-grounded description",
    whyItFits: "Why it serves this slot",
    bestFor: "Optional best-for label",
    considerations: "Optional verified consideration",
  };
  return `Rewrite exactly one recommendation for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Use this compact object-shape example:
${JSON.stringify(shape)}

Rules:
- Write original, natural US English and use USD context.
- Mention only the one selected product in the structured input.
- Preserve its exact product name, product ID, recommendation ID, and position.
- Use only the supplied merchant, short description, verified facts, and price label.
- Never add a product or return any URL, including an affiliate URL.
- Never invent prices, ratings, reviews, discounts, stock, availability, or specifications.
- Keep the slot purpose and improve existing copy when present.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareRecommendationPrompt(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
): PreparedRecommendationPrompt {
  const full: FinalPromptInput = createFinalPromptInput(draft, content);
  const recommendation = full.recommendations.find(
    (item) => item.recommendationId === recommendationId,
  );
  if (!recommendation) throw new TypeError(`No existe la recomendación "${recommendationId}".`);
  const { recommendations: _recommendations, ...context } = full;
  const input = recommendationPromptInputSchema.parse({ ...context, recommendation });
  return {
    version: RECOMMENDATION_PROMPT_VERSION,
    input,
    prompt: buildRecommendationPrompt(input),
  };
}
