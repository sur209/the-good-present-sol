import type { ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideDraft } from "./drafts.ts";
import {
  createFinalPromptInput,
  finalPromptInputSchema,
  finalRecommendationInputSchema,
} from "./final-prompt.ts";

export const RECOMMENDATION_PROMPT_VERSION = "single-recommendation-v4";
export const RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION = "single-recommendation-field-repair-v1";

export const productBackedCopyFieldSchema = z.enum([
  "heading",
  "editorialDescription",
  "whyItFits",
  "bestFor",
  "considerations",
]);

export const recommendationFieldRepairSchema = z.strictObject({
  value: z.string().trim().min(1),
});

export const recommendationFieldRepairInputSchema = z.strictObject({
  language: z.literal("en-US"),
  field: productBackedCopyFieldSchema,
  product: z.strictObject({
    name: z.string().trim().min(1),
    brand: z.string().trim().min(1).optional(),
    verifiedFacts: z.array(z.string().trim().min(1)),
  }),
  productClass: z.string().trim().min(1),
  slotPurpose: z.string().trim().min(1).optional(),
  guide: z.strictObject({
    title: z.string().trim().min(1),
    primaryIntent: z.string().trim().min(1),
    audience: z.string().trim().min(1).optional(),
    editorialAngle: z.string().trim().min(1).optional(),
  }),
});

export const recommendationPromptInputSchema = finalPromptInputSchema
  .omit({ recommendations: true })
  .extend({ recommendation: finalRecommendationInputSchema });

export type RecommendationPromptInput = z.infer<typeof recommendationPromptInputSchema>;
export type ProductBackedCopyField = z.infer<typeof productBackedCopyFieldSchema>;
export type RecommendationFieldRepairInput = z.infer<typeof recommendationFieldRepairInputSchema>;

export interface PreparedRecommendationPrompt {
  version: typeof RECOMMENDATION_PROMPT_VERSION;
  input: RecommendationPromptInput;
  prompt: string;
}

export interface PreparedRecommendationFieldRepairPrompt {
  version: typeof RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION;
  input: RecommendationFieldRepairInput;
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
Return exactly these fields and no aliases or extra fields: id (required non-empty string), productId (required non-empty string), position (required positive integer), editorialDescription (required non-empty string), whyItFits (required non-empty string), plus heading, bestFor, and considerations as optional non-empty strings. Optional fields may be omitted or null; null is normalized to omission.
Use this compact object-shape example:
${JSON.stringify(shape)}

Rules:
- Write original, natural US English and use USD context.
- Mention only the one selected product in the structured input.
- Preserve its exact product name, product ID, recommendation ID, and position.
- Treat the Product name, brand, and Product class as identity only. Derive factual Product claims exclusively from verifiedFacts.
- Never treat measurements, materials, formulation, certification, or usage claims embedded in the Product name as verified facts.
- Never add a product or return any URL, including an affiliate URL.
- Never invent prices, ratings, reviews, discounts, stock, availability, or specifications.
- Preserve existingCopy's concrete gift concept and sound editorial heading; use the selected Product only to enrich the recommendation.
- Keep the supplied purpose and write only from the supplied Product identity, Product class, guide context, existingCopy, and verifiedFacts.
- Write public prose only. Never mention a slot, Product slot, option for the slot, resolved Product, sourcing, candidate, structured input, or editorial workflow.
- Avoid stock openings and repeated boilerplate across the guide, especially "Night-shift nurses often," "practical," "routine," and "novelty merchandise."
- Prefer experiential wording such as comfort during long shifts, support for tired legs, or easier daytime rest. Avoid physiological claims about circulation, recovery, or sleep effects unless verifiedFacts explicitly supports them.
- Sparse or empty verifiedFacts is valid. In that case, identify the Product and explain only how its class relates to the slot; do not imply that the Product achieves the slot purpose.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareRecommendationPrompt(
  draft: GuideDraft,
  recommendationId: string,
  content: ValidatedPublicContent,
): PreparedRecommendationPrompt {
  const slot = draft.recommendations.find(
    (recommendation) => recommendation.id === recommendationId,
  );
  if (!slot) throw new TypeError(`No existe la recomendación "${recommendationId}".`);
  const full = createFinalPromptInput({ ...draft, recommendations: [slot] }, content);
  const { recommendations: _recommendations, ...context } = full;
  const input = recommendationPromptInputSchema.parse({
    ...context,
    recommendation: full.recommendations[0],
  });
  return {
    version: RECOMMENDATION_PROMPT_VERSION,
    input,
    prompt: buildRecommendationPrompt(input),
  };
}

export function prepareRecommendationFieldRepairPrompt(
  draft: GuideDraft,
  recommendationId: string,
  field: ProductBackedCopyField,
  content: ValidatedPublicContent,
): PreparedRecommendationFieldRepairPrompt {
  const slot = draft.recommendations.find(({ id }) => id === recommendationId);
  if (!slot?.productId) throw new TypeError("Field repair requires an assigned Product.");
  const product = content.products.find(({ id }) => id === slot.productId);
  if (!product) throw new TypeError("Field repair requires a published Product.");
  const full = createFinalPromptInput({ ...draft, recommendations: [slot] }, content);
  const input = recommendationFieldRepairInputSchema.parse({
    language: "en-US",
    field,
    product: {
      name: full.recommendations[0]!.product.name,
      ...(product.brand ? { brand: product.brand } : {}),
      verifiedFacts: product.verifiedFacts ?? [],
    },
    productClass: slot.slotLabel,
    ...(slot.slotIntent ? { slotPurpose: slot.slotIntent } : {}),
    guide: {
      title: draft.title ?? draft.outline?.provisionalTitle ?? "Gift guide",
      primaryIntent: draft.primaryIntent!,
      ...(draft.questionnaire.recipient || draft.outline?.audienceSummary
        ? { audience: draft.questionnaire.recipient ?? draft.outline?.audienceSummary }
        : {}),
      ...(draft.outline?.editorialAngle ? { editorialAngle: draft.outline.editorialAngle } : {}),
    },
  });
  const prompt = `Rewrite one unsafe Product-backed recommendation field.

Return exactly one JSON object with one key, value, containing a non-empty US English string. Return no prose or Markdown.
Write only the requested field: ${field}.

Allowed evidence:
- Product identity: product.name and product.brand.
- Product class and how that class relates to the slot purpose and guide context.
- Product-specific factual claims only when stated in product.verifiedFacts.

Rules:
- Do not repeat or reconstruct the rejected text.
- Do not use listing attributes, marketing claims, measurements, materials, formulation, certification, duration, performance, body-area instructions, packaging, price, ratings, reviews, availability, merchant data, or URLs unless the exact factual claim appears in verifiedFacts.
- Sparse or empty verifiedFacts is valid. In that case, identify the Product and explain only the editorial relationship between its class and the slot.
- Do not claim that the Product achieves the slot purpose unless verifiedFacts explicitly supports that claim.
- Preserve the concrete gift concept and any sound public heading; never replace it with workflow-oriented wording.
- Never mention a slot, Product slot, option for the slot, resolved Product, sourcing, candidate, structured input, or editorial workflow.
- Avoid stock openings and repeated boilerplate, including "Night-shift nurses often," "practical," "routine," and "novelty merchandise."
- Prefer experiential comfort and rest wording over physiological claims unless verifiedFacts explicitly supports the claim.

Structured input:
${JSON.stringify(input, null, 2)}`;
  return { version: RECOMMENDATION_FIELD_REPAIR_PROMPT_VERSION, input, prompt };
}
