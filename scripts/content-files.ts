import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_CONTENT_DIRECTORIES,
  type EditorialContentSources,
  type PublicContentSources,
  type SourceRecord,
} from "@the-good-present/content-schema";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function readJsonDirectory(repositoryRoot: string, directory: string): SourceRecord[] {
  const absoluteDirectory = resolve(repositoryRoot, directory);
  let entries;

  try {
    entries = readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read canonical content directory "${directory}": ${reason}`);
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const absoluteFile = resolve(absoluteDirectory, entry.name);
      const file = relative(repositoryRoot, absoluteFile).replaceAll("\\", "/");

      try {
        return { file, data: JSON.parse(readFileSync(absoluteFile, "utf8")) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { file, data: undefined, readError: `Invalid JSON: ${reason}` };
      }
    });
}

export function readPublicContentSources(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): PublicContentSources {
  return {
    products: readJsonDirectory(repositoryRoot, PUBLIC_CONTENT_DIRECTORIES.products),
    clusters: readJsonDirectory(repositoryRoot, PUBLIC_CONTENT_DIRECTORIES.clusters),
    guides: readJsonDirectory(repositoryRoot, PUBLIC_CONTENT_DIRECTORIES.guides),
  };
}

export function readEditorialContentSources(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): EditorialContentSources {
  return {
    clusters: readJsonDirectory(repositoryRoot, PUBLIC_CONTENT_DIRECTORIES.clusters),
    guides: readJsonDirectory(repositoryRoot, PUBLIC_CONTENT_DIRECTORIES.guides),
  };
}
