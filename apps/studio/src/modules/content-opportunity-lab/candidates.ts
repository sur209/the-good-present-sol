import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { SLUG_PATTERN, primaryAxisSchema } from "@the-good-present/content-schema";
import { z } from "zod";

import { REPOSITORY_ROOT, atomicWriteJson, readPublicContent } from "../../repository.ts";

export const ARTICLE_CANDIDATES_DIRECTORY = "editorial-data/article-candidates";
export const ARTICLE_CANDIDATE_SCHEMA_VERSION = 1 as const;

export const CANDIDATE_STATUSES = [
  "generated",
  "evaluated",
  "shortlisted",
  "approved-for-brief",
  "converted-to-section",
  "merged",
  "converted-to-draft",
  "rejected",
] as const;

export const CANDIDATE_DECISIONS = [
  "create-article",
  "add-as-section",
  "merge",
  "hold",
  "reject",
] as const;

const safeId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Must use a safe lowercase ID.");
const candidateId = safeId.regex(/^candidate_/, 'Must start with "candidate_".');
const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const timestamp = z.iso.datetime({ offset: true });
const editorialScore = z.number().int().min(0).max(10);

export const candidateTaxonomiesSchema = z.strictObject({
  occasions: textList.optional(),
  recipients: textList.optional(),
  careerStages: textList.optional(),
  workContexts: textList.optional(),
  giftStyles: textList.optional(),
  budgetLabels: textList.optional(),
});

export const candidateSectionsSchema = z
  .array(z.strictObject({ heading: nonEmptyText, purpose: nonEmptyText }))
  .min(1);

export const candidateScoresSchema = z.strictObject({
  intentDifferentiation: editorialScore,
  editorialUsefulness: editorialScore,
  productDifferentiation: editorialScore,
  audienceClarity: editorialScore,
  seasonalValue: editorialScore,
  commercialPotential: editorialScore,
  visualDistributionPotential: editorialScore,
  productReusePotential: editorialScore,
  thinContentRisk: editorialScore,
  cannibalizationRisk: editorialScore,
  maintenanceCost: editorialScore,
});

export const candidateDecisionSchema = z
  .strictObject({
    action: z.enum(CANDIDATE_DECISIONS),
    reason: nonEmptyText,
    decidedAt: timestamp,
    targetContentId: safeId.optional(),
  })
  .superRefine((decision, context) => {
    const needsTarget = decision.action === "add-as-section" || decision.action === "merge";
    if (needsTarget !== Boolean(decision.targetContentId)) {
      context.addIssue({
        code: "custom",
        path: ["targetContentId"],
        message: needsTarget
          ? "A target content ID is required for this decision."
          : "This decision must not have a target content ID.",
      });
    }
  });

export const articleCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal(ARTICLE_CANDIDATE_SCHEMA_VERSION),
    recordType: z.literal("article-candidate"),
    id: candidateId,
    clusterId: safeId,
    proposedTitle: nonEmptyText,
    proposedSlug: nonEmptyText.regex(SLUG_PATTERN, "Must be a lowercase URL-safe slug."),
    primaryAxis: primaryAxisSchema,
    primaryIntent: nonEmptyText,
    problemSolved: nonEmptyText,
    targetAudience: nonEmptyText,
    secondaryTaxonomies: candidateTaxonomiesSchema,
    proposedSections: candidateSectionsSchema,
    distinctiveProductCategories: textList.min(1),
    closestExistingContentIds: z.array(safeId),
    overlapSignals: z.array(
      z.strictObject({
        contentId: safeId,
        kind: z.enum(["primary-intent", "target-audience", "section-scope", "product-categories"]),
        level: z.enum(["low", "medium", "high"]),
        reason: nonEmptyText,
      }),
    ),
    scores: candidateScoresSchema,
    advisory: z.strictObject({
      recommendation: z.enum(CANDIDATE_DECISIONS),
      reason: nonEmptyText,
    }),
    sourceSignalIds: z.array(safeId).optional(),
    generationSessionId: safeId.regex(/^generation_/).optional(),
    regeneratedFromCandidateId: candidateId.optional(),
    regeneratedFromSessionId: safeId.regex(/^generation_/).optional(),
    decision: candidateDecisionSchema.optional(),
    editorialBriefId: safeId.regex(/^brief_/).optional(),
    guideDraftId: safeId.regex(/^guide_/).optional(),
    status: z.enum(CANDIDATE_STATUSES),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine((candidate, context) => {
    const decidedStatuses: readonly string[] = [
      "approved-for-brief",
      "converted-to-section",
      "merged",
      "converted-to-draft",
      "rejected",
    ];
    if (!candidate.decision && decidedStatuses.includes(candidate.status)) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "This status requires a human decision.",
      });
    }
    if (
      candidate.editorialBriefId &&
      candidate.status !== "approved-for-brief" &&
      candidate.status !== "converted-to-draft"
    ) {
      context.addIssue({
        code: "custom",
        path: ["editorialBriefId"],
        message: "A brief reference requires an approved or converted candidate.",
      });
    }
    if (candidate.guideDraftId && candidate.status !== "converted-to-draft") {
      context.addIssue({
        code: "custom",
        path: ["guideDraftId"],
        message: "A GuideDraft reference requires converted-to-draft status.",
      });
    }
    if (candidate.regeneratedFromSessionId && !candidate.regeneratedFromCandidateId) {
      context.addIssue({
        code: "custom",
        path: ["regeneratedFromCandidateId"],
        message: "A source generation session requires a source candidate.",
      });
    }
    if (candidate.regeneratedFromCandidateId && !candidate.generationSessionId) {
      context.addIssue({
        code: "custom",
        path: ["generationSessionId"],
        message: "Regenerated alternatives must link to their generation session.",
      });
    }
    if (!candidate.decision) return;
    const validStatuses: Record<(typeof CANDIDATE_DECISIONS)[number], string[]> = {
      "create-article": ["approved-for-brief", "converted-to-draft"],
      "add-as-section": ["converted-to-section"],
      merge: ["merged"],
      hold: ["evaluated", "shortlisted"],
      reject: ["rejected"],
    };
    if (!validStatuses[candidate.decision.action].includes(candidate.status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Status is inconsistent with decision "${candidate.decision.action}".`,
      });
    }
  });

export type ArticleCandidate = z.infer<typeof articleCandidateSchema>;
export type CandidateStatus = ArticleCandidate["status"];
export type CandidateDecision = z.infer<typeof candidateDecisionSchema>;

const statusTransitions: Partial<Record<CandidateStatus, readonly CandidateStatus[]>> = {
  generated: ["evaluated"],
  evaluated: ["shortlisted"],
};

export function candidateStatusTransitions(status: CandidateStatus): readonly CandidateStatus[] {
  return statusTransitions[status] ?? [];
}

export function transitionArticleCandidate(
  candidate: ArticleCandidate,
  status: CandidateStatus,
  now = new Date(),
): ArticleCandidate {
  if (!candidateStatusTransitions(candidate.status).includes(status)) {
    throw new TypeError(`Cannot transition candidate from "${candidate.status}" to "${status}".`);
  }
  return articleCandidateSchema.parse({ ...candidate, status, updatedAt: now.toISOString() });
}

export function applyCandidateDecision(
  candidate: ArticleCandidate,
  input: Omit<CandidateDecision, "decidedAt">,
  now = new Date(),
): ArticleCandidate {
  if (candidate.status !== "evaluated" && candidate.status !== "shortlisted") {
    throw new TypeError(`Candidate status "${candidate.status}" does not accept a decision.`);
  }
  if (candidate.status === "evaluated" && !["hold", "reject"].includes(input.action)) {
    throw new TypeError("Shortlist the candidate before choosing that decision.");
  }
  const status: CandidateStatus = {
    "create-article": "approved-for-brief",
    "add-as-section": "converted-to-section",
    merge: "merged",
    hold: candidate.status,
    reject: "rejected",
  }[input.action] as CandidateStatus;
  const timestampValue = now.toISOString();
  return articleCandidateSchema.parse({
    ...candidate,
    status,
    decision: { ...input, decidedAt: timestampValue },
    updatedAt: timestampValue,
  });
}

export function assertSafeArticleCandidateId(id: string): string {
  const parsed = candidateId.safeParse(id);
  if (!parsed.success) throw new TypeError("El ID de la oportunidad no es seguro.");
  return parsed.data;
}

export function articleCandidatePath(repositoryRoot: string, id: string): string {
  assertSafeArticleCandidateId(id);
  return resolve(repositoryRoot, ARTICLE_CANDIDATES_DIRECTORY, `${id}.json`);
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

function assertCandidateRelations(
  candidate: ArticleCandidate,
  content: ReturnType<typeof readPublicContent>,
): void {
  if (!content.clusters.some((cluster) => cluster.id === candidate.clusterId)) {
    throw new TypeError(`No existe el cluster canónico "${candidate.clusterId}".`);
  }
  const contentIds = new Set([
    ...content.clusters.map((cluster) => cluster.id),
    ...content.guides.map((guide) => guide.id),
  ]);
  const referencedIds = [
    ...candidate.closestExistingContentIds,
    ...candidate.overlapSignals.map((signal) => signal.contentId),
  ];
  const missing = referencedIds.find((id) => !contentIds.has(id));
  if (missing) throw new TypeError(`No existe el contenido canónico "${missing}".`);
  if (
    candidate.decision?.targetContentId &&
    !content.guides.some((guide) => guide.id === candidate.decision?.targetContentId)
  ) {
    throw new TypeError(
      `No existe la guía canónica "${candidate.decision.targetContentId}" para la decisión.`,
    );
  }
}

export class ArticleCandidateStore {
  private readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(): ArticleCandidate[] {
    const directory = resolve(this.repositoryRoot, ARTICLE_CANDIDATES_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }

    const content = readPublicContent(this.repositoryRoot);

    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const file = relative(this.repositoryRoot, resolve(directory, entry.name)).replaceAll(
          "\\",
          "/",
        );
        const id = entry.name.slice(0, -5);
        try {
          assertSafeArticleCandidateId(id);
          const parsed = articleCandidateSchema.safeParse(
            JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
          );
          if (!parsed.success) throw new TypeError(validationMessage(parsed.error));
          if (parsed.data.id !== id) throw new TypeError(`id must match filename stem "${id}".`);
          assertCandidateRelations(parsed.data, content);
          return parsed.data;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new TypeError(`Invalid article candidate "${file}": ${reason}`, { cause: error });
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): ArticleCandidate {
    assertSafeArticleCandidateId(id);
    const candidate = this.list().find((record) => record.id === id);
    if (!candidate) throw new TypeError(`No existe la oportunidad "${id}".`);
    return candidate;
  }

  async save(input: ArticleCandidate): Promise<ArticleCandidate> {
    const candidate = articleCandidateSchema.parse(input);
    const content = readPublicContent(this.repositoryRoot);
    assertCandidateRelations(candidate, content);
    await atomicWriteJson(articleCandidatePath(this.repositoryRoot, candidate.id), candidate);
    return candidate;
  }
}
