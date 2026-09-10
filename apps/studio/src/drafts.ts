import { randomUUID } from "node:crypto";

import { primaryAxisSchema } from "@the-good-present/content-schema";
import { z } from "zod";

export const DRAFT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_GIFT_COUNT = 8;
export const MIN_GIFT_COUNT = 3;
export const MAX_GIFT_COUNT = 20;

const contentIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
    "El ID debe usar minúsculas, números, guiones o guiones bajos.",
  );
const optionalText = z.string().trim().min(1).optional();
const optionalTextList = z.array(z.string().trim().min(1));
const timestampSchema = z.iso.datetime();

export const guideQuestionnaireSchema = z.strictObject({
  recipient: optionalText,
  ageRange: optionalText,
  occasion: optionalText,
  giftCount: z.number().int().min(MIN_GIFT_COUNT).max(MAX_GIFT_COUNT),
  budget: optionalText,
  interests: optionalText,
  avoid: optionalText,
  tone: optionalText,
  additional: optionalText,
});

export const generationMetadataSchema = z.strictObject({
  providerId: optionalText,
  modelId: optionalText,
  generatedAt: timestampSchema,
  promptVersion: z.string().trim().min(1),
  prompt: z.string().min(1),
  validation: z.strictObject({
    success: z.boolean(),
    issues: z.array(z.string().trim().min(1)).optional(),
  }),
});

export const guideOutlineSlotSchema = z.strictObject({
  id: contentIdSchema,
  label: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  searchTerms: z.array(z.string().trim().min(1)).min(1),
  budgetHint: optionalText,
});

export const guideOutlineSchema = z
  .strictObject({
    provisionalTitle: z.string().trim().min(1),
    audienceSummary: z.string().trim().min(1),
    editorialAngle: z.string().trim().min(1),
    recommendationCount: z.number().int().min(MIN_GIFT_COUNT).max(MAX_GIFT_COUNT),
    slots: z.array(guideOutlineSlotSchema).min(MIN_GIFT_COUNT).max(MAX_GIFT_COUNT),
  })
  .superRefine((outline, context) => {
    if (outline.recommendationCount !== outline.slots.length) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "La cantidad declarada debe coincidir con la cantidad de slots.",
      });
    }
    const ids = new Set<string>();
    outline.slots.forEach((slot, index) => {
      if (ids.has(slot.id)) {
        context.addIssue({
          code: "custom",
          path: ["slots", index, "id"],
          message: `El ID de slot "${slot.id}" está duplicado.`,
        });
      }
      ids.add(slot.id);
    });
  });

const draftEditorialStatusSchema = z.preprocess(
  (status) => (status === "unassigned" ? "needs-generation" : status),
  z.enum(["needs-generation", "needs-review", "ready"]),
);

export const draftRecommendationSchema = z.strictObject({
  id: contentIdSchema,
  position: z.number().int().positive(),
  slotLabel: z.string().trim().min(1),
  slotIntent: optionalText,
  searchTerms: optionalTextList.optional(),
  budgetHint: optionalText,
  productId: contentIdSchema.optional(),
  heading: optionalText,
  editorialDescription: optionalText,
  whyItFits: optionalText,
  bestFor: optionalText,
  selectionGuidance: optionalText,
  considerations: optionalText,
  editorialPromptVersion: optionalText,
  editorialStatus: draftEditorialStatusSchema,
});

const draftBaseShape = {
  schemaVersion: z.literal(DRAFT_SCHEMA_VERSION),
  id: contentIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const clusterDraftSchema = z.strictObject({
  ...draftBaseShape,
  draftType: z.literal("cluster-hub"),
  status: z.enum(["editing", "ready-to-publish"]),
  slug: optionalText,
  language: z.literal("en-US"),
  title: optionalText,
  excerpt: optionalText,
  introduction: optionalText,
  seoTitle: optionalText,
  seoDescription: optionalText,
  navigationGroups: z.array(
    z.strictObject({
      id: contentIdSchema,
      label: z.string().trim().min(1),
      axis: primaryAxisSchema,
      guideIds: z.array(contentIdSchema),
    }),
  ),
});

export const draftTaxonomiesSchema = z.strictObject({
  occasions: optionalTextList.optional(),
  recipients: optionalTextList.optional(),
  careerStages: optionalTextList.optional(),
  workContexts: optionalTextList.optional(),
  giftStyles: optionalTextList.optional(),
  budgetLabels: optionalTextList.optional(),
});

export const draftBudgetContextSchema = z
  .strictObject({
    currency: z.literal("USD"),
    label: z.string().trim().min(1),
    minimum: z.number().nonnegative().optional(),
    maximum: z.number().nonnegative().optional(),
  })
  .refine(
    ({ minimum, maximum }) => minimum === undefined || maximum === undefined || minimum <= maximum,
    { path: ["maximum"], message: "El máximo debe ser mayor o igual que el mínimo." },
  );

export const guideDraftSchema = z.strictObject({
  ...draftBaseShape,
  draftType: z.literal("gift-guide"),
  status: z.enum([
    "questionnaire",
    "outline-ready",
    "selecting-products",
    "editing",
    "ready-to-publish",
  ]),
  clusterId: contentIdSchema.optional(),
  slug: optionalText,
  language: z.literal("en-US"),
  primaryAxis: primaryAxisSchema.optional(),
  primaryIntent: optionalText,
  taxonomies: draftTaxonomiesSchema.optional(),
  budgetContext: draftBudgetContextSchema.optional(),
  relatedGuideIds: z.array(contentIdSchema),
  questionnaire: guideQuestionnaireSchema,
  generationMetadata: generationMetadataSchema.optional(),
  outline: guideOutlineSchema.optional(),
  title: optionalText,
  excerpt: optionalText,
  introduction: optionalText,
  conclusion: optionalText,
  seoTitle: optionalText,
  seoDescription: optionalText,
  recommendations: z.array(draftRecommendationSchema),
});

export const editorialDraftSchema = z.discriminatedUnion("draftType", [
  clusterDraftSchema,
  guideDraftSchema,
]);

export type GuideQuestionnaire = z.infer<typeof guideQuestionnaireSchema>;
export type GenerationMetadata = z.infer<typeof generationMetadataSchema>;
export type ClusterDraft = z.infer<typeof clusterDraftSchema>;
export type GuideDraft = z.infer<typeof guideDraftSchema>;
export type EditorialDraft = z.infer<typeof editorialDraftSchema>;

export function createDraftId(type: EditorialDraft["draftType"]): string {
  const prefix = type === "cluster-hub" ? "cluster" : "guide";
  return `${prefix}_${randomUUID()}`;
}

export function createClusterDraft(
  id = createDraftId("cluster-hub"),
  now = new Date(),
): ClusterDraft {
  const timestamp = now.toISOString();
  return clusterDraftSchema.parse({
    schemaVersion: DRAFT_SCHEMA_VERSION,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    draftType: "cluster-hub",
    status: "editing",
    language: "en-US",
    navigationGroups: [],
  });
}

export function createGuideDraft(id = createDraftId("gift-guide"), now = new Date()): GuideDraft {
  const timestamp = now.toISOString();
  return guideDraftSchema.parse({
    schemaVersion: DRAFT_SCHEMA_VERSION,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    draftType: "gift-guide",
    status: "questionnaire",
    language: "en-US",
    relatedGuideIds: [],
    questionnaire: { giftCount: DEFAULT_GIFT_COUNT },
    recommendations: [],
  });
}
