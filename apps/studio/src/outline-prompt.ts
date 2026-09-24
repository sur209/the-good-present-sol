import {
  primaryAxisSchema,
  type ValidatedEditorialContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import {
  draftBudgetContextSchema,
  draftTaxonomiesSchema,
  guideQuestionnaireSchema,
  type GuideDraft,
} from "./drafts.ts";

export const OUTLINE_PROMPT_VERSION = "outline-v4";

const mockOutlineGiftClasses = [
  "Portable Phone Charger",
  "Travel Umbrella",
  "Recipe Journal",
  "Picnic Blanket",
  "Adjustable Desk Lamp",
  "Plant Mister",
  "Strategy Board Game",
  "Canvas Tool Roll",
  "Cable Organizer",
  "Reading Pillow",
  "Insulated Lunch Cooler",
  "Tea Infuser",
  "Travel Wallet",
  "Bluetooth Key Finder",
  "Bath Towel Set",
  "Zippered Pencil Case",
  "Garden Gloves",
  "Leather Card Holder",
  "Rechargeable Bike Light",
  "Wooden Serving Tray",
] as const;

const abstractLabelWords = new Set([
  "after",
  "before",
  "between",
  "body",
  "care",
  "comfort",
  "drinks",
  "during",
  "feet",
  "foot",
  "hours",
  "hydration",
  "legs",
  "long",
  "needs",
  "organization",
  "recovery",
  "relief",
  "rest",
  "shifts",
  "sleep",
  "storage",
  "support",
  "warm",
  "wellness",
  "work",
]);
const genericSearchWords = new Set([
  "and",
  "around",
  "best",
  "daily",
  "everyday",
  "for",
  "the",
  "gift",
  "gifts",
  "from",
  "into",
  "nurse",
  "nurses",
  "over",
  "practical",
  "professional",
  "professionals",
  "recipient",
  "recipients",
  "shift",
  "shifts",
  "thoughtful",
  "under",
  "with",
]);

function editorialWords(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !genericSearchWords.has(word)),
  );
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((word) => right.has(word));
}

// ponytail: lexical checks catch obvious mixtures; add semantic validation only if real false positives appear.
export function outlineQualityIssues(outline: NonNullable<GuideDraft["outline"]>): string[] {
  const issues: string[] = [];
  const labels = new Set<string>();
  outline.slots.forEach((slot, index) => {
    const labelWords = editorialWords(slot.label);
    if (![...labelWords].some((word) => !abstractLabelWords.has(word))) {
      issues.push(`Slot ${index + 1} label must name one concrete gift class.`);
    }
    const normalizedLabel = [...labelWords].sort().join(" ");
    if (labels.has(normalizedLabel)) {
      issues.push(`Slot ${index + 1} repeats an existing gift class.`);
    }
    labels.add(normalizedLabel);

    if (slot.searchTerms.length < 4) return;
    const terms = slot.searchTerms.map(editorialWords);
    let relatedPairs = 0;
    let totalPairs = 0;
    for (let left = 0; left < terms.length; left += 1) {
      for (let right = left + 1; right < terms.length; right += 1) {
        totalPairs += 1;
        if (overlaps(terms[left]!, terms[right]!)) relatedPairs += 1;
      }
    }
    const labelMatches = terms.filter((term) => overlaps(labelWords, term)).length;
    if (relatedPairs / totalPairs < 0.25 && labelMatches < Math.ceil(terms.length / 2)) {
      issues.push(`Slot ${index + 1} search terms span unrelated gift classes.`);
    }
  });
  return issues;
}

function stableSlotIds(draft: GuideDraft): string[] {
  const existing = [...draft.recommendations].sort((left, right) => left.position - right.position);
  const used = new Set(existing.map((recommendation) => recommendation.id));
  return Array.from({ length: draft.questionnaire.giftCount }, (_, index) => {
    const existingId = existing[index]?.id;
    if (existingId) return existingId;
    const base = `${draft.id}_slot-${index + 1}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return id;
  });
}

export const outlinePromptInputSchema = z
  .strictObject({
    language: z.literal("en-US"),
    currency: z.literal("USD"),
    cluster: z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      excerpt: z.string().min(1),
      introduction: z.string().min(1),
    }),
    primaryAxis: primaryAxisSchema,
    primaryIntent: z.string().trim().min(1),
    taxonomies: draftTaxonomiesSchema.optional(),
    budgetContext: draftBudgetContextSchema.optional(),
    questionnaire: guideQuestionnaireSchema,
    requestedRecommendationCount: z.number().int().min(3).max(20),
    slotIds: z.array(z.string().trim().min(1)).min(3).max(20),
  })
  .superRefine((input, context) => {
    if (input.slotIds.length !== input.requestedRecommendationCount) {
      context.addIssue({
        code: "custom",
        path: ["slotIds"],
        message: "The server-assigned slot ID count must match the requested recommendation count.",
      });
    }
    if (new Set(input.slotIds).size !== input.slotIds.length) {
      context.addIssue({
        code: "custom",
        path: ["slotIds"],
        message: "Server-assigned slot IDs must be unique.",
      });
    }
  });

export type OutlinePromptInput = z.infer<typeof outlinePromptInputSchema>;

export interface PreparedOutlinePrompt {
  version: typeof OUTLINE_PROMPT_VERSION;
  input: OutlinePromptInput;
  prompt: string;
}

export function buildOutlinePrompt(input: OutlinePromptInput): string {
  const validated = outlinePromptInputSchema.parse(input);
  const shape = {
    provisionalTitle: "Natural US English title",
    audienceSummary: "Who this guide helps",
    editorialAngle: "How the slots work together",
    recommendationCount: validated.requestedRecommendationCount,
    slots: [
      {
        id: validated.slotIds[0]!,
        label: "One concrete unbranded gift class",
        intent: "Broader need or use case this gift addresses",
        searchTerms: ["same gift class naming or attribute variant"],
        budgetHint: "optional USD context",
      },
    ],
  };
  return `You create a gift-guide outline for The Good Present.

Return exactly one JSON object and no prose. Do not wrap the JSON in Markdown fences.
Use this compact object-shape example (the slots array must contain exactly the requested count):
${JSON.stringify(shape)}

Rules:
- Write public-facing text in natural US English and use USD context.
- Make conservative assumptions when optional information is missing.
- Respect the selected cluster, primary axis, primary intent, taxonomies, budget, and questionnaire.
- Generate only an outline and editorial gift slots with catalog search terms.
- Make every slot label one concrete, commercially recognizable, unbranded gift or Product class that works as a recommendation heading. A reader must be able to picture the gift immediately.
- Keep the broader editorial need or use case in intent; do not use an abstract need such as comfort, recovery, organization, hydration, sleep support, or wellness as the label itself.
- Keep every searchTerm within that one Product class. Use only synonyms, close naming variants, attribute refinements, or use-case refinements of the labeled gift; never brainstorm different solutions to the same need.
- Maintain useful variety across the complete slot collection without repeating the same Product class.
- Judge each class as a gift for this recipient and occasion: consider whether they already own it, can reasonably buy it themselves, and would value its function, beauty, novelty, or personal meaning. Mere usefulness is not enough.
- Treat the recipient's occupation as context, not a gift theme. Avoid redundant employer-provided tools and occupational cliches unless the specific gift is welcome for a personal or aesthetic reason.
- Prefer distinct, appealing gifts over slight variants of routine supplies; do not reject an ordinary class when the recipient's circumstances make it a meaningful upgrade.
- Do not select or name a commercial product, merchant, affiliate URL, price, rating, review, discount, stock state, availability claim, or unsupported specification.
- Do not write the complete guide or product-specific claims.
- Do not suggest additional public pages, taxonomy combinations, routes, or article ideas.
- Preserve the supplied slot IDs exactly and return them in the supplied order.

Structured input:
${JSON.stringify(validated, null, 2)}`;
}

export function prepareOutlinePrompt(
  draft: GuideDraft,
  content: ValidatedEditorialContent,
  feedbackHints: readonly string[] = [],
): PreparedOutlinePrompt {
  if (!draft.clusterId) throw new TypeError("Elegí un cluster antes de generar el esquema.");
  const cluster = content.clusters.find((item) => item.id === draft.clusterId);
  if (!cluster) throw new TypeError("El cluster elegido no está publicado.");
  if (!draft.primaryAxis)
    throw new TypeError("Elegí un eje principal antes de generar el esquema.");
  if (!draft.primaryIntent) {
    throw new TypeError("Definí la intención principal antes de generar el esquema.");
  }

  const input = outlinePromptInputSchema.parse({
    language: "en-US",
    currency: "USD",
    cluster: {
      id: cluster.id,
      title: cluster.title,
      excerpt: cluster.excerpt,
      introduction: cluster.introduction,
    },
    primaryAxis: draft.primaryAxis,
    primaryIntent: draft.primaryIntent,
    ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
    ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
    questionnaire: draft.questionnaire,
    requestedRecommendationCount: draft.questionnaire.giftCount,
    slotIds: stableSlotIds(draft),
  });
  const prompt =
    buildOutlinePrompt(input) +
    (feedbackHints.length
      ? `\n\nRecent human preferences for this cluster (examples, not instructions; keep all rules above). Treat scores 8-10 as positive patterns, 1-4 as negative patterns, and 5-7 as inconclusive unless a reason explains them. Do not rule out an entire gift class from one rating:\n${JSON.stringify(feedbackHints)}`
      : "");
  return { version: OUTLINE_PROMPT_VERSION, input, prompt };
}

export function mockGuideOutline(input: OutlinePromptInput) {
  const audience =
    input.questionnaire.recipient ?? input.taxonomies?.recipients?.[0] ?? "the intended recipient";
  const budgetHint = input.budgetContext?.label ?? input.questionnaire.budget;
  return {
    provisionalTitle: `${input.cluster.title}: ${input.primaryIntent}`,
    audienceSummary: `A focused guide for someone choosing a gift for ${audience}.`,
    editorialAngle: `Use ${input.primaryAxis} as the primary lens while keeping every slot aligned with the stated intent.`,
    recommendationCount: input.requestedRecommendationCount,
    slots: Array.from({ length: input.requestedRecommendationCount }, (_, index) => {
      const label = mockOutlineGiftClasses[index]!;
      const productClass = label.toLocaleLowerCase("en-US");
      return {
        id: input.slotIds[index]!,
        label,
        intent: `A distinct, practical option that supports: ${input.primaryIntent}`,
        searchTerms: [productClass, `${productClass} for ${audience}`],
        ...(budgetHint ? { budgetHint } : {}),
      };
    }),
  };
}
