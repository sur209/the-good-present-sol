import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { Product } from "@the-good-present/content-schema";
import { z } from "zod";

import { atomicWriteJson, REPOSITORY_ROOT } from "../../repository.ts";

export const EDITORIAL_BENCHMARKS_DIRECTORY = "editorial-data/editorial-benchmarks";
export const EDITORIAL_BENCHMARK_REASONS = [
  "more-specific",
  "correct-class",
  "stronger-real-world-use",
  "better-gift-desirability",
  "easier-to-choose",
  "better-presentation",
  "better-value",
  "better-context-fit",
  "less-generic",
] as const;

const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const timestamp = z.iso.datetime({ offset: true });

export const editorialBenchmarkContextSchema = z
  .strictObject({
    guideId: safeId.optional(),
    recommendationSlotId: safeId.optional(),
    semanticContext: nonEmptyText.optional(),
  })
  .superRefine((context, validation) => {
    if (!context.guideId && !context.semanticContext) {
      validation.addIssue({
        code: "custom",
        path: ["semanticContext"],
        message: "A benchmark requires a Guide context or explicit semantic context.",
      });
    }
    if (context.recommendationSlotId && !context.guideId) {
      validation.addIssue({
        code: "custom",
        path: ["recommendationSlotId"],
        message: "A benchmark slot requires its Guide ID.",
      });
    }
  });

export const editorialBenchmarkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordType: z.literal("editorial-benchmark"),
  id: safeId.regex(/^benchmark_/),
  canonicalProductId: safeId.regex(/^product_/),
  productClass: nonEmptyText,
  context: editorialBenchmarkContextSchema,
  audienceTags: textList,
  contextTags: textList,
  editorRationale: nonEmptyText,
  strongFitReasons: z.array(z.enum(EDITORIAL_BENCHMARK_REASONS)).min(1),
  attributesOrReasons: textList,
  sourceDiscoverySessionId: safeId.optional(),
  rejectedAlternativeIds: z.array(safeId),
  status: z.enum(["active", "inactive"]),
  version: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type EditorialBenchmark = z.infer<typeof editorialBenchmarkSchema>;

export interface CreateEditorialBenchmarkInput {
  canonicalProductId: string;
  productClass: string;
  context: z.input<typeof editorialBenchmarkContextSchema>;
  audienceTags?: string[];
  contextTags?: string[];
  editorRationale: string;
  strongFitReasons: EditorialBenchmark["strongFitReasons"];
  attributesOrReasons?: string[];
  sourceDiscoverySessionId?: string;
  rejectedAlternativeIds?: string[];
}

export function createEditorialBenchmark(
  input: CreateEditorialBenchmarkInput,
  products: readonly Product[],
  now = new Date(),
  id = `benchmark_${randomUUID()}`,
): EditorialBenchmark {
  const product = products.find(({ id: productId }) => productId === input.canonicalProductId);
  if (!product) {
    throw new TypeError("An editorial benchmark must reference an existing canonical Product.");
  }
  const createdAt = now.toISOString();
  return editorialBenchmarkSchema.parse({
    schemaVersion: 1,
    recordType: "editorial-benchmark",
    id,
    canonicalProductId: product.id,
    productClass: input.productClass,
    context: input.context,
    audienceTags: input.audienceTags ?? [],
    contextTags: input.contextTags ?? [],
    editorRationale: input.editorRationale,
    strongFitReasons: input.strongFitReasons,
    attributesOrReasons: input.attributesOrReasons ?? [],
    ...(input.sourceDiscoverySessionId
      ? { sourceDiscoverySessionId: input.sourceDiscoverySessionId }
      : {}),
    rejectedAlternativeIds: input.rejectedAlternativeIds ?? [],
    status: "active",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function editorialBenchmarkPath(repositoryRoot: string, id: string): string {
  editorialBenchmarkSchema.shape.id.parse(id);
  return resolve(repositoryRoot, EDITORIAL_BENCHMARKS_DIRECTORY, `${id}.json`);
}

export class EditorialBenchmarkStore {
  readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(products?: readonly Product[]): EditorialBenchmark[] {
    const directory = resolve(this.repositoryRoot, EDITORIAL_BENCHMARKS_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = relative(this.repositoryRoot, resolve(directory, entry.name)).replaceAll(
          "\\",
          "/",
        );
        const parsed = editorialBenchmarkSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) {
          throw new TypeError(
            `Invalid editorial benchmark "${file}": ${validationMessage(parsed.error)}`,
          );
        }
        if (`${parsed.data.id}.json` !== entry.name) {
          throw new TypeError(`Invalid editorial benchmark "${file}": id must match filename.`);
        }
        if (products && !products.some(({ id }) => id === parsed.data.canonicalProductId)) {
          throw new TypeError(
            `Invalid editorial benchmark "${file}": canonical Product does not exist.`,
          );
        }
        return parsed.data;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(input: EditorialBenchmark): Promise<EditorialBenchmark> {
    const benchmark = editorialBenchmarkSchema.parse(input);
    await atomicWriteJson(editorialBenchmarkPath(this.repositoryRoot, benchmark.id), benchmark);
    return benchmark;
  }
}
