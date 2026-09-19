import {
  primaryAxisSchema,
  productDisplayName,
  type ValidatedEditorialContent,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";

export const FINAL_PROMPT_VERSION = "final-guide-v4";
export const GUIDE_METADATA_PROMPT_VERSION = "guide-metadata-v1";

const optionalText = z.string().trim().min(1).optional();
const nullableOptionalText = z.preprocess(
  (value) => (value === null ? undefined : value),
  optionalText,
);
const contentId = z.string().trim().min(1);

export const generatedRecommendationSchema = z.strictObject({
  id: contentId,
  productId: contentId,
  position: z.number().int().positive(),
  heading: nullableOptionalText,
  editorialDescription: z.string().trim().min(1),
  whyItFits: z.string().trim().min(1),
  bestFor: nullableOptionalText,
  considerations: nullableOptionalText,
});

export const generatedGuideSchema = z.strictObject({
  title: z.string().trim().min(1),
  excerpt: z.string().trim().min(1),
  introduction: z.string().trim().min(1),
  conclusion: optionalText,
  seoTitle: z.string().trim().min(1),
  seoDescription: z.string().trim().min(1),
  recommendations: z.array(generatedRecommendationSchema).min(1),
});

export const generatedGuideMetadataSchema = z.strictObject({
  excerpt: z.string().trim().min(1).max(240),
  introduction: z.string().trim().min(1).max(1_200),
  seoTitle: z.string().trim().min(1).max(70),
  seoDescription: z.string().trim().min(1).max(180),
});

const existingRecommendationCopySchema = z.strictObject({
  heading: optionalText,
  editorialDescription: optionalText,
  whyItFits: optionalText,
  bestFor: optionalText,
  considerations: optionalText,
});

export const finalRecommendationInputSchema = z.strictObject({
  recommendationId: contentId,
  position: z.number().int().positive(),
  slotLabel: z.string().trim().min(1),
  slotIntent: optionalText,
  searchTerms: z.array(z.string().trim().min(1)).optional(),
  budgetHint: optionalText,
  product: z.strictObject({
    id: contentId,
    name: z.string().trim().min(1),
    verifiedFacts: z.array(z.string().trim().min(1)).optional(),
  }),
  existingCopy: existingRecommendationCopySchema.optional(),
});

export const finalPromptInputSchema = z.strictObject({
  language: z.literal("en-US"),
  currency: z.literal("USD"),
  cluster: z.strictObject({
    id: contentId,
    title: z.string().trim().min(1),
    excerpt: z.string().trim().min(1),
    introduction: z.string().trim().min(1),
  }),
  guide: z.strictObject({
    id: contentId,
    slug: optionalText,
    primaryAxis: primaryAxisSchema,
    primaryIntent: z.string().trim().min(1),
    taxonomies: draftTaxonomiesSchema.optional(),
    budgetContext: draftBudgetContextSchema.optional(),
    questionnaire: guideQuestionnaireSchema,
    approvedOutline: z.strictObject({
      provisionalTitle: optionalText,
      audienceSummary: optionalText,
      editorialAngle: optionalText,
      slots: z
        .array(
          z.strictObject({
            id: contentId,
            position: z.number().int().positive(),
            label: z.string().trim().min(1),
            intent: optionalText,
          }),
        )
        .min(1),
    }),
    existingCopy: z.strictObject({
      title: optionalText,
      excerpt: optionalText,
      introduction: optionalText,
      conclusion: optionalText,
      seoTitle: optionalText,
      seoDescription: optionalText,
    }),
  }),
  recommendations: z.array(finalRecommendationInputSchema).min(1),
});

export type GeneratedGuide = z.infer<typeof generatedGuideSchema>;
export type FinalPromptInput = z.infer<typeof finalPromptInputSchema>;

export const guideMetadataPromptInputSchema = z.strictObject({
  language: z.literal("en-US"),
  missingFields: z.array(z.enum(["excerpt", "introduction", "seoTitle", "seoDescription"])),
  cluster: finalPromptInputSchema.shape.cluster,
  guide: finalPromptInputSchema.shape.guide.pick({
    id: true,
    primaryAxis: true,
    primaryIntent: true,
    taxonomies: true,
    budgetContext: true,
    questionnaire: true,
    approvedOutline: true,
    existingCopy: true,
  }),
  title: z.string().trim().min(1),
});

export type GuideMetadataPromptInput = z.infer<typeof guideMetadataPromptInputSchema>;

export interface PreparedFinalPrompt {
  version: typeof FINAL_PROMPT_VERSION;
  input: FinalPromptInput;
  prompt: string;
}

export function createFinalPromptInput(
  draft: GuideDraft,
  content: ValidatedPublicContent,
): FinalPromptInput {
  if (!draft.clusterId) throw new TypeError("Elegí un cluster antes de generar la guía final.");
  const cluster = content.clusters.find((item) => item.id === draft.clusterId);
  if (!cluster) throw new TypeError("El cluster elegido no está publicado.");
  if (!draft.primaryAxis)
    throw new TypeError("Elegí un eje principal antes de generar la guía final.");
  if (!draft.primaryIntent) throw new TypeError("Definí la intención principal antes de generar.");
  if (draft.recommendations.length === 0) throw new TypeError("La guía no tiene recomendaciones.");

  const recommendations = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .map((recommendation) => {
      if (!recommendation.productId) {
        throw new TypeError(`El slot "${recommendation.slotLabel}" no tiene producto.`);
      }
      const product = content.products.find((item) => item.id === recommendation.productId);
      if (!product || product.status !== "active") {
        throw new TypeError(`El producto "${recommendation.productId}" no existe o está inactivo.`);
      }
      const existingCopy = {
        ...(recommendation.heading ? { heading: recommendation.heading } : {}),
        ...(recommendation.editorialDescription
          ? { editorialDescription: recommendation.editorialDescription }
          : {}),
        ...(recommendation.whyItFits ? { whyItFits: recommendation.whyItFits } : {}),
        ...(recommendation.bestFor ? { bestFor: recommendation.bestFor } : {}),
        ...(recommendation.considerations ? { considerations: recommendation.considerations } : {}),
      };
      return {
        recommendationId: recommendation.id,
        position: recommendation.position,
        slotLabel: recommendation.slotLabel,
        ...(recommendation.slotIntent ? { slotIntent: recommendation.slotIntent } : {}),
        ...(recommendation.searchTerms ? { searchTerms: recommendation.searchTerms } : {}),
        ...(recommendation.budgetHint ? { budgetHint: recommendation.budgetHint } : {}),
        product: {
          id: product.id,
          name: productDisplayName(product),
          ...(product.verifiedFacts ? { verifiedFacts: product.verifiedFacts } : {}),
        },
        ...(Object.keys(existingCopy).length ? { existingCopy } : {}),
      };
    });

  return finalPromptInputSchema.parse({
    language: "en-US",
    currency: "USD",
    cluster: {
      id: cluster.id,
      title: cluster.title,
      excerpt: cluster.excerpt,
      introduction: cluster.introduction,
    },
    guide: {
      id: draft.id,
      ...(draft.slug ? { slug: draft.slug } : {}),
      primaryAxis: draft.primaryAxis,
      primaryIntent: draft.primaryIntent,
      ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
      ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
      questionnaire: draft.questionnaire,
      approvedOutline: {
        ...(draft.outline?.provisionalTitle
          ? { provisionalTitle: draft.outline.provisionalTitle }
          : {}),
        ...(draft.outline?.audienceSummary
          ? { audienceSummary: draft.outline.audienceSummary }
          : {}),
        ...(draft.outline?.editorialAngle ? { editorialAngle: draft.outline.editorialAngle } : {}),
        slots: recommendations.map((recommendation) => ({
          id: recommendation.recommendationId,
          position: recommendation.position,
          label: recommendation.slotLabel,
          ...(recommendation.slotIntent ? { intent: recommendation.slotIntent } : {}),
        })),
      },
      existingCopy: {
        ...(draft.title ? { title: draft.title } : {}),
        ...(draft.excerpt ? { excerpt: draft.excerpt } : {}),
        ...(draft.introduction ? { introduction: draft.introduction } : {}),
        ...(draft.conclusion ? { conclusion: draft.conclusion } : {}),
        ...(draft.seoTitle ? { seoTitle: draft.seoTitle } : {}),
        ...(draft.seoDescription ? { seoDescription: draft.seoDescription } : {}),
      },
    },
    recommendations,
  });
}

export function buildFinalPrompt(input: FinalPromptInput): string {
  const validated = finalPromptInputSchema.parse(input);
  const shape = {
    title: "US English guide title",
    excerpt: "Concise guide excerpt",
    introduction: "Original introduction",
    conclusion: "Optional conclusion",
    seoTitle: "SEO title",
    seoDescription: "SEO description",
    recommendations: [
      {
        id: "unchanged recommendation ID",
        productId: "unchanged selected product ID",
        position: 1,
        heading: "Editorial heading",
        editorialDescription: "Original product-grounded description",
        whyItFits: "Why it serves this slot",
        bestFor: "Optional best-for label",
        considerations: "Optional verified consideration",
      },
    ],
  };
  return `Write the final gift guide for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Each recommendation must use exactly these fields and no aliases or extra fields: id (required non-empty string), productId (required non-empty string), position (required positive integer), editorialDescription (required non-empty string), whyItFits (required non-empty string), plus heading, bestFor, and considerations as optional non-empty strings. Optional fields may be omitted or null; null is normalized to omission.
Use this compact object-shape example and return exactly one recommendation per supplied slot:
${JSON.stringify(shape)}

Rules:
- Write original, natural US English and use USD context.
- Mention only the selected products in the structured input.
- Preserve every supplied product name, product ID, recommendation ID, and position.
- Never add an unselected product or change the selected order.
- Treat the Product name as identity only. Derive factual Product claims exclusively from verifiedFacts.
- Never treat measurements, materials, formulation, certification, or usage claims embedded in a Product name as verified facts.
- Never invent or modify affiliate URLs. Do not return any URL.
- Never invent prices, ratings, reviews, discounts, stock, availability, or specifications.
- Respect the cluster, primary axis, primary intent, taxonomies, budget, questionnaire, and approved outline.
- Preserve each existingCopy's concrete gift concept and sound editorial heading; use the selected Product only to enrich it.
- Write recommendation copy only from the supplied Product identity and verifiedFacts.
- Write public prose only. Never mention a slot, Product slot, option for the slot, resolved Product, sourcing, candidate, structured input, or editorial workflow.
- Vary sentence openings and wording across recommendations. Avoid stock repetition such as "Night-shift nurses often," "practical," "routine," or "novelty merchandise."
- Prefer experiential wording such as comfort during long shifts, support for tired legs, or easier daytime rest. Avoid physiological claims about circulation, recovery, or sleep effects unless verifiedFacts explicitly supports them.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareFinalPrompt(
  draft: GuideDraft,
  content: ValidatedPublicContent,
): PreparedFinalPrompt {
  const input = createFinalPromptInput(draft, content);
  return { version: FINAL_PROMPT_VERSION, input, prompt: buildFinalPrompt(input) };
}

export function prepareGuideMetadataPrompt(draft: GuideDraft, content: ValidatedEditorialContent) {
  if (!draft.clusterId) throw new TypeError("Elegí un cluster antes de generar metadata.");
  const cluster = content.clusters.find(({ id }) => id === draft.clusterId);
  if (!cluster) throw new TypeError("El cluster elegido no está publicado.");
  if (!draft.primaryAxis || !draft.primaryIntent) {
    throw new TypeError("La guía necesita eje e intención antes de generar metadata.");
  }
  const title =
    draft.title ?? draft.outline?.provisionalTitle ?? `${cluster.title}: ${draft.primaryIntent}`;
  const input = guideMetadataPromptInputSchema.parse({
    language: "en-US",
    missingFields: (["excerpt", "introduction", "seoTitle", "seoDescription"] as const).filter(
      (field) => !draft[field],
    ),
    cluster: {
      id: cluster.id,
      title: cluster.title,
      excerpt: cluster.excerpt,
      introduction: cluster.introduction,
    },
    guide: {
      id: draft.id,
      primaryAxis: draft.primaryAxis,
      primaryIntent: draft.primaryIntent,
      ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
      ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
      questionnaire: draft.questionnaire,
      approvedOutline: {
        ...(draft.outline?.provisionalTitle
          ? { provisionalTitle: draft.outline.provisionalTitle }
          : {}),
        ...(draft.outline?.audienceSummary
          ? { audienceSummary: draft.outline.audienceSummary }
          : {}),
        ...(draft.outline?.editorialAngle ? { editorialAngle: draft.outline.editorialAngle } : {}),
        slots: draft.recommendations.map((slot) => ({
          id: slot.id,
          position: slot.position,
          label: slot.slotLabel,
          ...(slot.slotIntent ? { intent: slot.slotIntent } : {}),
        })),
      },
      existingCopy: {
        ...(draft.title ? { title: draft.title } : {}),
        ...(draft.excerpt ? { excerpt: draft.excerpt } : {}),
        ...(draft.introduction ? { introduction: draft.introduction } : {}),
        ...(draft.conclusion ? { conclusion: draft.conclusion } : {}),
        ...(draft.seoTitle ? { seoTitle: draft.seoTitle } : {}),
        ...(draft.seoDescription ? { seoDescription: draft.seoDescription } : {}),
      },
    },
    title,
  });
  const prompt = `Complete the missing public metadata for one gift guide.

Return exactly one JSON object containing only the fields listed in missingFields. Write natural US English. Describe the audience, editorial angle, and practical selection criteria without listing Products. For the introduction, open with a concrete shopper/recipient scenario or need and speak directly about the recipient, occasion, routine, or buying decision. Never describe "this guide," "the guide," "the editorial approach," "the recommendations," or "the list," and never explain how items were selected, grouped, assembled, organized, researched, or generated. Do not make safety, medical, operational, price, rating, availability, or Product-specific claims. Avoid keyword repetition. Keep the SEO title concise and do not append a site name.

Structured input:
${JSON.stringify(input, null, 2)}`;
  return { version: GUIDE_METADATA_PROMPT_VERSION, input, prompt };
}

export function mockGuideMetadata(input: GuideMetadataPromptInput) {
  const audience = (
    input.guide.questionnaire.recipient ??
    input.guide.taxonomies?.recipients?.[0] ??
    "the intended recipient"
  ).split(/[.,;]/)[0]!;
  const topic = input.guide.primaryIntent.replace(/[.!?]+$/, "").toLocaleLowerCase("en-US");
  const generated = {
    excerpt:
      input.guide.existingCopy.excerpt ??
      `A practical gift guide for ${audience}, focused on how to ${topic}.`,
    introduction:
      input.guide.existingCopy.introduction ??
      `Choosing for ${audience} is easier when each idea fits the way they live and work. This guide emphasizes everyday usefulness, personal fit, and sensible tradeoffs so the final choice feels thoughtful rather than generic.`,
    seoTitle: input.guide.existingCopy.seoTitle ?? input.title.slice(0, 70),
    seoDescription:
      input.guide.existingCopy.seoDescription ??
      `Explore practical gift ideas for ${audience}, chosen around everyday usefulness, personal fit, and the guide's focused purpose.`,
  };
  return Object.fromEntries(input.missingFields.map((field) => [field, generated[field]]));
}

export function mockProductBackedRecommendation(
  recommendation: FinalPromptInput["recommendations"][number],
) {
  const productClass = recommendation.slotLabel.toLocaleLowerCase("en-US");
  return {
    id: recommendation.recommendationId,
    productId: recommendation.product.id,
    position: recommendation.position,
    heading: recommendation.product.name,
    editorialDescription: `This ${productClass} offers a practical choice shaped around the recipient's everyday routine.`,
    whyItFits: `${recommendation.slotLabel} connects the gift to something the recipient can use in everyday life.`,
    bestFor: "Someone likely to use it regularly",
    ...(recommendation.product.verifiedFacts?.length
      ? { considerations: `Verified details: ${recommendation.product.verifiedFacts.join("; ")}.` }
      : {}),
  };
}

export function mockFinalGuide(input: FinalPromptInput): GeneratedGuide {
  const title =
    input.guide.existingCopy.title ??
    input.guide.approvedOutline.provisionalTitle ??
    `${input.cluster.title} Gift Guide`;
  return generatedGuideSchema.parse({
    title,
    excerpt:
      input.guide.existingCopy.excerpt ??
      `A focused selection for readers who want to ${input.guide.primaryIntent.toLocaleLowerCase("en-US")}`,
    introduction:
      input.guide.existingCopy.introduction ??
      `This guide uses ${input.guide.primaryAxis} as its primary lens and evaluates each selected product against one distinct editorial purpose.`,
    conclusion:
      input.guide.existingCopy.conclusion ??
      "Choose the option that best reflects the recipient's routines, preferences, and the moment you want to mark.",
    seoTitle: input.guide.existingCopy.seoTitle ?? `${title} | The Good Present`,
    seoDescription:
      input.guide.existingCopy.seoDescription ??
      `Explore a focused ${input.cluster.title.toLocaleLowerCase("en-US")} guide with carefully selected products and original editorial context.`,
    recommendations: input.recommendations.map(mockProductBackedRecommendation),
  });
}
