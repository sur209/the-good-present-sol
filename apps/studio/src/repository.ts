import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertValidPublicContent } from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../scripts/content-files.ts";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function readPublicContent(repositoryRoot = REPOSITORY_ROOT) {
  return assertValidPublicContent(readPublicContentSources(repositoryRoot));
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
