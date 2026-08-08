import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { safeHttpUrlSchema, type Product } from "@the-good-present/content-schema";
import { z } from "zod";

import { REPOSITORY_ROOT, atomicWriteJson, readPublicContent } from "../../repository.ts";

export const PRODUCT_SOURCES_DIRECTORY = "editorial-data/product-sources";

export const PRODUCT_SOURCE_KINDS = [
  "manual",
  "manual-amazon",
  "csv-import",
  "amazon-creators-api",
] as const;

export const PRODUCT_SOURCE_IMPORT_METHODS = ["manual", "csv", "api"] as const;
export const PRODUCT_SOURCE_STATUSES = ["active", "inactive", "needs-review"] as const;

export function createProductSourceId(): string {
  return `source_${randomUUID()}`;
}

const safeId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Must use a safe lowercase ID.");
const nonEmptyText = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });

export const productSourceRecordSchema = z
  .strictObject({
    id: safeId,
    productId: safeId,
    sourceKind: z.enum(PRODUCT_SOURCE_KINDS),
    provider: nonEmptyText,
    marketplace: nonEmptyText.optional(),
    externalId: nonEmptyText.optional(),
    sourceUrl: safeHttpUrlSchema.optional(),
    importMethod: z.enum(PRODUCT_SOURCE_IMPORT_METHODS),
    importedAt: timestamp,
    lastReviewedAt: timestamp.optional(),
    lastSynchronizedAt: timestamp.optional(),
    sourceStatus: z.enum(PRODUCT_SOURCE_STATUSES),
    notes: nonEmptyText.optional(),
  })
  .refine((record) => !record.externalId || record.marketplace, {
    path: ["marketplace"],
    message: "Marketplace is required when an external ID is present.",
  });

export type ProductSourceRecord = z.infer<typeof productSourceRecordSchema>;

export interface ProductSourceFile {
  file: string;
  source?: ProductSourceRecord;
  error?: string;
}

const sourceIdPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function assertSafeProductSourceId(id: string): string {
  if (!sourceIdPattern.test(id)) {
    throw new TypeError("El ID de la fuente no es seguro.");
  }
  return id;
}

export function productSourcePath(repositoryRoot: string, id: string): string {
  assertSafeProductSourceId(id);
  return resolve(repositoryRoot, PRODUCT_SOURCES_DIRECTORY, `${id}.json`);
}

export function readProductSourceRecords(repositoryRoot = REPOSITORY_ROOT): ProductSourceFile[] {
  const directory = resolve(repositoryRoot, PRODUCT_SOURCES_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  // ponytail: one directory scan is enough for a local provenance ledger; index it only after scale requires it.
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const file = relative(repositoryRoot, resolve(directory, entry.name)).replaceAll("\\", "/");
      const id = entry.name.slice(0, -5);
      try {
        assertSafeProductSourceId(id);
        const parsed = productSourceRecordSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) return { file, error: validationMessage(parsed.error) };
        if (parsed.data.id !== id) {
          return { file, error: `id must match the filename stem "${id}".` };
        }
        return { file, source: parsed.data };
      } catch (error) {
        return { file, error: error instanceof Error ? error.message : String(error) };
      }
    });
}

function sourceLookupKey(provider: string, marketplace: string, externalId: string): string {
  return [provider, marketplace, externalId]
    .map((value) => value.trim().toLocaleLowerCase("en-US"))
    .join("\u0000");
}

export function findProductSource(
  records: ProductSourceRecord[],
  provider: string,
  marketplace: string,
  externalId: string,
): ProductSourceRecord | undefined {
  const key = sourceLookupKey(provider, marketplace, externalId);
  return records.find(
    (record) =>
      record.externalId !== undefined &&
      record.marketplace !== undefined &&
      sourceLookupKey(record.provider, record.marketplace, record.externalId) === key,
  );
}

export function findDuplicateProductSource(
  records: ProductSourceRecord[],
  candidate: ProductSourceRecord,
): ProductSourceRecord | undefined {
  const { externalId, marketplace } = candidate;
  if (!externalId || !marketplace) return undefined;
  return records.find(
    (record) =>
      record.id !== candidate.id &&
      record.externalId !== undefined &&
      record.marketplace !== undefined &&
      sourceLookupKey(record.provider, record.marketplace, record.externalId) ===
        sourceLookupKey(candidate.provider, marketplace, externalId),
  );
}

function validSourceRecords(repositoryRoot: string, products: Product[]): ProductSourceRecord[] {
  const files = readProductSourceRecords(repositoryRoot);
  const errors = files
    .filter((record) => record.error)
    .map((record) => `${record.file}: ${record.error}`);
  if (errors.length)
    throw new TypeError(`Hay fuentes de producto inválidas.\n${errors.join("\n")}`);

  const records = files.flatMap((record) => (record.source ? [record.source] : []));
  const productIds = new Set(products.map((product) => product.id));
  const missing = records.filter((record) => !productIds.has(record.productId));
  if (missing.length) {
    throw new TypeError(
      `La fuente ${missing[0]!.id} referencia un producto inexistente: ${missing[0]!.productId}.`,
    );
  }
  for (const record of records) {
    const duplicate = findDuplicateProductSource(records, record);
    if (duplicate) {
      throw new TypeError(
        `El ID externo ${record.externalId} ya existe para ${record.provider} en ${record.marketplace} (${duplicate.id}).`,
      );
    }
  }
  return records;
}

export class ProductSourceStore {
  private readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(products?: Product[]): ProductSourceRecord[] {
    return validSourceRecords(
      this.repositoryRoot,
      products ?? readPublicContent(this.repositoryRoot).products,
    );
  }

  forProduct(productId: string, products?: Product[]): ProductSourceRecord[] {
    return this.list(products).filter((record) => record.productId === productId);
  }

  get(id: string, products?: Product[]): ProductSourceRecord {
    assertSafeProductSourceId(id);
    const source = this.list(products).find((record) => record.id === id);
    if (!source) throw new TypeError(`No existe la fuente de producto "${id}".`);
    return source;
  }

  lookup(
    provider: string,
    marketplace: string,
    externalId: string,
    products?: Product[],
  ): ProductSourceRecord | undefined {
    return findProductSource(this.list(products), provider, marketplace, externalId);
  }

  async save(input: ProductSourceRecord, products?: Product[]): Promise<ProductSourceRecord> {
    const source = productSourceRecordSchema.parse(input);
    const availableProducts = products ?? readPublicContent(this.repositoryRoot).products;
    if (!availableProducts.some((product) => product.id === source.productId)) {
      throw new TypeError(`No existe el producto canónico "${source.productId}".`);
    }
    const records = validSourceRecords(this.repositoryRoot, availableProducts);
    const duplicate = findDuplicateProductSource(records, source);
    if (duplicate) {
      throw new TypeError(
        `El ID externo ${source.externalId} ya existe para ${source.provider} en ${source.marketplace} (${duplicate.id}).`,
      );
    }
    await atomicWriteJson(productSourcePath(this.repositoryRoot, source.id), source);
    return source;
  }
}
