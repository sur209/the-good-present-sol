import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { REPOSITORY_ROOT, atomicWriteJson, runRepositoryMutation } from "./repository.ts";

const scoreSchema = z.number().int().min(1).max(10);
const reasonSchema = z.string().trim().min(1).max(240);
const ratingSchema = z.strictObject({
  ideaKey: z.string().min(1).max(250),
  clusterId: z.string().regex(/^cluster_[a-z0-9_-]+$/),
  label: z.string().trim().min(1).max(200),
  score: scoreSchema,
  reason: reasonSchema.optional(),
  updatedAt: z.iso.datetime(),
  history: z.array(
    z.strictObject({
      score: scoreSchema,
      reason: reasonSchema.optional(),
      assignedAt: z.iso.datetime(),
    }),
  ),
});
const ratingsSchema = z.array(ratingSchema);

export type IdeaRating = z.infer<typeof ratingSchema>;

export class IdeaRatingStore {
  private readonly file: string;
  readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
    this.file = resolve(repositoryRoot, "editorial-data", "idea-ratings.json");
  }

  async list(): Promise<IdeaRating[]> {
    try {
      return ratingsSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async assignMany(
    entries: readonly {
      idea: { ideaKey: string; clusterId: string; label: string };
      score: number;
      reason?: string;
    }[],
    now = new Date(),
  ): Promise<IdeaRating[]> {
    if (!entries.length || entries.some(({ score }) => !scoreSchema.safeParse(score).success)) {
      throw new TypeError("Elegí un puntaje del 1 al 10.");
    }
    if (entries.some(({ reason }) => reason?.trim() && !reasonSchema.safeParse(reason).success)) {
      throw new TypeError("El motivo debe tener hasta 240 caracteres.");
    }
    const keys = new Set(entries.map(({ idea }) => idea.ideaKey));
    if (keys.size !== entries.length) throw new TypeError("Hay ideas repetidas en la selección.");
    return runRepositoryMutation(this.repositoryRoot, async () => {
      const ratings = await this.list();
      const previousByKey = new Map(ratings.map((rating) => [rating.ideaKey, rating]));
      const updated = entries.map(({ idea, score, reason }) => {
        const savedReason =
          reason === undefined
            ? previousByKey.get(idea.ideaKey)?.reason
            : reason.trim() || undefined;
        return ratingSchema.parse({
          ideaKey: idea.ideaKey,
          clusterId: idea.clusterId,
          label: idea.label,
          score,
          ...(savedReason ? { reason: savedReason } : {}),
          updatedAt: now.toISOString(),
          history: [
            ...(previousByKey.get(idea.ideaKey)?.history ?? []),
            {
              score,
              ...(savedReason ? { reason: savedReason } : {}),
              assignedAt: now.toISOString(),
            },
          ],
        });
      });
      await atomicWriteJson(
        this.file,
        ratings.filter((rating) => !keys.has(rating.ideaKey)).concat(updated),
      );
      return updated;
    });
  }
}

export function ideaRatingHints(ratings: readonly IdeaRating[], clusterId: string): string[] {
  return ratings
    .filter((rating) => rating.clusterId === clusterId)
    .sort(
      (a, b) =>
        Math.abs(b.score - 5.5) - Math.abs(a.score - 5.5) || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 8)
    .map(
      (rating) =>
        `Editor rated “${rating.label.slice(0, 80)}” ${rating.score}/10.${rating.reason ? ` Context and reason: ${rating.reason}` : ""}`,
    );
}
