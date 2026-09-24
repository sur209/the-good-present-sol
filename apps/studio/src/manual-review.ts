import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { type GuideGenerationProvider } from "./ai-provider.ts";
import { guideDraftSchema, type GuideDraft } from "./drafts.ts";
import { REPOSITORY_ROOT, atomicWriteJson } from "./repository.ts";

const guideFields = ["title", "excerpt", "introduction", "conclusion"] as const;
const recommendationFields = [
  "heading",
  "editorialDescription",
  "whyItFits",
  "bestFor",
  "selectionGuidance",
  "considerations",
] as const;

export type ReviewField = (typeof guideFields)[number] | (typeof recommendationFields)[number];

const reviewRecordSchema = z.strictObject({
  id: z.string().regex(/^review_[a-f0-9-]+$/),
  guideId: z.string(),
  kind: z.enum(["idea", "copy"]),
  status: z.enum(["proposed", "accepted", "rejected"]),
  recommendationId: z.string().optional(),
  replacementRecommendationId: z.string().optional(),
  field: z.enum([...guideFields, ...recommendationFields]).optional(),
  selectedQuote: z.string().optional(),
  comment: z.string().trim().min(1).max(1000),
  previousText: z.string(),
  proposedText: z.string(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
});

export type ManualReviewRecord = z.infer<typeof reviewRecordSchema>;

export class ManualReviewStore {
  private readonly directory: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.directory = resolve(repositoryRoot, "editorial-data", "manual-reviews");
  }

  private file(id: string): string {
    if (!/^review_[a-f0-9-]+$/.test(id)) throw new TypeError("ID de revisión no válido.");
    return resolve(this.directory, `${id}.json`);
  }

  async list(guideId?: string): Promise<ManualReviewRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^review_[a-f0-9-]+\.json$/.test(name))
        .map((name) => this.read(name.slice(0, -5))),
    );
    return records
      .filter((record) => !guideId || record.guideId === guideId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async read(id: string): Promise<ManualReviewRecord> {
    return reviewRecordSchema.parse(JSON.parse(await readFile(this.file(id), "utf8")));
  }

  async save(record: ManualReviewRecord): Promise<ManualReviewRecord> {
    const parsed = reviewRecordSchema.parse(record);
    await atomicWriteJson(this.file(parsed.id), parsed);
    return parsed;
  }
}

function recommendation(draft: GuideDraft, id: string) {
  const found = draft.recommendations.find((item) => item.id === id);
  if (!found) throw new TypeError("La idea ya no existe en el borrador.");
  return found;
}

export function reviewFieldText(
  draft: GuideDraft,
  field: ReviewField,
  recommendationId?: string,
): string {
  if ((guideFields as readonly string[]).includes(field)) {
    if (recommendationId) throw new TypeError("Este campo pertenece a la guía.");
    return draft[field as (typeof guideFields)[number]] ?? "";
  }
  if (!(recommendationFields as readonly string[]).includes(field) || !recommendationId) {
    throw new TypeError("Campo editorial no válido.");
  }
  return (
    recommendation(draft, recommendationId)[field as (typeof recommendationFields)[number]] ?? ""
  );
}

export function replaceIdeaInDraft(
  draft: GuideDraft,
  recommendationId: string,
  concept: string,
): { draft: GuideDraft; newId: string } {
  const clean = concept.trim();
  if (clean.length < 4 || clean.length > 120) {
    throw new TypeError("La nueva idea debe tener entre 4 y 120 caracteres.");
  }
  const current = recommendation(draft, recommendationId);
  if (clean.toLocaleLowerCase() === (current.heading ?? current.slotLabel).toLocaleLowerCase()) {
    throw new TypeError("La nueva idea debe ser distinta de la anterior.");
  }
  const newId = `review_${randomUUID()}`;
  return {
    newId,
    draft: guideDraftSchema.parse({
      ...draft,
      status: "editing",
      recommendations: draft.recommendations.map((item) =>
        item.id === recommendationId
          ? {
              id: newId,
              position: item.position,
              slotLabel: clean,
              heading: clean,
              searchTerms: [clean],
              editorialStatus: "needs-generation",
            }
          : item,
      ),
    }),
  };
}

export function ideaReviewRecord(
  draft: GuideDraft,
  recommendationId: string,
  replacementRecommendationId: string,
  concept: string,
  comment: string,
  now = new Date(),
): ManualReviewRecord {
  return reviewRecordSchema.parse({
    id: `review_${randomUUID()}`,
    guideId: draft.id,
    kind: "idea",
    status: "accepted",
    recommendationId,
    replacementRecommendationId,
    comment,
    previousText:
      recommendation(draft, recommendationId).heading ??
      recommendation(draft, recommendationId).slotLabel,
    proposedText: concept.trim(),
    createdAt: now.toISOString(),
    decidedAt: now.toISOString(),
  });
}

const revisionSchema = z.strictObject({ replacementText: z.string().trim().min(1).max(3000) });

export async function proposeCopyReview(
  draft: GuideDraft,
  field: ReviewField,
  recommendationId: string | undefined,
  selectedQuote: string | undefined,
  comment: string,
  provider: GuideGenerationProvider,
  now = new Date(),
): Promise<ManualReviewRecord> {
  const previousText = reviewFieldText(draft, field, recommendationId);
  if (!previousText) throw new TypeError("Este campo todavía no tiene texto para revisar.");
  const cleanComment = comment.trim();
  if (!cleanComment || cleanComment.length > 1000) {
    throw new TypeError("Escribí un comentario de hasta 1000 caracteres.");
  }
  const quote = selectedQuote?.trim();
  if (quote && !previousText.includes(quote)) {
    throw new TypeError("La selección ya no coincide con el texto vigente.");
  }
  const input = {
    guideTitle: draft.title ?? "",
    ...(recommendationId ? { idea: recommendation(draft, recommendationId).heading ?? "" } : {}),
    field,
    currentText: previousText,
    ...(quote ? { selectedQuote: quote } : {}),
    editorComment: cleanComment,
  };
  const result = await provider.generateStructured({
    operation: "manual-copy-revision",
    prompt:
      'Revise only the supplied English editorial field according to the editor\'s comment. Keep its meaning and factual caution unless the comment changes it. Do not invent product claims, prices, medical effects, or links. Return the full replacement field text as JSON: {"replacementText":"..."}. Do not rewrite any other field.',
    input,
    schema: revisionSchema,
    mockResponse: () => ({ replacementText: previousText }),
  });
  if (result.replacementText === previousText) {
    throw new TypeError("La propuesta no cambió el texto; probá con un comentario más específico.");
  }
  return reviewRecordSchema.parse({
    id: `review_${randomUUID()}`,
    guideId: draft.id,
    kind: "copy",
    status: "proposed",
    ...(recommendationId ? { recommendationId } : {}),
    field,
    ...(quote ? { selectedQuote: quote } : {}),
    comment: cleanComment,
    previousText,
    proposedText: result.replacementText,
    createdAt: now.toISOString(),
  });
}

export function applyCopyReview(draft: GuideDraft, record: ManualReviewRecord): GuideDraft {
  if (record.kind !== "copy" || record.status !== "proposed" || !record.field) {
    throw new TypeError("La propuesta no está pendiente.");
  }
  if (record.guideId !== draft.id) throw new TypeError("La propuesta pertenece a otra guía.");
  if (reviewFieldText(draft, record.field, record.recommendationId) !== record.previousText) {
    throw new TypeError("El texto cambió desde la propuesta; generá una nueva revisión.");
  }
  if ((guideFields as readonly string[]).includes(record.field)) {
    return guideDraftSchema.parse({
      ...draft,
      status: "editing",
      [record.field]: record.proposedText,
    });
  }
  return guideDraftSchema.parse({
    ...draft,
    status: "editing",
    recommendations: draft.recommendations.map((item) =>
      item.id === record.recommendationId
        ? { ...item, [record.field!]: record.proposedText }
        : item,
    ),
  });
}

export function decideCopyReview(
  record: ManualReviewRecord,
  decision: "accepted" | "rejected",
  now = new Date(),
): ManualReviewRecord {
  if (record.kind !== "copy" || record.status !== "proposed") {
    throw new TypeError("La propuesta ya fue resuelta.");
  }
  return reviewRecordSchema.parse({
    ...record,
    status: decision,
    decidedAt: now.toISOString(),
  });
}

export function manualFeedbackHints(
  records: readonly ManualReviewRecord[],
  kind: "idea" | "copy",
): string[] {
  return records
    .filter((record) => record.kind === kind && record.status === "accepted")
    .slice(0, 3)
    .map((record) =>
      kind === "idea"
        ? `Editor replaced “${record.previousText.slice(0, 70)}” with “${record.proposedText.slice(0, 70)}”: ${record.comment.slice(0, 120)}`
        : `Editor changed “${(record.selectedQuote ?? record.previousText).slice(0, 70)}” to “${record.proposedText.slice(0, 90)}”: ${record.comment.slice(0, 120)}`,
    );
}
