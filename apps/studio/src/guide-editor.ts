import type { ValidatedPublicContent } from "@the-good-present/content-schema";

import type { GuideGenerationProvider } from "./ai-provider.ts";
import {
  DEFAULT_GIFT_COUNT,
  guideDraftSchema,
  guideOutlineSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
  type GuideQuestionnaire,
} from "./drafts.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";

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
