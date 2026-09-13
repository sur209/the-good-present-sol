import { primaryAxisSchema, type ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";
import { resolveProductClassProfile } from "./modules/product-intelligence/fit.ts";
import type { ProductSourcingRequest } from "./modules/product-intelligence/sourcing.ts";

export const IDEA_RECOMMENDATION_PROMPT_VERSION = "idea-recommendation-v5";
export const IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION = "idea-recommendation-batch-v1";

const nonEmptyText = z.string().trim().min(1);
const optionalText = nonEmptyText.optional();
const nullableOptionalText = z.preprocess(
  (value) => (value === null ? undefined : value),
  optionalText,
);
const contentId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

export const generatedIdeaRecommendationSchema = z.strictObject({
  id: contentId,
  position: z.number().int().positive(),
  heading: nonEmptyText.max(120),
  editorialDescription: nonEmptyText.max(600),
  whyItFits: nonEmptyText.max(400),
  bestFor: nonEmptyText.max(120),
  selectionGuidance: nonEmptyText.max(500),
  considerations: nullableOptionalText,
});

export const ideaRecommendationPromptInputSchema = z.strictObject({
  language: z.literal("en-US"),
  guide: z.strictObject({
    title: nonEmptyText,
    audience: optionalText,
    editorialAngle: optionalText,
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
    productClassProfile: z.strictObject({
      classId: nonEmptyText,
      importantAttributes: z.array(nonEmptyText),
      requiredAttributes: z.array(nonEmptyText),
      undesirableAttributes: z.array(nonEmptyText),
      compatibilityRisks: z.array(nonEmptyText),
      giftabilityConsiderations: z.array(nonEmptyText),
      maintenanceConsiderations: z.array(nonEmptyText),
      evaluationGuidance: z.array(nonEmptyText),
      version: z.number().int().positive(),
    }),
    audience: optionalText,
    budgetContext: optionalText,
    whatToLookFor: z.array(nonEmptyText).max(20),
    exclusions: z.array(nonEmptyText).max(20),
  }),
});

export const ideaRecommendationBatchPromptInputSchema = z.strictObject({
  language: z.literal("en-US"),
  guide: ideaRecommendationPromptInputSchema.shape.guide,
  recommendations: z.array(ideaRecommendationPromptInputSchema.shape.recommendation).min(1),
});

export type GeneratedIdeaRecommendation = z.infer<typeof generatedIdeaRecommendationSchema>;
export type IdeaRecommendationPromptInput = z.infer<typeof ideaRecommendationPromptInputSchema>;
export type IdeaRecommendationBatchPromptInput = z.infer<
  typeof ideaRecommendationBatchPromptInputSchema
>;

export interface PreparedIdeaRecommendationPrompt {
  version: typeof IDEA_RECOMMENDATION_PROMPT_VERSION;
  input: IdeaRecommendationPromptInput;
  prompt: string;
}

export interface PreparedIdeaRecommendationBatchPrompt {
  version: typeof IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION;
  input: IdeaRecommendationBatchPromptInput;
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

function sourceSpecific(
  value: string,
  content: ValidatedPublicContent,
  request?: ProductSourcingRequest,
): boolean {
  if (
    catalogSpecific(value, content) ||
    /(?:https?:\/\/|www\.|\b(?:asin\s*)?b0[a-z0-9]{8}\b)/i.test(value)
  ) {
    return true;
  }
  const text = normalized(value);
  return Boolean(
    request?.sourceCandidates.some((candidate) =>
      [
        candidate.name,
        candidate.brand,
        candidate.merchant,
        candidate.marketplace,
        candidate.externalId,
      ]
        .map((term) => normalized(term ?? ""))
        .some((term) => term.length >= 4 && text.includes(term)),
    ),
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
  const productClass = sourceSpecific(rawProductClass, content, request)
    ? "Gift idea"
    : rawProductClass;
  const profile = resolveProductClassProfile(productClass);
  const whatToLookFor = [
    ...(slot.searchTerms ?? []).filter((term) => !sourceSpecific(term, content, request)),
    ...profile.importantAttributes,
    ...profile.requiredAttributes,
    ...profile.giftabilityConsiderations,
  ];
  const exclusions = [
    ...profile.undesirableAttributes,
    ...profile.compatibilityRisks,
    ...(draft.questionnaire.avoid ? [draft.questionnaire.avoid] : []),
  ];

  return ideaRecommendationPromptInputSchema.parse({
    language: "en-US",
    guide: {
      title: draft.title ?? draft.outline?.provisionalTitle ?? "Gift guide",
      ...(draft.outline?.audienceSummary || draft.questionnaire.recipient
        ? { audience: draft.outline?.audienceSummary ?? draft.questionnaire.recipient }
        : {}),
      ...(draft.outline?.editorialAngle ? { editorialAngle: draft.outline.editorialAngle } : {}),
      primaryAxis: draft.primaryAxis,
      primaryIntent: draft.primaryIntent,
      ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
      ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
      questionnaire: draft.questionnaire,
    },
    recommendation: {
      id: slot.id,
      position: slot.position,
      slotLabel: sourceSpecific(slot.slotLabel, content, request) ? productClass : slot.slotLabel,
      ...(slot.slotIntent && !sourceSpecific(slot.slotIntent, content, request)
        ? { slotIntent: slot.slotIntent }
        : {}),
      productClass,
      productClassProfile: {
        classId: profile.classId,
        importantAttributes: profile.importantAttributes,
        requiredAttributes: profile.requiredAttributes,
        undesirableAttributes: profile.undesirableAttributes,
        compatibilityRisks: profile.compatibilityRisks,
        giftabilityConsiderations: profile.giftabilityConsiderations,
        maintenanceConsiderations: profile.maintenanceConsiderations,
        evaluationGuidance: profile.evaluationGuidance,
        version: profile.version,
      },
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

const ideaRecommendationShape = {
  id: "unchanged recommendation ID",
  position: 1,
  heading: "Generic gift-idea heading",
  editorialDescription: "Useful consumer guidance about the idea",
  whyItFits: "Why the idea serves this slot and audience",
  bestFor: "Who this idea suits best",
  selectionGuidance: "Attributes to compare when choosing",
  considerations: "Optional tradeoffs or exclusions",
};

const ideaRecommendationFieldContract = `- id: required non-empty string; copy the supplied recommendation ID exactly.
- position: required positive integer; copy the supplied position exactly.
- heading: required non-empty string, at most 120 characters.
- editorialDescription: required non-empty string, at most 600 characters.
- whyItFits: required non-empty string, at most 400 characters.
- bestFor: required non-empty string, at most 120 characters.
- selectionGuidance: required non-empty string, at most 500 characters.
- considerations: optional non-empty string. Omit it or return null when there is no useful consideration; null is normalized to omission.
Stay comfortably below the hard limits: target at most 80 characters for heading, 450 for editorialDescription, 300 for whyItFits, 90 for bestFor, and 350 for selectionGuidance.`;

const ideaRecommendationEditorialRules = `Rules:
- Write original, useful, natural US English.
- Preserve each supplied recommendation ID and position.
- Present gift ideas and practical selection guidance, never specific Product endorsements.
- Include a concise bestFor description grounded only in the supplied audience and recommendation context.
- Keep headings short and specific; never append or repeat the complete audience description.
- Write public editorial prose. Never mention a slot, Product class, recommendation purpose, structured input, or editorial system.
- Explain each idea naturally instead of prefixing or mechanically restating the supplied intent.
- Use only the recommendation, Guide, audience, budget, Product class, what-to-look-for, and exclusion context supplied below.
- Never name a Product, brand, model, merchant, marketplace, or affiliate program.
- Never return a URL, shopping CTA, price, rating, review count, discount, stock, or availability claim.
- Never present a Product-specific measurement or specification as fact.
- Never invent a numeric threshold, professional policy, medical claim, or safety claim.
- Avoid stock openings and repeated boilerplate across the guide. Vary sentence structure, phrasing, and openings, especially around "Night-shift nurses often," "practical," "routine," and "novelty merchandise."
- Prefer experiential wording such as comfort during long shifts, support for tired legs, or easier daytime rest. Avoid claims about circulation, recovery, sleep effects, or other physiological outcomes.
- For notebooks and journals, suggest only learning notes, non-sensitive reminders, questions for a preceptor, study points, or permitted task reminders. Never encourage storing patient-identifying or confidential information.
- Do not use placeholder copy. Explain what makes a good choice and relevant tradeoffs.`;

export function buildIdeaRecommendationPrompt(input: IdeaRecommendationPromptInput): string {
  const validated = ideaRecommendationPromptInputSchema.parse(input);
  return `Write one idea-only recommendation for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Return exactly these keys; do not add aliases or extra keys.
Exact output contract:
${ideaRecommendationFieldContract}
Use this exact object-shape example:
${JSON.stringify(ideaRecommendationShape)}

${ideaRecommendationEditorialRules}

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function buildIdeaRecommendationBatchPrompt(
  input: IdeaRecommendationBatchPromptInput,
): string {
  const validated = ideaRecommendationBatchPromptInputSchema.parse(input);
  const shape = { recommendations: [ideaRecommendationShape] };
  return `Write all requested idea-only recommendations for one The Good Present guide in a single batch.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
The object must contain exactly one key named recommendations.
recommendations must contain exactly one result for every supplied recommendation, in the same order. Do not omit, duplicate, merge, or add results.
Every result must contain exactly the keys in this contract; do not add aliases or extra keys.
Exact per-result output contract:
${ideaRecommendationFieldContract}
Use this exact object-shape example:
${JSON.stringify(shape)}

${ideaRecommendationEditorialRules}
- Make every recommendation specific to its own gift concept, audience fit, choosing criteria, and useful tradeoffs.
- Review the full batch before returning it and remove repeated openings, sentence patterns, and interchangeable filler.

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

export function prepareIdeaRecommendationBatchPrompt(
  draft: GuideDraft,
  recommendationIds: readonly string[],
  content: ValidatedPublicContent,
  requests: ReadonlyMap<string, ProductSourcingRequest> = new Map(),
): PreparedIdeaRecommendationBatchPrompt {
  if (!recommendationIds.length) throw new TypeError("The idea-only batch cannot be empty.");
  const inputs = recommendationIds.map((id) =>
    createIdeaRecommendationPromptInput(draft, id, content, requests.get(id)),
  );
  const input = ideaRecommendationBatchPromptInputSchema.parse({
    language: "en-US",
    guide: inputs[0]!.guide,
    recommendations: inputs.map(({ recommendation }) => recommendation),
  });
  return {
    version: IDEA_RECOMMENDATION_BATCH_PROMPT_VERSION,
    input,
    prompt: buildIdeaRecommendationBatchPrompt(input),
  };
}
