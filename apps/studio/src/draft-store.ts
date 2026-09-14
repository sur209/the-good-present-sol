import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { editorialDraftSchema, type EditorialDraft } from "./drafts.ts";
import { REPOSITORY_ROOT, atomicWriteJson } from "./repository.ts";

export const DEFAULT_DRAFT_DIRECTORY = resolve(REPOSITORY_ROOT, "drafts");

const SAFE_DRAFT_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export interface DraftListResult {
  drafts: EditorialDraft[];
  errors: string[];
}

export function assertSafeDraftId(id: string): void {
  if (!SAFE_DRAFT_ID.test(id)) throw new TypeError("ID de borrador no válido.");
}

export class DraftStore {
  private readonly directory: string;
  // ponytail: one local save queue; use per-draft queues if Studio write throughput matters.
  private pendingSave: Promise<unknown> = Promise.resolve();

  constructor(directory = DEFAULT_DRAFT_DIRECTORY) {
    this.directory = directory;
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
    const saving = this.pendingSave.then(() => this.write(draft, now, expected));
    this.pendingSave = saving.catch(() => undefined);
    return saving;
  }

  private async write<T extends EditorialDraft>(draft: T, now: Date, expected?: T): Promise<T> {
    if (expected && JSON.stringify(await this.read(draft.id)) !== JSON.stringify(expected)) {
      throw new TypeError(
        "El borrador cambió mientras se guardaba. Recargá y volvé a revisar las correcciones.",
      );
    }
    const parsed = editorialDraftSchema.parse({ ...draft, updatedAt: now.toISOString() }) as T;
    const target = this.file(parsed.id);

    try {
      await atomicWriteJson(target, parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo guardar el borrador "${parsed.id}": ${reason}`, { cause: error });
    }

    return parsed;
  }
}
