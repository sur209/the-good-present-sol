import type { z } from "zod";

import { guideOutlineSchema } from "./drafts.ts";
import {
  finalPromptInputSchema,
  generatedGuideSchema,
  type FinalPromptInput,
} from "./final-prompt.ts";
import { outlinePromptInputSchema } from "./outline-prompt.ts";
import { recommendationPromptInputSchema } from "./recommendation-prompt.ts";

export interface StructuredGenerationRequest<T> {
  operation: "outline" | "final-guide" | "single-recommendation";
  prompt: string;
  input: unknown;
  schema: z.ZodType<T>;
}

export interface GuideGenerationProvider {
  readonly providerId: string;
  readonly modelId?: string;
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}

export class MockGuideGenerationProvider implements GuideGenerationProvider {
  readonly providerId = "mock";
  readonly modelId = "mock-editorial-v1";

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    if (request.operation === "outline") {
      const input = outlinePromptInputSchema.parse(request.input);
      const audience =
        input.questionnaire.recipient ??
        input.taxonomies?.recipients?.[0] ??
        "the intended recipient";
      const budgetHint = input.budgetContext?.label ?? input.questionnaire.budget;
      const outline = guideOutlineSchema.parse({
        provisionalTitle: `${input.cluster.title}: ${input.primaryIntent}`,
        audienceSummary: `A focused guide for someone choosing a gift for ${audience}.`,
        editorialAngle: `Use ${input.primaryAxis} as the primary lens while keeping every slot aligned with the stated intent.`,
        recommendationCount: input.requestedRecommendationCount,
        slots: Array.from({ length: input.requestedRecommendationCount }, (_, index) => ({
          id: `slot-${index + 1}`,
          label: `${input.primaryAxis} gift slot ${index + 1}`,
          intent: `A distinct, practical option that supports: ${input.primaryIntent}`,
          searchTerms: [
            `${input.cluster.title} ${input.primaryAxis} gift ${index + 1}`,
            `${audience} thoughtful gift`,
          ],
          ...(budgetHint ? { budgetHint } : {}),
        })),
      });
      return request.schema.parse(outline);
    }
    if (request.operation === "final-guide") {
      const input = finalPromptInputSchema.parse(request.input);
      const title =
        input.guide.existingCopy.title ??
        input.guide.approvedOutline.provisionalTitle ??
        `${input.cluster.title} Gift Guide`;
      const guide = generatedGuideSchema.parse({
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
        recommendations: input.recommendations.map(mockRecommendation),
      });
      return request.schema.parse(guide);
    }
    if (request.operation === "single-recommendation") {
      const input = recommendationPromptInputSchema.parse(request.input);
      return request.schema.parse(mockRecommendation(input.recommendation));
    }
    throw new TypeError(`Mock operation not implemented: ${request.operation}`);
  }
}

function mockRecommendation(recommendation: FinalPromptInput["recommendations"][number]) {
  return {
    id: recommendation.recommendationId,
    productId: recommendation.product.id,
    position: recommendation.position,
    heading: recommendation.product.name,
    editorialDescription: `${recommendation.product.name} from ${recommendation.product.merchant} offers this verified catalog context: ${recommendation.product.shortDescription}`,
    whyItFits:
      recommendation.slotIntent ??
      `It fills the “${recommendation.slotLabel}” role in this guide without changing the slot's purpose.`,
    bestFor: recommendation.slotLabel,
    ...(recommendation.product.verifiedFacts?.length
      ? { considerations: `Verified details: ${recommendation.product.verifiedFacts.join("; ")}.` }
      : {}),
  };
}
