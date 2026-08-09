import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PUBLIC_CONTENT_DIRECTORIES,
  PUBLIC_SCHEMA_VERSION,
  productSchema,
  safeHttpUrlSchema,
  type Product,
} from "@the-good-present/content-schema";
import { z } from "zod";

import {
  createAmazonProductSourceRecord,
  extractAmazonAsin,
  isApprovedAmazonUsHost,
  normalizeAmazonUrl,
  readAmazonUsAffiliateProgram,
  validateAmazonAffiliateIntake,
} from "../affiliate-operations/amazon.ts";
import {
  createProductSourceId,
  findDuplicateAmazonAsin,
  productSourcePath,
  productSourceRecordSchema,
  ProductSourceStore,
  type ProductSourceRecord,
} from "../product-sources/records.ts";
import { createProductId } from "../../product-catalog.ts";
import {
  REPOSITORY_ROOT,
  assertPublicContentCandidate,
  atomicWriteJson,
  readPublicContent,
  replaceSourceRecord,
} from "../../repository.ts";
import { readPublicContentSources } from "../../../../../scripts/content-files.ts";

const nonEmptyText = z.string().trim().min(1);
const optionalHttpUrl = z.string().trim().min(1).pipe(safeHttpUrlSchema).optional();
const safeId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Must use a safe lowercase ID.");
const asinSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{10}$/i, "Must be a probable Amazon ASIN.");

export const manualProductIntakeInputSchema = z.strictObject({
  productUrl: optionalHttpUrl,
  affiliateUrl: optionalHttpUrl,
  asin: asinSchema.optional(),
  trackingId: nonEmptyText.optional(),
  name: nonEmptyText,
  brand: nonEmptyText.optional(),
  merchant: nonEmptyText,
  shortDescription: nonEmptyText,
  sourceFacts: z.array(nonEmptyText).default([]),
  verifiedFacts: z.array(nonEmptyText).default([]),
  verifiedFactsConfirmed: z.boolean().default(false),
  priceLabel: nonEmptyText.optional(),
  categories: z.array(nonEmptyText).optional(),
  interests: z.array(nonEmptyText).optional(),
  recipients: z.array(nonEmptyText).optional(),
  occasions: z.array(nonEmptyText).optional(),
  image: nonEmptyText.optional(),
  imageAlt: nonEmptyText.optional(),
  imageRightsNotes: nonEmptyText.optional(),
  provenanceNotes: nonEmptyText.optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  productId: safeId.optional(),
  sourceId: safeId.optional(),
  importedAt: z.iso.datetime({ offset: true }).optional(),
});

export type ManualProductIntakeInput = z.infer<typeof manualProductIntakeInputSchema>;

export interface ProductIntakeDuplicate {
  kind: "asin" | "canonical-product";
  productId: string;
  sourceId?: string;
  reason: string;
}

export interface ManualProductIntakePreview {
  input: ManualProductIntakeInput;
  product?: Product;
  source?: ProductSourceRecord;
  duplicates: ProductIntakeDuplicate[];
  errors: string[];
  warnings: string[];
}

export type ProductIntakeJsonWriter = (file: string, data: unknown) => Promise<void>;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

function comparableText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function productIdentity(product: Product): string {
  return [product.name, product.brand, product.merchant].map(comparableText).join("\u0000");
}

function normalizedAmazonUrl(value: string | undefined): string | undefined {
  if (!value || !isApprovedAmazonUsHost(value)) return undefined;
  try {
    return normalizeAmazonUrl(value);
  } catch {
    return undefined;
  }
}

function duplicateKey(duplicate: ProductIntakeDuplicate): string {
  return [duplicate.kind, duplicate.productId, duplicate.sourceId ?? "", duplicate.reason].join(
    "\u0000",
  );
}

function addDuplicate(
  duplicates: ProductIntakeDuplicate[],
  duplicate: ProductIntakeDuplicate,
): void {
  if (!duplicates.some((item) => duplicateKey(item) === duplicateKey(duplicate))) {
    duplicates.push(duplicate);
  }
}

function duplicateErrors(duplicates: ProductIntakeDuplicate[]): string[] {
  return duplicates.map((duplicate) =>
    duplicate.kind === "asin"
      ? `El ASIN ya está vinculado al producto ${duplicate.productId} en la fuente ${duplicate.sourceId ?? "existente"}.`
      : `El producto parece duplicar el registro canónico ${duplicate.productId}: ${duplicate.reason}`,
  );
}

function sourceForAsin(
  sources: ProductSourceRecord[],
  asin: string,
  sourceId: string,
): ProductSourceRecord | undefined {
  return (
    findDuplicateAmazonAsin(sources, asin, sourceId) ??
    sources.find(
      (source) =>
        source.id !== sourceId &&
        source.externalId?.toUpperCase() === asin &&
        source.marketplace?.toLocaleLowerCase("en-US") === "amazon.com",
    )
  );
}

function exactPriceLabel(value: string | undefined): boolean {
  return Boolean(
    value && /^(?:[$€£]\s*)?\d+(?:[.,]\d{2})?\s*(?:usd|eur|gbp)?$/i.test(value.trim()),
  );
}

function factKey(value: string): string {
  return comparableText(value);
}

function currentDuplicates(
  products: Product[],
  sources: ProductSourceRecord[],
  product: Product,
  source: ProductSourceRecord,
): ProductIntakeDuplicate[] {
  const duplicates: ProductIntakeDuplicate[] = [];
  const asin = source.externalId?.toUpperCase();
  if (asin) {
    const existingSource = sourceForAsin(sources, asin, source.id);
    if (existingSource) {
      addDuplicate(duplicates, {
        kind: "asin",
        productId: existingSource.productId,
        sourceId: existingSource.id,
        reason: `ASIN ${asin}`,
      });
    }
  }

  const productUrl = normalizedAmazonUrl(product.productUrl);
  const affiliateUrl = normalizedAmazonUrl(product.affiliateUrl);
  const identity = productIdentity(product);
  for (const existing of products) {
    if (existing.id === product.id) continue;
    const existingProductUrl = normalizedAmazonUrl(existing.productUrl);
    const existingAffiliateUrl = normalizedAmazonUrl(existing.affiliateUrl);
    if (productUrl && productUrl === existingProductUrl) {
      addDuplicate(duplicates, {
        kind: "canonical-product",
        productId: existing.id,
        reason: "la URL de producto Amazon ya existe",
      });
    }
    if (affiliateUrl && affiliateUrl === existingAffiliateUrl) {
      addDuplicate(duplicates, {
        kind: "canonical-product",
        productId: existing.id,
        reason: "la URL afiliada ya existe",
      });
    }
    if (identity === productIdentity(existing)) {
      addDuplicate(duplicates, {
        kind: "canonical-product",
        productId: existing.id,
        reason: "coinciden nombre, marca y comercio",
      });
    }
  }
  return duplicates;
}

function normalizeInput(input: ManualProductIntakeInput): ManualProductIntakeInput {
  return {
    ...input,
    ...(input.asin ? { asin: input.asin.toUpperCase() } : {}),
    productId: input.productId ?? createProductId(),
    sourceId: input.sourceId ?? createProductSourceId(),
    importedAt: input.importedAt ?? new Date().toISOString(),
    sourceFacts: input.sourceFacts ?? [],
    verifiedFacts: input.verifiedFacts ?? [],
  };
}

function sourceFields(
  input: ManualProductIntakeInput,
  product: Product,
  asin: string,
): Record<string, unknown> {
  return {
    sourceFacts: input.sourceFacts.length ? input.sourceFacts : undefined,
    imageRightsNotes: input.imageRightsNotes,
    notes: input.provenanceNotes,
    ...(product.productUrl
      ? { sourceUrl: product.productUrl, originalProductUrl: input.productUrl }
      : {}),
    externalId: asin,
    marketplace: "amazon.com",
    importMethod: "manual",
    importedAt: input.importedAt,
    sourceStatus: "active",
  };
}

function sourceFromInput(
  input: ManualProductIntakeInput,
  product: Product,
  asin: string,
  affiliateValidation: ReturnType<typeof validateAmazonAffiliateIntake> | undefined,
): ProductSourceRecord | undefined {
  if (input.affiliateUrl) {
    if (
      !affiliateValidation ||
      affiliateValidation.errors.length ||
      !affiliateValidation.normalizedAffiliateUrl
    ) {
      return undefined;
    }
    return productSourceRecordSchema.parse({
      ...createAmazonProductSourceRecord(
        product.id,
        {
          productUrl: input.productUrl!,
          affiliateUrl: input.affiliateUrl,
          trackingId: input.trackingId!,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
        affiliateValidation,
        input.importedAt,
      ),
      ...sourceFields(input, product, asin),
    });
  }

  return productSourceRecordSchema.parse({
    id: input.sourceId,
    productId: product.id,
    sourceKind: "manual",
    provider: "Amazon",
    ...sourceFields(input, product, asin),
  });
}

function publicCandidateIsValid(repositoryRoot: string, product: Product): void {
  const sources = readPublicContentSources(repositoryRoot);
  replaceSourceRecord(
    sources.products,
    `${PUBLIC_CONTENT_DIRECTORIES.products}/${product.id}.json`,
    product,
  );
  assertPublicContentCandidate(sources, "El producto dejaría inválido el contenido publicado.");
}

export function prepareManualProductIntake(
  rawInput: ManualProductIntakeInput,
  repositoryRoot = REPOSITORY_ROOT,
): ManualProductIntakePreview {
  const candidate = normalizeInput(rawInput);
  const parsed = manualProductIntakeInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      input: candidate,
      duplicates: [],
      errors: [validationMessage(parsed.error)],
      warnings: [],
    };
  }

  const input = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicates: ProductIntakeDuplicate[] = [];
  const content = readPublicContent(repositoryRoot);
  const sources = new ProductSourceStore(repositoryRoot).list(content.products);
  let normalizedProductUrl: string | undefined;
  let normalizedAffiliateUrl: string | undefined;
  let affiliateValidation: ReturnType<typeof validateAmazonAffiliateIntake> | undefined;
  let asin = input.asin;

  if (!input.productUrl && !asin) {
    errors.push("Ingresá la URL de producto Amazon o el ASIN.");
  }
  if (input.productUrl) {
    if (!isApprovedAmazonUsHost(input.productUrl)) {
      errors.push("La URL de producto debe usar un host Amazon US aprobado.");
    } else {
      normalizedProductUrl = normalizeAmazonUrl(input.productUrl);
      const urlAsin = extractAmazonAsin(input.productUrl);
      if (urlAsin && asin && urlAsin !== asin) {
        errors.push("El ASIN ingresado no coincide con el ASIN visible en la URL de producto.");
      }
      asin ??= urlAsin;
      if (!asin) {
        errors.push(
          "Ingresá el ASIN cuando la URL de producto no permite identificarlo localmente.",
        );
      }
    }
  }

  if (input.affiliateUrl) {
    if (!input.productUrl) errors.push("La URL afiliada requiere una URL de producto Amazon.");
    if (!input.trackingId) errors.push("La URL afiliada requiere el tracking ID verificado.");
    if (input.productUrl && input.trackingId) {
      try {
        affiliateValidation = validateAmazonAffiliateIntake(
          {
            productUrl: input.productUrl,
            affiliateUrl: input.affiliateUrl,
            trackingId: input.trackingId,
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          },
          readAmazonUsAffiliateProgram(repositoryRoot),
          sources,
        );
        errors.push(...affiliateValidation.errors);
        warnings.push(...affiliateValidation.warnings);
        normalizedAffiliateUrl = affiliateValidation.normalizedAffiliateUrl;
        if (affiliateValidation.asin && asin && affiliateValidation.asin !== asin) {
          errors.push("Las URLs Amazon y el ASIN ingresado no coinciden.");
        }
        asin ??= affiliateValidation.asin;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (input.trackingId) {
    errors.push("El tracking ID sólo se usa junto con una URL afiliada.");
  }

  if (asin) {
    const existingSource = sourceForAsin(sources, asin, input.sourceId!);
    if (existingSource) {
      addDuplicate(duplicates, {
        kind: "asin",
        productId: existingSource.productId,
        sourceId: existingSource.id,
        reason: `ASIN ${asin}`,
      });
    }
  }

  if (input.verifiedFacts.length) {
    if (!input.verifiedFactsConfirmed) {
      errors.push(
        "Afirmá que cada dato verificado está respaldado por la información de la fuente.",
      );
    }
    const sourceFactKeys = new Set(input.sourceFacts.map(factKey));
    for (const fact of input.verifiedFacts) {
      if (!sourceFactKeys.has(factKey(fact))) {
        errors.push(`El dato verificado no aparece en los hechos ingresados de la fuente: ${fact}`);
      }
    }
  }
  if (exactPriceLabel(input.priceLabel)) {
    errors.push("Usá una etiqueta o rango duradero; no se guarda un precio actual exacto.");
  }
  if (input.image && !input.imageRightsNotes) {
    errors.push("La referencia de imagen requiere notas de derechos o procedencia.");
  }
  if (!input.affiliateUrl) {
    warnings.push(
      "No se guarda una URL afiliada automáticamente; el enlace sigue bajo control del editor.",
    );
  }
  if (input.priceLabel) {
    warnings.push(
      "priceLabel se guarda como etiqueta editorial, no como precio ni disponibilidad dinámica.",
    );
  }

  const productData = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    id: input.productId!,
    name: input.name,
    ...(input.brand ? { brand: input.brand } : {}),
    merchant: input.merchant,
    ...(normalizedProductUrl ? { productUrl: normalizedProductUrl } : {}),
    ...(normalizedAffiliateUrl ? { affiliateUrl: normalizedAffiliateUrl } : {}),
    shortDescription: input.shortDescription,
    ...(input.verifiedFacts.length ? { verifiedFacts: input.verifiedFacts } : {}),
    ...(input.priceLabel ? { priceLabel: input.priceLabel } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.imageAlt ? { imageAlt: input.imageAlt } : {}),
    ...(input.categories?.length ? { categories: input.categories } : {}),
    ...(input.interests?.length ? { interests: input.interests } : {}),
    ...(input.recipients?.length ? { recipients: input.recipients } : {}),
    ...(input.occasions?.length ? { occasions: input.occasions } : {}),
    status: input.status,
  };

  let product: Product | undefined;
  if (asin) {
    try {
      product = productSchema.parse(productData);
      if (content.products.some((existing) => existing.id === product!.id)) {
        errors.push(`El ID de producto ${product.id} ya existe.`);
      }
      const candidateDuplicates = currentDuplicates(content.products, sources, product, {
        id: input.sourceId!,
        productId: product.id,
        sourceKind: input.affiliateUrl ? "manual-amazon" : "manual",
        provider: input.affiliateUrl ? "Amazon Associates" : "Amazon",
        marketplace: "amazon.com",
        externalId: asin,
        importMethod: "manual",
        importedAt: input.importedAt!,
        sourceStatus: "active",
      });
      for (const duplicate of candidateDuplicates) addDuplicate(duplicates, duplicate);
      errors.push(...duplicateErrors(duplicates));
      publicCandidateIsValid(repositoryRoot, product);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let source: ProductSourceRecord | undefined;
  if (product && asin) {
    try {
      const nextSource = sourceFromInput(input, product, asin, affiliateValidation);
      if (!nextSource) {
        errors.push("No se pudo construir un registro de fuente válido para la URL afiliada.");
      } else {
        source = nextSource;
        if (sources.some((existing) => existing.id === nextSource.id)) {
          errors.push(`El ID de fuente ${nextSource.id} ya existe.`);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    input,
    ...(product ? { product } : {}),
    ...(source ? { source } : {}),
    duplicates,
    errors,
    warnings,
  };
}

async function snapshot(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function restore(file: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) {
    await rm(file, { force: true });
    return;
  }
  await atomicWriteJson(file, JSON.parse(contents));
}

export async function commitManualProductIntake(
  preview: ManualProductIntakePreview,
  repositoryRoot = REPOSITORY_ROOT,
  writeJson: ProductIntakeJsonWriter = atomicWriteJson,
): Promise<{ product: Product; source: ProductSourceRecord }> {
  if (preview.errors.length || !preview.product || !preview.source) {
    throw new TypeError("No se puede guardar un intake de producto inválido.");
  }

  const content = readPublicContent(repositoryRoot);
  const sources = new ProductSourceStore(repositoryRoot).list(content.products);
  if (content.products.some((product) => product.id === preview.product!.id)) {
    throw new TypeError(`El ID de producto ${preview.product.id} ya existe.`);
  }
  if (sources.some((source) => source.id === preview.source!.id)) {
    throw new TypeError(`El ID de fuente ${preview.source.id} ya existe.`);
  }
  const duplicates = currentDuplicates(content.products, sources, preview.product, preview.source);
  if (duplicates.length) {
    throw new TypeError(duplicateErrors(duplicates).join("\n"));
  }

  const productFile = resolve(
    repositoryRoot,
    PUBLIC_CONTENT_DIRECTORIES.products,
    `${preview.product.id}.json`,
  );
  const sourceFile = productSourcePath(repositoryRoot, preview.source.id);
  const previousProduct = await snapshot(productFile);
  const previousSource = await snapshot(sourceFile);

  try {
    await writeJson(productFile, preview.product);
    await writeJson(sourceFile, preview.source);
  } catch (error) {
    try {
      await restore(sourceFile, previousSource);
      await restore(productFile, previousProduct);
    } catch (rollbackError) {
      throw new Error(
        `Falló el intake y también falló el rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }

  return { product: preview.product, source: preview.source };
}
