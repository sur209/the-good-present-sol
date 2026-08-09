import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  PRIMARY_AXES,
  primaryAxisSchema,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import type { EditorialDraft } from "../../drafts.ts";
import { atomicWriteJson } from "../../repository.ts";
import {
  ArticleCandidateStore,
  articleCandidateSchema,
  candidateSectionsSchema,
  candidateTaxonomiesSchema,
  type ArticleCandidate,
} from "./candidates.ts";
import {
  compareArticleCandidate,
  normalizeComparisonText,
  type ApprovedEditorialBriefComparisonRecord,
  type OpportunityComparisonReport,
} from "./comparison.ts";

export const OPPORTUNITY_GENERATION_PROMPT_VERSION = "opportunity-divergent-v1";
export const DEFAULT_OPPORTUNITY_CANDIDATE_COUNT = 20;
export const MAX_OPPORTUNITY_CANDIDATE_COUNT = 50;
export const OPPORTUNITY_GENERATION_SESSIONS_DIRECTORY =
  "editorial-data/opportunity-generation-sessions";

export const OPPORTUNITY_SESSION_OBJECTIVES = [
  "expand-cluster",
  "find-missing-intents",
  "find-seasonal-opportunities",
  "find-section-opportunities",
  "reuse-existing-products",
  "review-cannibalization",
  "find-localization-candidates",
] as const;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

export const importedSignalSummarySchema = z.strictObject({
  id: safeId,
  provenanceLabel: nonEmptyText,
  summary: nonEmptyText,
});

export const opportunityGenerationRequestSchema = z.strictObject({
  clusterId: safeId,
  sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
  candidateCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_OPPORTUNITY_CANDIDATE_COUNT)
    .default(DEFAULT_OPPORTUNITY_CANDIDATE_COUNT),
  targetMarket: nonEmptyText.default("US"),
  language: nonEmptyText.default("en-US"),
  planningHorizon: nonEmptyText.optional(),
  importedSignalSummaries: z.array(importedSignalSummarySchema).max(100).optional(),
});

export type OpportunityGenerationRequest = z.input<typeof opportunityGenerationRequestSchema>;

const contextRecordSchema = z.strictObject({
  id: safeId,
  kind: z.enum([
    "published-cluster",
    "published-guide",
    "cluster-draft",
    "guide-draft",
    "editorial-brief",
    "candidate-history",
  ]),
  title: nonEmptyText,
  status: nonEmptyText.optional(),
  primaryAxis: primaryAxisSchema.optional(),
  primaryIntent: nonEmptyText.optional(),
  taxonomies: z.array(nonEmptyText),
  sections: z.array(nonEmptyText),
  productCategories: z.array(nonEmptyText),
  priorDecision: nonEmptyText.optional(),
});

export const opportunityGenerationPromptInputSchema = z.strictObject({
  selectedCluster: z.strictObject({ id: safeId, title: nonEmptyText }),
  sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
  candidateCount: z.number().int().min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  targetMarket: nonEmptyText,
  language: nonEmptyText,
  planningHorizon: nonEmptyText.optional(),
  publishedPages: z.array(contextRecordSchema),
  drafts: z.array(contextRecordSchema),
  approvedBriefs: z.array(contextRecordSchema),
  priorCandidateDecisions: z.array(contextRecordSchema),
  primaryAxes: z.array(primaryAxisSchema),
  taxonomyValues: z.array(nonEmptyText),
  availableProductCategories: z.array(nonEmptyText),
  importedSignalSummaries: z.array(importedSignalSummarySchema),
});

export type OpportunityGenerationPromptInput = z.infer<
  typeof opportunityGenerationPromptInputSchema
>;

const FORBIDDEN_EXTERNAL_EVIDENCE =
  /\b(?:search volume|keyword difficulty|monthly searches?|search demand|impressions?|click-through rate|ctr|clicks?|conversion rate|conversions?|affiliate (?:revenue|sales|performance)|pinterest (?:views|saves|performance)|search console|google analytics|traffic data|trending|best-?selling|high-demand|proven performer)\b/i;
const URL_LIKE = /(?:https?:\/\/|www\.)/i;

export const generatedOpportunitySchema = z.strictObject({
  proposedTitle: nonEmptyText,
  primaryAxis: primaryAxisSchema,
  primaryIntent: nonEmptyText,
  problemSolved: nonEmptyText,
  targetAudience: nonEmptyText,
  secondaryTaxonomies: candidateTaxonomiesSchema,
  proposedSections: candidateSectionsSchema,
  distinctiveProductCategories: z.array(nonEmptyText).min(1),
  potentialOverlapHypothesis: nonEmptyText,
  evidenceBasis: z.literal("editorial-hypothesis-only"),
});

export const generatedOpportunityBatchSchema = z
  .strictObject({
    candidates: z.array(generatedOpportunitySchema).min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  })
  .superRefine((batch, context) => {
    const serialized = JSON.stringify(batch);
    if (URL_LIKE.test(serialized)) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Generated opportunities must not contain URLs.",
      });
    }
    if (FORBIDDEN_EXTERNAL_EVIDENCE.test(serialized)) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Generated opportunities must not assert external evidence or metrics.",
      });
    }
    const titles = new Set<string>();
    batch.candidates.forEach((candidate, index) => {
      const title = normalizeComparisonText(candidate.proposedTitle);
      if (titles.has(title)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "proposedTitle"],
          message: "Generated opportunity titles must be conceptually distinct.",
        });
      }
      titles.add(title);
    });
  });

export type GeneratedOpportunity = z.infer<typeof generatedOpportunitySchema>;
export type GeneratedOpportunityBatch = z.infer<typeof generatedOpportunityBatchSchema>;

export const opportunityGenerationSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordType: z.literal("opportunity-generation-session"),
  id: safeId.regex(/^generation_/),
  clusterId: safeId,
  sessionObjective: z.enum(OPPORTUNITY_SESSION_OBJECTIVES),
  requestedCandidateCount: z.number().int().min(1).max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
  targetMarket: nonEmptyText,
  language: nonEmptyText,
  planningHorizon: nonEmptyText.optional(),
  importedSignalSummaries: z.array(importedSignalSummarySchema),
  providerId: nonEmptyText,
  modelId: nonEmptyText.optional(),
  promptVersion: z.literal(OPPORTUNITY_GENERATION_PROMPT_VERSION),
  prompt: nonEmptyText,
  generatedAt: z.iso.datetime({ offset: true }),
  candidateIds: z
    .array(safeId.regex(/^candidate_/))
    .min(1)
    .max(MAX_OPPORTUNITY_CANDIDATE_COUNT),
});

export type OpportunityGenerationSession = z.infer<typeof opportunityGenerationSessionSchema>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function flattenTaxonomies(
  taxonomies: ArticleCandidate["secondaryTaxonomies"] | undefined,
): string[] {
  return unique(Object.values(taxonomies ?? {}).flatMap((values) => values ?? []));
}

function resolvedProductCategories(
  productIds: readonly (string | undefined)[],
  content: ValidatedPublicContent,
): string[] {
  const products = new Map(content.products.map((product) => [product.id, product]));
  return unique(productIds.flatMap((id) => (id ? (products.get(id)?.categories ?? []) : [])));
}

function publishedContext(
  clusterId: string,
  content: ValidatedPublicContent,
): z.infer<typeof contextRecordSchema>[] {
  const cluster = content.clusters.find(({ id }) => id === clusterId)!;
  const guides = content.guides.filter((guide) => guide.clusterId === clusterId);
  return [
    {
      id: cluster.id,
      kind: "published-cluster" as const,
      title: cluster.title,
      status: cluster.status,
      taxonomies: unique(guides.flatMap((guide) => flattenTaxonomies(guide.taxonomies))),
      sections: cluster.navigationGroups.map(({ label }) => label),
      productCategories: resolvedProductCategories(
        guides.flatMap((guide) => guide.recommendations.map(({ productId }) => productId)),
        content,
      ),
    },
    ...guides.map((guide) => ({
      id: guide.id,
      kind: "published-guide" as const,
      title: guide.title,
      status: guide.status,
      primaryAxis: guide.primaryAxis,
      primaryIntent: guide.primaryIntent,
      taxonomies: flattenTaxonomies(guide.taxonomies),
      sections: guide.recommendations.map(({ heading, whyItFits }) =>
        `${heading ?? ""} ${whyItFits}`.trim(),
      ),
      productCategories: resolvedProductCategories(
        guide.recommendations.map(({ productId }) => productId),
        content,
      ),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function draftContext(
  clusterId: string,
  drafts: readonly EditorialDraft[],
  content: ValidatedPublicContent,
): z.infer<typeof contextRecordSchema>[] {
  return drafts
    .filter((draft) =>
      draft.draftType === "cluster-hub" ? draft.id === clusterId : draft.clusterId === clusterId,
    )
    .map((draft) => {
      if (draft.draftType === "cluster-hub") {
        return {
          id: draft.id,
          kind: "cluster-draft" as const,
          title: draft.title ?? "Untitled cluster draft",
          status: draft.status,
          taxonomies: [],
          sections: draft.navigationGroups.map(({ label }) => label),
          productCategories: [],
        };
      }
      return {
        id: draft.id,
        kind: "guide-draft" as const,
        title: draft.title ?? draft.outline?.provisionalTitle ?? "Untitled guide draft",
        status: draft.status,
        ...(draft.primaryAxis ? { primaryAxis: draft.primaryAxis } : {}),
        ...(draft.primaryIntent ? { primaryIntent: draft.primaryIntent } : {}),
        taxonomies: flattenTaxonomies(draft.taxonomies),
        sections:
          draft.outline?.slots.map(({ label, intent }) => `${label} ${intent}`) ??
          draft.recommendations.map(({ slotLabel, slotIntent }) =>
            `${slotLabel} ${slotIntent ?? ""}`.trim(),
          ),
        productCategories: resolvedProductCategories(
          draft.recommendations.map(({ productId }) => productId),
          content,
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function briefContext(
  clusterId: string,
  briefs: readonly ApprovedEditorialBriefComparisonRecord[],
): z.infer<typeof contextRecordSchema>[] {
  return briefs
    .filter((brief) => brief.clusterId === clusterId)
    .map((brief) => ({
      id: brief.id,
      kind: "editorial-brief" as const,
      title: brief.proposedTitle,
      status: brief.status,
      primaryAxis: brief.primaryAxis,
      primaryIntent: brief.primaryIntent,
      taxonomies: flattenTaxonomies(brief.taxonomies),
      sections: brief.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
      productCategories: unique(brief.productCategories),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function historyContext(
  clusterId: string,
  candidates: readonly ArticleCandidate[],
): z.infer<typeof contextRecordSchema>[] {
  return candidates
    .filter((candidate) => candidate.clusterId === clusterId && candidate.decision)
    .map((candidate) => ({
      id: candidate.id,
      kind: "candidate-history" as const,
      title: candidate.proposedTitle,
      status: candidate.status,
      primaryAxis: candidate.primaryAxis,
      primaryIntent: candidate.primaryIntent,
      taxonomies: flattenTaxonomies(candidate.secondaryTaxonomies),
      sections: candidate.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
      productCategories: unique(candidate.distinctiveProductCategories),
      priorDecision: `${candidate.decision!.action}: ${candidate.decision!.reason}`,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function prepareOpportunityGenerationPrompt(
  request: OpportunityGenerationRequest,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[] = [],
) {
  const parsed = opportunityGenerationRequestSchema.parse(request);
  const cluster = content.clusters.find(({ id }) => id === parsed.clusterId);
  if (!cluster) throw new TypeError(`No existe el cluster canónico "${parsed.clusterId}".`);

  const publishedPages = publishedContext(cluster.id, content);
  const draftRecords = draftContext(cluster.id, drafts, content);
  const briefRecords = briefContext(cluster.id, approvedBriefs);
  const historyRecords = historyContext(cluster.id, candidates);
  const input = opportunityGenerationPromptInputSchema.parse({
    selectedCluster: { id: cluster.id, title: cluster.title },
    sessionObjective: parsed.sessionObjective,
    candidateCount: parsed.candidateCount,
    targetMarket: parsed.targetMarket,
    language: parsed.language,
    ...(parsed.planningHorizon ? { planningHorizon: parsed.planningHorizon } : {}),
    publishedPages,
    drafts: draftRecords,
    approvedBriefs: briefRecords,
    priorCandidateDecisions: historyRecords,
    primaryAxes: [...PRIMARY_AXES],
    taxonomyValues: unique(
      [...publishedPages, ...draftRecords, ...briefRecords, ...historyRecords].flatMap(
        ({ taxonomies }) => taxonomies,
      ),
    ),
    availableProductCategories: unique(
      content.products
        .filter(({ status }) => status === "active")
        .flatMap(({ categories }) => categories ?? []),
    ),
    importedSignalSummaries: parsed.importedSignalSummaries ?? [],
  });
  const prompt = `You are performing divergent editorial opportunity generation for The Good Present.

Generate exactly ${input.candidateCount} conceptually distinct candidates for the selected cluster and session objective. Prefer different audience problems, primary intents, section structures, and product-category combinations over keyword permutations.

This is ideation only. Do not rank, score, shortlist, approve, reject, merge, create a brief or draft, or publish anything. Do not return IDs, slugs, URLs, publication state, product identities, merchants, affiliate details, search volume, keyword difficulty, traffic, social, product, or affiliate performance claims. Treat imported signal summaries, when present, only as editor-supplied context; never recast them as observed metrics. Every candidate must set evidenceBasis to exactly "editorial-hypothesis-only".

Return exactly one JSON object with this shape and no additional fields:
{"candidates":[{"proposedTitle":"...","primaryAxis":"one supplied axis","primaryIntent":"...","problemSolved":"...","targetAudience":"...","secondaryTaxonomies":{"occasions":["..."]},"proposedSections":[{"heading":"...","purpose":"..."}],"distinctiveProductCategories":["..."],"potentialOverlapHypothesis":"...","evidenceBasis":"editorial-hypothesis-only"}]}

Planning input:
${JSON.stringify(input, null, 2)}`;
  return { version: OPPORTUNITY_GENERATION_PROMPT_VERSION, input, prompt };
}

const MOCK_THEMES = [
  {
    title: "Shift-transition support",
    axis: "work-context",
    intent: "Help a giver support the transition between demanding work and restorative time.",
    problem: "Broad practical lists rarely organize gifts around the transition out of work.",
    sections: ["Leaving work mode", "Restoring everyday routines"],
    overlap:
      "May share practical categories with broad work-gift coverage while owning a distinct transition intent.",
  },
  {
    title: "Milestone recognition",
    axis: "occasion",
    intent:
      "Match a gift to a specific professional milestone without defaulting to generic congratulations.",
    problem: "Milestone gifts need context that general occasion pages do not provide.",
    sections: ["Marking the achievement", "Supporting the next chapter"],
    overlap:
      "May touch graduation coverage but differentiates by the milestone selected for the session.",
  },
  {
    title: "Small-space workday upgrades",
    axis: "work-context",
    intent: "Find useful gifts that fit constrained work and storage environments.",
    problem: "Many useful gifts become impractical when storage and carrying space are limited.",
    sections: ["Compact essentials", "Portable organization"],
    overlap:
      "May overlap a practical guide at category level but narrows the problem to space constraints.",
  },
  {
    title: "Off-duty recovery rituals",
    axis: "gift-style",
    intent: "Support repeatable off-duty rituals rather than one-time novelty gifts.",
    problem:
      "Recovery suggestions are often scattered instead of organized around repeatable routines.",
    sections: ["Creating a recovery cue", "Sustaining the ritual"],
    overlap:
      "May share comfort categories with existing pages while proposing a ritual-based structure.",
  },
  {
    title: "Season-change preparation",
    axis: "occasion",
    intent: "Help a giver anticipate routine changes associated with the planning season.",
    problem:
      "Seasonal pages can become decorative lists instead of solving timely routine changes.",
    sections: ["Preparing for the season", "Useful seasonal comforts"],
    overlap: "May overlap occasion coverage but frames seasonality around practical preparation.",
  },
  {
    title: "Team appreciation moments",
    axis: "recipient",
    intent:
      "Support thoughtful appreciation from a team without turning the idea into a generic group gift list.",
    problem: "Team gifts need a clear relationship and use context to avoid impersonal choices.",
    sections: ["Shared appreciation", "Individual recognition"],
    overlap:
      "May share recipient language with broad pages but uses team relationships as the main lens.",
  },
  {
    title: "Personalized daily rituals",
    axis: "gift-style",
    intent: "Use personalization only when it improves a daily routine or sense of ownership.",
    problem: "Personalized gift coverage can prioritize decoration over usefulness.",
    sections: ["Useful personalization", "Details worth confirming"],
    overlap:
      "May overlap personalized coverage while narrowing the standard to routine usefulness.",
  },
  {
    title: "Early-career confidence",
    axis: "career-stage",
    intent: "Help a giver support confidence during an early-career transition.",
    problem:
      "Broad career-stage lists can miss the practical and emotional needs of a first transition.",
    sections: ["Building confidence", "Supporting new routines"],
    overlap: "May approach student or graduation topics but centers the first working transition.",
  },
  {
    title: "Purposeful budget bundles",
    axis: "budget",
    intent: "Combine modest categories around one coherent recipient problem.",
    problem: "Budget pages often sort by price without giving a small set a shared purpose.",
    sections: ["Choosing one purpose", "Combining complementary categories"],
    overlap:
      "May share a budget ceiling with existing coverage but changes the structure from price list to purposeful bundle.",
  },
  {
    title: "Section-sized care upgrades",
    axis: "general",
    intent:
      "Identify focused ideas that may work better as a useful section than as a broad standalone page.",
    problem: "Some narrow needs deserve coverage but may not support an independent guide.",
    sections: ["The focused need", "Where the section could fit"],
    overlap:
      "Is deliberately close to existing coverage so a human can review possible section placement.",
  },
] as const;

const MOCK_AUDIENCES = [
  "close family members",
  "friends choosing a practical gift",
  "coworkers planning a thoughtful gesture",
  "partners supporting everyday routines",
  "long-distance givers who need clear context",
] as const;

export function mockOpportunityGeneration(
  input: OpportunityGenerationPromptInput,
): GeneratedOpportunityBatch {
  const clusterName = input.selectedCluster.title.replace(/\s+gifts?$/i, "");
  const categories = input.availableProductCategories.length
    ? input.availableProductCategories
    : ["practical accessories"];
  return generatedOpportunityBatchSchema.parse({
    candidates: Array.from({ length: input.candidateCount }, (_, index) => {
      const theme = MOCK_THEMES[index % MOCK_THEMES.length]!;
      const audience = MOCK_AUDIENCES[Math.floor(index / MOCK_THEMES.length)]!;
      return {
        proposedTitle: `${theme.title} for ${clusterName}: ${audience}`,
        primaryAxis: theme.axis,
        primaryIntent: theme.intent,
        problemSolved: theme.problem,
        targetAudience: audience,
        secondaryTaxonomies: {},
        proposedSections: theme.sections.map((heading) => ({
          heading,
          purpose: `Develop ${heading.toLocaleLowerCase("en-US")} for ${audience}.`,
        })),
        distinctiveProductCategories: unique([
          categories[index % categories.length]!,
          categories[(index + 1) % categories.length]!,
        ]),
        potentialOverlapHypothesis: theme.overlap,
        evidenceBasis: "editorial-hypothesis-only" as const,
      };
    }),
  });
}

function systemSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new TypeError("No se pudo derivar un slug seguro del título generado.");
  return slug;
}

function assertNoProtectedOutput(
  generated: GeneratedOpportunityBatch,
  content: ValidatedPublicContent,
): void {
  const serialized = JSON.stringify(generated).toLocaleLowerCase("en-US");
  const protectedValues = [
    ...content.clusters.map(({ id }) => id),
    ...content.guides.map(({ id }) => id),
    ...content.products.flatMap(({ id, name }) => [id, name]),
  ];
  const found = protectedValues.find((value) =>
    serialized.includes(value.toLocaleLowerCase("en-US")),
  );
  if (found) {
    throw new TypeError("La respuesta generada intentó controlar una identidad protegida.");
  }
}

const UNASSESSED_SCORES: ArticleCandidate["scores"] = {
  intentDifferentiation: 0,
  editorialUsefulness: 0,
  productDifferentiation: 0,
  audienceClarity: 0,
  seasonalValue: 0,
  commercialPotential: 0,
  visualDistributionPotential: 0,
  productReusePotential: 0,
  thinContentRisk: 0,
  cannibalizationRisk: 0,
  maintenanceCost: 0,
};

function deterministicOverlaps(report: OpportunityComparisonReport) {
  const kindMap = {
    "primary-intent": "primary-intent",
    "proposed-sections": "section-scope",
    "product-categories": "product-categories",
  } as const;
  const signals = report.nearestEditorialState.flatMap((comparison) => {
    if (
      comparison.targetKind !== "published-cluster" &&
      comparison.targetKind !== "published-guide"
    ) {
      return [];
    }
    return comparison.signals.flatMap((signal) => {
      const kind = kindMap[signal.kind as keyof typeof kindMap];
      return kind && signal.level !== "low"
        ? [
            {
              contentId: comparison.targetId,
              kind,
              level: signal.level,
              reason: signal.reason,
            },
          ]
        : [];
    });
  });
  return {
    closestExistingContentIds: unique(signals.map(({ contentId }) => contentId)),
    overlapSignals: signals,
  };
}

function composeCandidate(
  proposal: GeneratedOpportunity,
  clusterId: string,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[],
  now: Date,
): { candidate: ArticleCandidate; comparison: OpportunityComparisonReport } {
  const timestamp = now.toISOString();
  const seed = articleCandidateSchema.parse({
    schemaVersion: 1,
    recordType: "article-candidate",
    id: `candidate_${randomUUID()}`,
    clusterId,
    proposedTitle: proposal.proposedTitle,
    proposedSlug: systemSlug(proposal.proposedTitle),
    primaryAxis: proposal.primaryAxis,
    primaryIntent: proposal.primaryIntent,
    problemSolved: proposal.problemSolved,
    targetAudience: proposal.targetAudience,
    secondaryTaxonomies: proposal.secondaryTaxonomies,
    proposedSections: proposal.proposedSections,
    distinctiveProductCategories: proposal.distinctiveProductCategories,
    closestExistingContentIds: [],
    overlapSignals: [],
    scores: UNASSESSED_SCORES,
    advisory: {
      recommendation: "hold",
      reason: `AI-generated editorial hypothesis only. Potential overlap hypothesis: ${proposal.potentialOverlapHypothesis} Scores are unassessed and no editorial decision was made.`,
    },
    status: "generated",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const comparison = compareArticleCandidate(seed, content, drafts, candidates, approvedBriefs);
  return {
    candidate: articleCandidateSchema.parse({ ...seed, ...deterministicOverlaps(comparison) }),
    comparison,
  };
}

export function opportunityGenerationSessionPath(repositoryRoot: string, id: string): string {
  opportunityGenerationSessionSchema.shape.id.parse(id);
  return resolve(repositoryRoot, OPPORTUNITY_GENERATION_SESSIONS_DIRECTORY, `${id}.json`);
}

export interface GenerateDivergentOpportunitiesContext {
  content: ValidatedPublicContent;
  drafts: readonly EditorialDraft[];
  existingCandidates: readonly ArticleCandidate[];
  approvedBriefs?: readonly ApprovedEditorialBriefComparisonRecord[];
  provider: GuideGenerationProvider;
  candidateStore: ArticleCandidateStore;
  repositoryRoot: string;
  now?: Date;
}

export async function generateDivergentOpportunities(
  request: OpportunityGenerationRequest,
  context: GenerateDivergentOpportunitiesContext,
) {
  const prepared = prepareOpportunityGenerationPrompt(
    request,
    context.content,
    context.drafts,
    context.existingCandidates,
    context.approvedBriefs,
  );
  const exactResponseSchema = generatedOpportunityBatchSchema.refine(
    ({ candidates }) => candidates.length === prepared.input.candidateCount,
    `The provider must return exactly ${prepared.input.candidateCount} candidates.`,
  );
  const generated = exactResponseSchema.parse(
    await context.provider.generateStructured({
      operation: "opportunity-candidates",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: exactResponseSchema,
    }),
  );
  assertNoProtectedOutput(generated, context.content);
  if (prepared.input.sessionObjective === "reuse-existing-products") {
    const available = new Set(prepared.input.availableProductCategories);
    const unavailable = generated.candidates
      .flatMap(({ distinctiveProductCategories }) => distinctiveProductCategories)
      .find((category) => !available.has(category));
    if (unavailable) {
      throw new TypeError(
        `La categoría generada "${unavailable}" no existe en el catálogo activo para esta sesión.`,
      );
    }
  }

  const now = context.now ?? new Date();
  const approvedBriefs = context.approvedBriefs ?? [];
  const composed = generated.candidates.map((proposal) =>
    composeCandidate(
      proposal,
      prepared.input.selectedCluster.id,
      context.content,
      context.drafts,
      context.existingCandidates,
      approvedBriefs,
      now,
    ),
  );
  const session = opportunityGenerationSessionSchema.parse({
    schemaVersion: 1,
    recordType: "opportunity-generation-session",
    id: `generation_${randomUUID()}`,
    clusterId: prepared.input.selectedCluster.id,
    sessionObjective: prepared.input.sessionObjective,
    requestedCandidateCount: prepared.input.candidateCount,
    targetMarket: prepared.input.targetMarket,
    language: prepared.input.language,
    ...(prepared.input.planningHorizon ? { planningHorizon: prepared.input.planningHorizon } : {}),
    importedSignalSummaries: prepared.input.importedSignalSummaries,
    providerId: context.provider.providerId,
    ...(context.provider.modelId ? { modelId: context.provider.modelId } : {}),
    promptVersion: prepared.version,
    prompt: prepared.prompt,
    generatedAt: now.toISOString(),
    candidateIds: composed.map(({ candidate }) => candidate.id),
  });

  for (const { candidate } of composed) await context.candidateStore.save(candidate);
  await atomicWriteJson(
    opportunityGenerationSessionPath(context.repositoryRoot, session.id),
    session,
  );
  return {
    session,
    candidates: composed.map(({ candidate }) => candidate),
    comparisons: composed.map(({ comparison }) => comparison),
  };
}
