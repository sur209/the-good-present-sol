import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  SLUG_PATTERN,
  primaryAxisSchema,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";
import { z } from "zod";

import { DraftStore } from "../../draft-store.ts";
import { createGuideDraft, guideDraftSchema, type GuideDraft } from "../../drafts.ts";
import { REPOSITORY_ROOT, atomicWriteJson, readPublicContent } from "../../repository.ts";
import {
  ArticleCandidateStore,
  applyCandidateDecision,
  articleCandidateSchema,
  candidateSectionsSchema,
  type ArticleCandidate,
} from "./candidates.ts";
import type { ApprovedEditorialBriefComparisonRecord } from "./comparison.ts";

export const EDITORIAL_BRIEFS_DIRECTORY = "editorial-data/editorial-briefs";
export const EDITORIAL_BRIEF_SCHEMA_VERSION = 1 as const;

const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const briefId = safeId.regex(/^brief_/, 'Must start with "brief_".');
const candidateId = safeId.regex(/^candidate_/, 'Must start with "candidate_".');
const guideId = safeId.regex(/^guide_/, 'Must start with "guide_".');
const timestamp = z.iso.datetime({ offset: true });

export const editorialBriefSchema = z
  .strictObject({
    schemaVersion: z.literal(EDITORIAL_BRIEF_SCHEMA_VERSION),
    recordType: z.literal("editorial-brief"),
    id: briefId,
    sourceCandidateId: candidateId,
    clusterId: safeId,
    workingTitle: nonEmptyText,
    proposedSlug: nonEmptyText.regex(SLUG_PATTERN, "Must be a lowercase URL-safe slug."),
    primaryAxis: primaryAxisSchema,
    primaryIntent: nonEmptyText,
    targetAudience: nonEmptyText,
    problemSolved: nonEmptyText,
    differentiation: nonEmptyText,
    plannedSections: candidateSectionsSchema,
    productRequirements: textList,
    researchQuestions: textList,
    expectedInternalLinks: z.array(safeId),
    relatedContentIds: z.array(safeId),
    evidenceNotes: z.strictObject({
      deterministic: textList,
      observed: textList,
      aiInterpretation: textList,
      humanDecision: nonEmptyText,
      editorial: textList,
    }),
    risks: textList,
    status: z.enum(["draft", "approved", "converted-to-guide-draft"]),
    guideDraftId: guideId.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: timestamp.optional(),
    convertedAt: timestamp.optional(),
  })
  .superRefine((brief, context) => {
    const approved = brief.status === "approved" || brief.status === "converted-to-guide-draft";
    if (approved !== Boolean(brief.approvedAt)) {
      context.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: approved ? "An approved brief requires approvedAt." : "A draft has no approvedAt.",
      });
    }
    const converted = brief.status === "converted-to-guide-draft";
    if (converted !== Boolean(brief.convertedAt) || converted !== Boolean(brief.guideDraftId)) {
      context.addIssue({
        code: "custom",
        path: ["guideDraftId"],
        message: converted
          ? "A converted brief requires convertedAt and guideDraftId."
          : "Only a converted brief may reference a GuideDraft.",
      });
    }
  });

export type EditorialBrief = z.infer<typeof editorialBriefSchema>;

export interface EditorialBriefEdits {
  workingTitle: string;
  proposedSlug: string;
  primaryAxis: EditorialBrief["primaryAxis"];
  primaryIntent: string;
  targetAudience: string;
  problemSolved: string;
  differentiation: string;
  plannedSections: EditorialBrief["plannedSections"];
  productRequirements: string[];
  researchQuestions: string[];
  expectedInternalLinks: string[];
  relatedContentIds: string[];
  editorialEvidenceNotes: string[];
  risks: string[];
}

export function createEditorialBrief(
  candidate: ArticleCandidate,
  now = new Date(),
): EditorialBrief {
  if (
    candidate.status !== "approved-for-brief" ||
    candidate.decision?.action !== "create-article"
  ) {
    throw new TypeError("Only a human-approved create-article candidate can create a brief.");
  }
  const timestampValue = now.toISOString();
  return editorialBriefSchema.parse({
    schemaVersion: EDITORIAL_BRIEF_SCHEMA_VERSION,
    recordType: "editorial-brief",
    id: `brief_${randomUUID()}`,
    sourceCandidateId: candidate.id,
    clusterId: candidate.clusterId,
    workingTitle: candidate.proposedTitle,
    proposedSlug: candidate.proposedSlug,
    primaryAxis: candidate.primaryAxis,
    primaryIntent: candidate.primaryIntent,
    targetAudience: candidate.targetAudience,
    problemSolved: candidate.problemSolved,
    differentiation: candidate.problemSolved,
    plannedSections: candidate.proposedSections,
    productRequirements: candidate.distinctiveProductCategories,
    researchQuestions: [],
    expectedInternalLinks: candidate.closestExistingContentIds,
    relatedContentIds: candidate.closestExistingContentIds,
    evidenceNotes: {
      deterministic: candidate.overlapSignals.map(
        (signal) => `${signal.contentId} · ${signal.kind} · ${signal.level}: ${signal.reason}`,
      ),
      observed: (candidate.sourceSignalIds ?? []).map((id) => `Imported signal: ${id}`),
      aiInterpretation: [`${candidate.advisory.recommendation}: ${candidate.advisory.reason}`],
      humanDecision: candidate.decision.reason,
      editorial: [],
    },
    risks: [],
    status: "draft",
    createdAt: timestampValue,
    updatedAt: timestampValue,
  });
}

export function updateEditorialBrief(
  brief: EditorialBrief,
  edits: EditorialBriefEdits,
  now = new Date(),
): EditorialBrief {
  if (brief.status !== "draft") throw new TypeError("Only a draft brief can be edited.");
  const { editorialEvidenceNotes, ...fields } = edits;
  return editorialBriefSchema.parse({
    ...brief,
    ...fields,
    evidenceNotes: { ...brief.evidenceNotes, editorial: editorialEvidenceNotes },
    updatedAt: now.toISOString(),
  });
}

export function approveEditorialBrief(brief: EditorialBrief, now = new Date()): EditorialBrief {
  if (brief.status !== "draft") throw new TypeError("Only a draft brief can be approved.");
  const timestampValue = now.toISOString();
  return editorialBriefSchema.parse({
    ...brief,
    status: "approved",
    approvedAt: timestampValue,
    updatedAt: timestampValue,
  });
}

export function convertEditorialBrief(
  brief: EditorialBrief,
  candidate: ArticleCandidate,
  content: ValidatedPublicContent,
  now = new Date(),
): { brief: EditorialBrief; candidate: ArticleCandidate; draft: GuideDraft } {
  if (brief.status !== "approved") throw new TypeError("Approve the brief before conversion.");
  if (
    candidate.id !== brief.sourceCandidateId ||
    candidate.status !== "approved-for-brief" ||
    candidate.decision?.action !== "create-article" ||
    candidate.editorialBriefId !== brief.id
  ) {
    throw new TypeError("The candidate-to-brief trace is inconsistent.");
  }
  const cluster = content.clusters.find(({ id }) => id === brief.clusterId);
  if (!cluster) throw new TypeError(`The canonical cluster "${brief.clusterId}" does not exist.`);
  const relatedGuideIds = [
    ...new Set([...brief.expectedInternalLinks, ...brief.relatedContentIds]),
  ].filter((id) =>
    content.guides.some((guide) => guide.id === id && guide.clusterId === brief.clusterId),
  );
  const base = createGuideDraft(undefined, now);
  const draft = guideDraftSchema.parse({
    ...base,
    clusterId: brief.clusterId,
    slug: brief.proposedSlug,
    primaryAxis: brief.primaryAxis,
    primaryIntent: brief.primaryIntent,
    relatedGuideIds,
    questionnaire: {
      ...base.questionnaire,
      recipient: brief.targetAudience,
      ...(brief.productRequirements.length
        ? { interests: brief.productRequirements.join("; ") }
        : {}),
      ...(brief.risks.length ? { avoid: brief.risks.join("; ") } : {}),
      additional: [
        `Problem solved: ${brief.problemSolved}`,
        `Differentiation: ${brief.differentiation}`,
        `Planned sections: ${brief.plannedSections
          .map(({ heading, purpose }) => `${heading} — ${purpose}`)
          .join("; ")}`,
        ...(brief.researchQuestions.length
          ? [`Research questions: ${brief.researchQuestions.join("; ")}`]
          : []),
      ].join("\n"),
    },
    title: brief.workingTitle,
  });
  const timestampValue = now.toISOString();
  return {
    draft,
    brief: editorialBriefSchema.parse({
      ...brief,
      status: "converted-to-guide-draft",
      guideDraftId: draft.id,
      convertedAt: timestampValue,
      updatedAt: timestampValue,
    }),
    candidate: articleCandidateSchema.parse({
      ...candidate,
      status: "converted-to-draft",
      guideDraftId: draft.id,
      updatedAt: timestampValue,
    }),
  };
}

export function assertSafeEditorialBriefId(id: string): string {
  const parsed = briefId.safeParse(id);
  if (!parsed.success) throw new TypeError("El ID del brief no es seguro.");
  return parsed.data;
}

export function editorialBriefPath(repositoryRoot: string, id: string): string {
  assertSafeEditorialBriefId(id);
  return resolve(repositoryRoot, EDITORIAL_BRIEFS_DIRECTORY, `${id}.json`);
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

function assertBriefRelations(
  brief: EditorialBrief,
  candidates: readonly ArticleCandidate[],
  content: ValidatedPublicContent,
): void {
  const candidate = candidates.find(({ id }) => id === brief.sourceCandidateId);
  if (!candidate) throw new TypeError(`No existe la oportunidad "${brief.sourceCandidateId}".`);
  if (candidate.clusterId !== brief.clusterId) {
    throw new TypeError("El brief y su oportunidad deben pertenecer al mismo cluster.");
  }
  if (!content.clusters.some(({ id }) => id === brief.clusterId)) {
    throw new TypeError(`No existe el cluster canónico "${brief.clusterId}".`);
  }
  const contentIds = new Set([
    ...content.clusters.map(({ id }) => id),
    ...content.guides.map(({ id }) => id),
  ]);
  const missing = [...brief.expectedInternalLinks, ...brief.relatedContentIds].find(
    (id) => !contentIds.has(id),
  );
  if (missing) throw new TypeError(`No existe el contenido canónico "${missing}".`);
}

export class EditorialBriefStore {
  private readonly repositoryRoot: string;
  private readonly candidateStore: ArticleCandidateStore;

  constructor(
    repositoryRoot = REPOSITORY_ROOT,
    candidateStore = new ArticleCandidateStore(repositoryRoot),
  ) {
    this.repositoryRoot = repositoryRoot;
    this.candidateStore = candidateStore;
  }

  list(): EditorialBrief[] {
    const directory = resolve(this.repositoryRoot, EDITORIAL_BRIEFS_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const candidates = this.candidateStore.list();
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
          assertSafeEditorialBriefId(id);
          const parsed = editorialBriefSchema.safeParse(
            JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
          );
          if (!parsed.success) throw new TypeError(validationMessage(parsed.error));
          if (parsed.data.id !== id) throw new TypeError(`id must match filename stem "${id}".`);
          assertBriefRelations(parsed.data, candidates, content);
          return parsed.data;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new TypeError(`Invalid editorial brief "${file}": ${reason}`, { cause: error });
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): EditorialBrief {
    assertSafeEditorialBriefId(id);
    const brief = this.list().find((record) => record.id === id);
    if (!brief) throw new TypeError(`No existe el brief "${id}".`);
    return brief;
  }

  async save(input: EditorialBrief): Promise<EditorialBrief> {
    const brief = editorialBriefSchema.parse(input);
    assertBriefRelations(brief, this.candidateStore.list(), readPublicContent(this.repositoryRoot));
    await atomicWriteJson(editorialBriefPath(this.repositoryRoot, brief.id), brief);
    return brief;
  }
}

export async function approveCandidateForBrief(
  candidate: ArticleCandidate,
  reason: string,
  candidateStore: ArticleCandidateStore,
  briefStore: EditorialBriefStore,
  now = new Date(),
): Promise<{ candidate: ArticleCandidate; brief: EditorialBrief }> {
  const decided = applyCandidateDecision(candidate, { action: "create-article", reason }, now);
  const brief = createEditorialBrief(decided, now);
  const tracedCandidate = articleCandidateSchema.parse({
    ...decided,
    editorialBriefId: brief.id,
  });
  await briefStore.save(brief);
  await candidateStore.save(tracedCandidate);
  return { candidate: tracedCandidate, brief };
}

export async function convertApprovedBriefToGuideDraft(
  brief: EditorialBrief,
  candidateStore: ArticleCandidateStore,
  briefStore: EditorialBriefStore,
  draftStore: DraftStore,
  content: ValidatedPublicContent,
  now = new Date(),
): Promise<{ brief: EditorialBrief; candidate: ArticleCandidate; draft: GuideDraft }> {
  const converted = convertEditorialBrief(
    brief,
    candidateStore.get(brief.sourceCandidateId),
    content,
    now,
  );
  await draftStore.save(converted.draft, now);
  await briefStore.save(converted.brief);
  await candidateStore.save(converted.candidate);
  return converted;
}

export function editorialBriefComparisonRecords(
  briefs: readonly EditorialBrief[],
): ApprovedEditorialBriefComparisonRecord[] {
  return briefs
    .filter((brief) => brief.status === "approved")
    .map((brief) => ({
      id: brief.id,
      clusterId: brief.clusterId,
      status: "approved" as const,
      proposedTitle: brief.workingTitle,
      proposedSlug: brief.proposedSlug,
      primaryAxis: brief.primaryAxis,
      primaryIntent: brief.primaryIntent,
      taxonomies: {},
      problemSolved: brief.problemSolved,
      proposedSections: brief.plannedSections,
      productCategories: brief.productRequirements,
    }));
}
