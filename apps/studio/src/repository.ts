import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidEditorialContent,
  assertValidPublicContent,
  formatValidationIssues,
  validateEditorialContent,
  validatePublicContent,
  type PublicContentSources,
  type EditorialContentSources,
  type SourceRecord,
} from "@the-good-present/content-schema";

import {
  readEditorialContentSources,
  readPublicContentSources,
} from "../../../scripts/content-files.ts";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const repositoryMutations = new Map<string, Promise<unknown>>();

export async function runRepositoryMutation<T>(
  repositoryRoot: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const root = resolve(repositoryRoot);
  const previous = repositoryMutations.get(root) ?? Promise.resolve();
  const current = previous.then(mutation);
  const settled = current.catch(() => undefined);
  repositoryMutations.set(root, settled);
  try {
    return await current;
  } finally {
    if (repositoryMutations.get(root) === settled) repositoryMutations.delete(root);
  }
}

interface StudioWriterLock {
  pid: number;
  startedAt: string;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class StudioWriterGuard {
  readonly repositoryRoot: string;
  private readonly file: string;
  private readonly token = randomUUID();
  private owned = false;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.file = resolve(this.repositoryRoot, ".studio-writer.lock");
  }

  acquire(): void {
    if (this.owned) return;
    mkdirSync(this.repositoryRoot, { recursive: true });
    const lock: StudioWriterLock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: this.token,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = openSync(this.file, "wx", 0o600);
        try {
          writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
        } finally {
          closeSync(descriptor);
        }
        this.owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: StudioWriterLock;
        try {
          existing = JSON.parse(readFileSync(this.file, "utf8")) as StudioWriterLock;
        } catch {
          throw new TypeError(
            `Existe ${this.file}, pero no se puede comprobar si el bloqueo está activo. Revisalo manualmente antes de iniciar otro Studio.`,
          );
        }
        if (!Number.isInteger(existing.pid) || existing.pid < 1 || processIsAlive(existing.pid)) {
          throw new TypeError(
            `Ya hay otro Studio con escritura para este repositorio (PID ${existing.pid || "desconocido"}). Cerralo antes de iniciar otro.`,
          );
        }
        try {
          rmSync(this.file);
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
        }
      }
    }
    throw new TypeError("No se pudo adquirir el bloqueo de escritura del Studio.");
  }

  release(): void {
    if (!this.owned) return;
    try {
      const existing = JSON.parse(readFileSync(this.file, "utf8")) as StudioWriterLock;
      if (existing.token === this.token) rmSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.owned = false;
    }
  }
}

export function readPublicContent(repositoryRoot = REPOSITORY_ROOT) {
  return assertValidPublicContent(readPublicContentSources(repositoryRoot));
}

export function readEditorialContent(repositoryRoot = REPOSITORY_ROOT) {
  return assertValidEditorialContent(readEditorialContentSources(repositoryRoot));
}

export function replaceSourceRecord<T extends { id: string }>(
  sources: SourceRecord[],
  file: string,
  data: T,
): void {
  const index = sources.findIndex(
    (source) =>
      typeof source.data === "object" &&
      source.data !== null &&
      "id" in source.data &&
      source.data.id === data.id,
  );
  if (index === -1) sources.push({ file, data });
  else sources[index] = { file, data };
}

export function assertPublicContentCandidate(sources: PublicContentSources, message: string): void {
  const validation = validatePublicContent(sources);
  if (!validation.success) {
    throw new TypeError(`${message}\n${formatValidationIssues(validation.issues)}`);
  }
}

export function assertEditorialContentCandidate(
  sources: EditorialContentSources,
  message: string,
): void {
  const validation = validateEditorialContent(sources);
  if (!validation.success) {
    throw new TypeError(`${message}\n${formatValidationIssues(validation.issues)}`);
  }
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
