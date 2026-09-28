import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { REPOSITORY_ROOT, atomicWriteJson, runRepositoryMutation } from "./repository.ts";

const auditSchema = z.strictObject({
  ideaKey: z.string().min(1).max(250),
  clusterId: z.string().regex(/^cluster_[a-z0-9_-]+$/),
  guideId: z.string().regex(/^guide_[a-z0-9_-]+$/),
  guideTitle: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  score: z.number().int().min(1).max(10),
  verdict: z.enum(["replace", "supporting", "keep"]),
  comment: z.string().trim().min(1).max(400),
  confidence: z.enum(["high", "medium", "low"]),
  promptVersion: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1).optional(),
  auditedAt: z.iso.datetime(),
});
const auditsSchema = z.array(auditSchema);

export type IdeaAudit = z.infer<typeof auditSchema>;

export class IdeaAuditStore {
  private readonly file: string;
  readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
    this.file = resolve(repositoryRoot, "editorial-data", "idea-audits.json");
  }

  async list(clusterId?: string): Promise<IdeaAudit[]> {
    try {
      const audits = auditsSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      return clusterId ? audits.filter((audit) => audit.clusterId === clusterId) : audits;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async replaceCluster(clusterId: string, audits: readonly IdeaAudit[]): Promise<IdeaAudit[]> {
    const parsed = auditsSchema.parse(audits);
    if (parsed.some((audit) => audit.clusterId !== clusterId)) {
      throw new TypeError("La auditoría contiene ideas de otro grupo.");
    }
    if (new Set(parsed.map((audit) => audit.ideaKey)).size !== parsed.length) {
      throw new TypeError("La auditoría contiene ideas repetidas.");
    }
    return runRepositoryMutation(this.repositoryRoot, async () => {
      const previous = await this.list();
      await atomicWriteJson(
        this.file,
        previous.filter((audit) => audit.clusterId !== clusterId).concat(parsed),
      );
      return parsed;
    });
  }
}
