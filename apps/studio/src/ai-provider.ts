import type { z } from "zod";

import { guideOutlineSchema } from "./drafts.ts";
import { outlinePromptInputSchema } from "./outline-prompt.ts";

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
  readonly modelId = "mock-outline-v1";

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    if (request.operation !== "outline") {
      throw new TypeError(`Mock operation not implemented: ${request.operation}`);
    }
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
}
