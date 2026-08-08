import { primaryAxisSchema, type ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";

export const FINAL_PROMPT_VERSION = "final-guide-v1";

const optionalText = z.string().trim().min(1).optional();
const contentId = z.string().trim().min(1);

export const generatedRecommendationSchema = z.strictObject({
  id: contentId,
  productId: contentId,
  position: z.number().int().positive(),
  heading: optionalText,
  editorialDescription: z.string().trim().min(1),
  whyItFits: z.string().trim().min(1),
  bestFor: optionalText,
  considerations: optionalText,
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
    merchant: z.string().trim().min(1),
    shortDescription: z.string().trim().min(1),
    verifiedFacts: z.array(z.string().trim().min(1)).optional(),
    priceLabel: optionalText,
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

export type GeneratedRecommendation = z.infer<typeof generatedRecommendationSchema>;
export type GeneratedGuide = z.infer<typeof generatedGuideSchema>;
export type FinalPromptInput = z.infer<typeof finalPromptInputSchema>;

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
          name: product.name,
          merchant: product.merchant,
          shortDescription: product.shortDescription,
          ...(product.verifiedFacts ? { verifiedFacts: product.verifiedFacts } : {}),
          ...(product.priceLabel ? { priceLabel: product.priceLabel } : {}),
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
Use this compact object-shape example and return exactly one recommendation per supplied slot:
${JSON.stringify(shape)}

Rules:
- Write original, natural US English and use USD context.
- Mention only the selected products in the structured input.
- Preserve every supplied product name, product ID, recommendation ID, and position.
- Never add an unselected product or change the selected order.
- Use only supplied merchant names, short descriptions, verified facts, and price labels.
- Never invent or modify affiliate URLs. Do not return any URL.
- Never invent prices, ratings, reviews, discounts, stock, availability, or specifications.
- Respect the cluster, primary axis, primary intent, taxonomies, budget, questionnaire, and approved outline.
- Improve existing copy when present without copying source text from elsewhere.

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
