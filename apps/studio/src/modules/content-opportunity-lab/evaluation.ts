import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { primaryAxisSchema, type ValidatedPublicContent } from "@the-good-present/content-schema";
import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import type { EditorialDraft } from "../../drafts.ts";
import type { ProductCoverageAnalysis } from "../product-intelligence/coverage.ts";
import { atomicWriteJson } from "../../repository.ts";
import {
  ArticleCandidateStore,
  CANDIDATE_DECISIONS,
  OPPORTUNITY_SESSION_MODES,
  candidateScoresSchema,
  candidateSectionsSchema,
  candidateTaxonomiesSchema,
  transitionArticleCandidate,
  type ArticleCandidate,
} from "./candidates.ts";
import {
  compareArticleCandidate,
  type ApprovedEditorialBriefComparisonRecord,
  type OpportunityComparisonReport,
} from "./comparison.ts";

export const OPPORTUNITY_EVALUATION_PROMPT_VERSION = "opportunity-convergent-v3";
export const OPPORTUNITY_EVALUATIONS_DIRECTORY = "editorial-data/opportunity-evaluations";

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const candidateId = safeId.regex(/^candidate_/);

export const importedEvaluationSignalSchema = z
  .strictObject({
    id: safeId,
    source: nonEmptyText,
    dateRange: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
    summary: nonEmptyText,
  })
  .superRefine((signal, context) => {
    if (signal.dateRange.from > signal.dateRange.to) {
      context.addIssue({
        code: "custom",
        path: ["dateRange", "to"],
        message: "The imported signal date range must end on or after it starts.",
      });
    }
  });

const importedEvaluationSignalsSchema = z
  .array(importedEvaluationSignalSchema)
  .max(100)
  .refine(
    (signals) => new Set(signals.map(({ id }) => id)).size === signals.length,
    "Imported signal IDs must be unique.",
  );

export const opportunityEvaluationRequestSchema = z.strictObject({
  candidateIds: z
    .array(candidateId)
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Candidate IDs must be unique."),
  importedSignals: importedEvaluationSignalsSchema.default([]),
});

export type OpportunityEvaluationRequest = z.input<typeof opportunityEvaluationRequestSchema>;

const candidateFactSchema = z.strictObject({
  id: candidateId,
  clusterId: safeId,
  proposedTitle: nonEmptyText,
  primaryAxis: primaryAxisSchema,
  primaryIntent: nonEmptyText,
  problemSolved: nonEmptyText,
  targetAudience: nonEmptyText,
  secondaryTaxonomies: candidateTaxonomiesSchema,
  proposedSections: candidateSectionsSchema,
  distinctiveProductCategories: z.array(nonEmptyText).min(1),
  sessionMode: z.enum(OPPORTUNITY_SESSION_MODES).optional(),
  sourceProductIds: z.array(safeId.regex(/^product_/)),
  sourceCategoryIds: z.array(safeId.regex(/^category_/)),
  sourceCoverageSignalIds: z.array(safeId.regex(/^coverage_/)),
  differentiation: nonEmptyText.optional(),
  maintenanceImplications: nonEmptyText.optional(),
  productRequirements: z.array(nonEmptyText),
  catalogGaps: z.array(nonEmptyText),
});

export const opportunityEvaluationPromptInputSchema = z.strictObject({
  candidateFacts: z.array(candidateFactSchema).min(1).max(50),
  deterministicEvidence: z.array(
    z.strictObject({ candidateId, comparison: z.custom<OpportunityComparisonReport>() }),
  ),
  productCoverage: z.custom<ProductCoverageAnalysis>(),
  importedSignals: importedEvaluationSignalsSchema,
});

export type OpportunityEvaluationPromptInput = z.infer<
  typeof opportunityEvaluationPromptInputSchema
>;

export const opportunityAiJudgmentSchema = z
  .strictObject({
    candidateId,
    scores: candidateScoresSchema,
    recommendation: z.enum(CANDIDATE_DECISIONS),
    explanation: nonEmptyText,
    targetContentId: safeId.optional(),
    missingEvidence: z.array(nonEmptyText),
    productConcentrationRisk: nonEmptyText,
    catalogVolatility: nonEmptyText,
    thinContentRiskAction: nonEmptyText.optional(),
    cannibalizationRiskAction: nonEmptyText.optional(),
  })
  .superRefine((judgment, context) => {
    const needsTarget =
      judgment.recommendation === "add-as-section" || judgment.recommendation === "merge";
    if (needsTarget !== Boolean(judgment.targetContentId)) {
      context.addIssue({
        code: "custom",
        path: ["targetContentId"],
        message: needsTarget
          ? "A target content ID is required for this recommendation."
          : "This recommendation must not have a target content ID.",
      });
    }
    for (const [score, action, path] of [
      [judgment.scores.thinContentRisk, judgment.thinContentRiskAction, "thinContentRiskAction"],
      [
        judgment.scores.cannibalizationRisk,
        judgment.cannibalizationRiskAction,
        "cannibalizationRiskAction",
      ],
    ] as const) {
      if (score >= 7 && !action) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "A score of 7 or more requires an actionable risk explanation.",
        });
      }
    }
  });

export const opportunityEvaluationBatchSchema = z.strictObject({
  batchSynthesis: nonEmptyText,
  evaluations: z.array(opportunityAiJudgmentSchema).min(1).max(50),
});

export type OpportunityAiJudgment = z.infer<typeof opportunityAiJudgmentSchema>;
export type OpportunityEvaluationBatch = z.infer<typeof opportunityEvaluationBatchSchema>;

export const opportunityEvaluationSessionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("opportunity-evaluation"),
    id: safeId.regex(/^evaluation_/),
    candidateIds: z
      .array(candidateId)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, "Candidate IDs must be unique."),
    deterministicEvidence: opportunityEvaluationPromptInputSchema.shape.deterministicEvidence,
    productCoverage: opportunityEvaluationPromptInputSchema.shape.productCoverage,
    importedSignals: opportunityEvaluationPromptInputSchema.shape.importedSignals,
    aiJudgment: opportunityEvaluationBatchSchema,
    providerId: nonEmptyText,
    modelId: nonEmptyText.optional(),
    promptVersion: z.literal(OPPORTUNITY_EVALUATION_PROMPT_VERSION),
    prompt: nonEmptyText,
    evaluatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((session, context) => {
    const judgmentIds = session.aiJudgment.evaluations.map(({ candidateId: id }) => id);
    const evidenceIds = session.deterministicEvidence.map(({ candidateId: id }) => id);
    if (
      judgmentIds.length !== session.candidateIds.length ||
      new Set(judgmentIds).size !== judgmentIds.length ||
      judgmentIds.some((id) => !session.candidateIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["aiJudgment", "evaluations"],
        message: "Stored AI judgments must match candidate IDs exactly.",
      });
    }
    if (
      evidenceIds.length !== session.candidateIds.length ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((id) => !session.candidateIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["deterministicEvidence"],
        message: "Stored deterministic evidence must match candidate IDs exactly.",
      });
    }
  });

export type OpportunityEvaluationSession = z.infer<typeof opportunityEvaluationSessionSchema>;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function opportunityEvaluationSessionPath(repositoryRoot: string, id: string): string {
  opportunityEvaluationSessionSchema.shape.id.parse(id);
  return resolve(repositoryRoot, OPPORTUNITY_EVALUATIONS_DIRECTORY, `${id}.json`);
}

export class OpportunityEvaluationStore {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = repositoryRoot;
  }

  list(): OpportunityEvaluationSession[] {
    const directory = resolve(this.repositoryRoot, OPPORTUNITY_EVALUATIONS_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = relative(this.repositoryRoot, resolve(directory, entry.name)).replaceAll(
          "\\",
          "/",
        );
        const parsed = opportunityEvaluationSessionSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) {
          throw new TypeError(
            `Invalid opportunity evaluation "${file}": ${validationMessage(parsed.error)}`,
          );
        }
        if (`${parsed.data.id}.json` !== entry.name) {
          throw new TypeError(`Invalid opportunity evaluation "${file}": id must match filename.`);
        }
        return parsed.data;
      })
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt));
  }

  latestForCandidate(id: string): OpportunityEvaluationSession | undefined {
    candidateId.parse(id);
    return this.list().find(({ candidateIds }) => candidateIds.includes(id));
  }

  async save(session: OpportunityEvaluationSession): Promise<void> {
    const parsed = opportunityEvaluationSessionSchema.parse(session);
    await atomicWriteJson(opportunityEvaluationSessionPath(this.repositoryRoot, parsed.id), parsed);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function candidateFact(candidate: ArticleCandidate): z.infer<typeof candidateFactSchema> {
  return candidateFactSchema.parse({
    id: candidate.id,
    clusterId: candidate.clusterId,
    proposedTitle: candidate.proposedTitle,
    primaryAxis: candidate.primaryAxis,
    primaryIntent: candidate.primaryIntent,
    problemSolved: candidate.problemSolved,
    targetAudience: candidate.targetAudience,
    secondaryTaxonomies: candidate.secondaryTaxonomies,
    proposedSections: candidate.proposedSections,
    distinctiveProductCategories: candidate.distinctiveProductCategories,
    ...(candidate.sessionMode ? { sessionMode: candidate.sessionMode } : {}),
    sourceProductIds: candidate.sourceProductIds ?? [],
    sourceCategoryIds: candidate.sourceCategoryIds ?? [],
    sourceCoverageSignalIds: candidate.sourceCoverageSignalIds ?? [],
    ...(candidate.differentiation ? { differentiation: candidate.differentiation } : {}),
    ...(candidate.maintenanceImplications
      ? { maintenanceImplications: candidate.maintenanceImplications }
      : {}),
    productRequirements: candidate.productRequirements ?? [],
    catalogGaps: candidate.catalogGaps ?? [],
  });
}

export function prepareOpportunityEvaluationPrompt(
  request: OpportunityEvaluationRequest,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  productCoverage: ProductCoverageAnalysis,
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[] = [],
) {
  const parsed = opportunityEvaluationRequestSchema.parse(request);
  const selected = unique(parsed.candidateIds).map((id) => {
    const candidate = candidates.find((record) => record.id === id);
    if (!candidate) throw new TypeError(`No existe la oportunidad "${id}".`);
    if (candidate.status !== "generated") {
      throw new TypeError(`La oportunidad "${id}" ya no está pendiente de evaluación.`);
    }
    return candidate;
  });
  const importedSignals = [...parsed.importedSignals].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const input = opportunityEvaluationPromptInputSchema.parse({
    candidateFacts: selected.map(candidateFact),
    deterministicEvidence: selected.map((candidate) => ({
      candidateId: candidate.id,
      comparison: compareArticleCandidate(candidate, content, drafts, candidates, approvedBriefs),
    })),
    productCoverage,
    importedSignals,
  });
  const prompt = `You are performing convergent editorial evaluation for The Good Present.

Critically compare the selected candidate batch as a set. Candidate facts are proposals. deterministicEvidence and productCoverage are system-derived facts from the existing deterministic comparison and product-coverage implementations. importedSignals are editor-supplied observed evidence only when present, and their source and date range must remain explicit. Your scores, synthesis, explanations, overlap assessments, risks, and recommendation are AI judgment, never observed evidence.

Return each of these separate integer judgment scores from 0 through 10: intentDifferentiation, editorialUsefulness, productDifferentiation, audienceClarity, seasonalValue, commercialPotential, visualDistributionPotential, productReusePotential, thinContentRisk, cannibalizationRisk, maintenanceCost. Also explain product concentration risk and catalog volatility separately. Together these fields must explicitly consider thin-content risk, cannibalization risk, product concentration risk, catalog volatility, and product-reuse potential. Do not calculate or return a composite score. Missing evidence belongs in missingEvidence and must never be treated as zero. Do not invent search volume, keyword difficulty, Search Console metrics, Pinterest performance, affiliate performance, product facts, prices, stock, availability, or any other unavailable external fact.

Return one advisory recommendation per candidate: create-article, add-as-section, merge, hold, or reject. Explain it actionably. add-as-section and merge require a non-empty targetContentId naming a published-guide target from deterministicEvidence; every other recommendation must omit targetContentId entirely. A thinContentRisk or cannibalizationRisk score of 7 or more requires the corresponding non-empty actionable risk field. When either score is below 7, omit its corresponding risk-action field entirely. Never use null or an empty string for any conditional field. Do not shortlist, decide, create, merge, delete, reject, hold, create a brief or draft, or publish anything.

Return exactly one JSON object with this shape and no additional fields:
{"batchSynthesis":"...","evaluations":[{"candidateId":"candidate_...","scores":{"intentDifferentiation":6,"editorialUsefulness":7,"productDifferentiation":5,"audienceClarity":7,"seasonalValue":4,"commercialPotential":5,"visualDistributionPotential":5,"productReusePotential":6,"thinContentRisk":4,"cannibalizationRisk":5,"maintenanceCost":4},"recommendation":"hold","explanation":"...","missingEvidence":["..."],"productConcentrationRisk":"...","catalogVolatility":"..."}]}

Evaluation input:
${JSON.stringify(input, null, 2)}`;
  return { version: OPPORTUNITY_EVALUATION_PROMPT_VERSION, input, prompt };
}

export function mockOpportunityEvaluation(
  input: OpportunityEvaluationPromptInput,
): OpportunityEvaluationBatch {
  return opportunityEvaluationBatchSchema.parse({
    batchSynthesis:
      "The selected candidates require human comparison against the visible deterministic overlaps before any editorial action.",
    evaluations: input.candidateFacts.map((candidate) => ({
      candidateId: candidate.id,
      scores: {
        intentDifferentiation: 6,
        editorialUsefulness: 7,
        productDifferentiation: 5,
        audienceClarity: 7,
        seasonalValue: 4,
        commercialPotential: 5,
        visualDistributionPotential: 5,
        productReusePotential: 6,
        thinContentRisk: 4,
        cannibalizationRisk: 5,
        maintenanceCost: 4,
      },
      recommendation: "hold",
      explanation:
        "Keep this candidate in review until an editor compares its distinct intent and product scope with the deterministic evidence.",
      productConcentrationRisk:
        "Confirm that the idea does not depend on one product or one narrow category.",
      catalogVolatility: "Recheck active catalog support before an editor approves a brief.",
      missingEvidence: input.importedSignals.length
        ? []
        : ["No imported source signals were supplied for this evaluation."],
    })),
  });
}

export interface EvaluateConvergentOpportunitiesContext {
  content: ValidatedPublicContent;
  drafts: readonly EditorialDraft[];
  existingCandidates: readonly ArticleCandidate[];
  productCoverage: ProductCoverageAnalysis;
  approvedBriefs?: readonly ApprovedEditorialBriefComparisonRecord[];
  provider: GuideGenerationProvider;
  candidateStore: ArticleCandidateStore;
  evaluationStore: OpportunityEvaluationStore;
  now?: Date;
}

export async function evaluateConvergentOpportunities(
  request: OpportunityEvaluationRequest,
  context: EvaluateConvergentOpportunitiesContext,
) {
  const prepared = prepareOpportunityEvaluationPrompt(
    request,
    context.content,
    context.drafts,
    context.existingCandidates,
    context.productCoverage,
    context.approvedBriefs,
  );
  const expectedIds = new Set(prepared.input.candidateFacts.map(({ id }) => id));
  const publishedGuideIds = new Set(context.content.guides.map(({ id }) => id));
  const exactResponseSchema = opportunityEvaluationBatchSchema.superRefine((batch, validation) => {
    const responseIds = batch.evaluations.map(({ candidateId: id }) => id);
    if (
      responseIds.length !== expectedIds.size ||
      new Set(responseIds).size !== responseIds.length ||
      responseIds.some((id) => !expectedIds.has(id))
    ) {
      validation.addIssue({
        code: "custom",
        path: ["evaluations"],
        message: "The provider must evaluate each selected candidate exactly once.",
      });
    }
    batch.evaluations.forEach((judgment, index) => {
      if (judgment.targetContentId && !publishedGuideIds.has(judgment.targetContentId)) {
        validation.addIssue({
          code: "custom",
          path: ["evaluations", index, "targetContentId"],
          message: "The recommendation target must be an existing published guide.",
        });
      }
    });
  });
  const aiJudgment = exactResponseSchema.parse(
    await context.provider.generateStructured({
      operation: "opportunity-evaluations",
      prompt: prepared.prompt,
      input: prepared.input,
      schema: exactResponseSchema,
    }),
  );
  const now = context.now ?? new Date();
  const judgmentById = new Map(aiJudgment.evaluations.map((item) => [item.candidateId, item]));
  const importedSignalIds = prepared.input.importedSignals.map(({ id }) => id);
  const candidates = prepared.input.candidateFacts.map(({ id }) => {
    const candidate = context.existingCandidates.find((record) => record.id === id)!;
    const judgment = judgmentById.get(id)!;
    const withJudgment = {
      ...candidate,
      scores: judgment.scores,
      advisory: { recommendation: judgment.recommendation, reason: judgment.explanation },
      ...(importedSignalIds.length
        ? { sourceSignalIds: unique([...(candidate.sourceSignalIds ?? []), ...importedSignalIds]) }
        : {}),
    };
    return transitionArticleCandidate(withJudgment, "evaluated", now);
  });
  const session = opportunityEvaluationSessionSchema.parse({
    schemaVersion: 1,
    recordType: "opportunity-evaluation",
    id: `evaluation_${randomUUID()}`,
    candidateIds: candidates.map(({ id }) => id),
    deterministicEvidence: prepared.input.deterministicEvidence,
    productCoverage: prepared.input.productCoverage,
    importedSignals: prepared.input.importedSignals,
    aiJudgment,
    providerId: context.provider.providerId,
    ...(context.provider.modelId ? { modelId: context.provider.modelId } : {}),
    promptVersion: prepared.version,
    prompt: prepared.prompt,
    evaluatedAt: now.toISOString(),
  });

  for (const candidate of candidates) await context.candidateStore.save(candidate);
  await context.evaluationStore.save(session);
  return { session, candidates };
}
