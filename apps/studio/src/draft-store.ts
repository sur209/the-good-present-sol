import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { editorialDraftSchema, type EditorialDraft } from "./drafts.ts";
import { REPOSITORY_ROOT, atomicWriteJson, runRepositoryMutation } from "./repository.ts";

export const DEFAULT_DRAFT_DIRECTORY = resolve(REPOSITORY_ROOT, "drafts");

const SAFE_DRAFT_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export interface DraftListResult {
  drafts: EditorialDraft[];
  errors: string[];
}

export function assertSafeDraftId(id: string): void {
  if (!SAFE_DRAFT_ID.test(id)) throw new TypeError("ID de borrador no válido.");
}

export class StaleDraftError extends TypeError {
  constructor() {
    super(
      "Esta guía cambió después de abrir esta página. Recargá antes de guardar; el trabajo más nuevo se conservó.",
    );
    this.name = "StaleDraftError";
  }
}

interface ExpectedRevisionContext {
  revision: number;
  used: boolean;
}

export class DraftStore {
  readonly repositoryRoot: string;
  private readonly directory: string;
  private readonly expectedRevision = new AsyncLocalStorage<ExpectedRevisionContext>();

  constructor(
    directory = DEFAULT_DRAFT_DIRECTORY,
    repositoryRoot = basename(directory).toLowerCase() === "drafts"
      ? dirname(directory)
      : directory,
  ) {
    this.directory = directory;
    this.repositoryRoot = resolve(repositoryRoot);
  }

  private file(id: string): string {
    assertSafeDraftId(id);
    return resolve(this.directory, `${id}.json`);
  }

  async read(id: string): Promise<EditorialDraft> {
    const file = this.file(id);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo leer el borrador "${id}": ${reason}`, { cause: error });
    }

    const parsed = editorialDraftSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`El borrador "${id}" no cumple el esquema: ${parsed.error.message}`);
    }
    if (parsed.data.id !== id)
      throw new Error(`El nombre del archivo no coincide con el ID "${id}".`);
    return parsed.data;
  }

  async list(): Promise<DraftListResult> {
    try {
      await mkdir(this.directory, { recursive: true });
      const names = (await readdir(this.directory))
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .sort();
      const drafts: EditorialDraft[] = [];
      const errors: string[] = [];
      for (const name of names) {
        const id = name.slice(0, -5);
        try {
          drafts.push(await this.read(id));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { drafts, errors };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo listar la carpeta de borradores: ${reason}`, { cause: error });
    }
  }

  async save<T extends EditorialDraft>(draft: T, now = new Date(), expected?: T): Promise<T> {
    const expectedRevision = this.takeExpectedRevision(expected?.revision ?? draft.revision);
    return runRepositoryMutation(this.repositoryRoot, () =>
      this.write(draft, now, expectedRevision),
    );
  }

  withExpectedRevision<T>(revision: number, operation: () => Promise<T>): Promise<T> {
    return this.expectedRevision.run({ revision, used: false }, operation);
  }

  assertExpectedRevision(actualRevision: number): void {
    if (this.takeExpectedRevision(actualRevision) !== actualRevision) throw new StaleDraftError();
  }

  private takeExpectedRevision(fallback: number): number {
    const scoped = this.expectedRevision.getStore();
    return scoped && !scoped.used ? ((scoped.used = true), scoped.revision) : fallback;
  }

  private async write<T extends EditorialDraft>(
    draft: T,
    now: Date,
    expectedRevision: number,
  ): Promise<T> {
    let current: EditorialDraft | undefined;
    try {
      current = await this.read(draft.id);
    } catch (error) {
      if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code !== "ENOENT")
        throw error;
    }
    if (current && current.revision !== expectedRevision) {
      throw new StaleDraftError();
    }
    const parsed = editorialDraftSchema.parse({
      ...draft,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now.toISOString(),
    }) as T;
    const target = this.file(parsed.id);

    try {
      if (current) {
        await atomicWriteJson(
          resolve(this.directory, ".backups", `${parsed.id}.previous.json`),
          current,
        );
      }
      await atomicWriteJson(target, parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo guardar el borrador "${parsed.id}": ${reason}`, { cause: error });
    }

    return parsed;
  }
}
