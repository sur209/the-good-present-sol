import { safeHttpUrlSchema } from "@the-good-present/content-schema";
import { z } from "zod";

import { REPOSITORY_ROOT } from "../../repository.ts";
import {
  missingAffiliateProgramConfiguration,
  readAffiliateProgramRecords,
  type AffiliateProgram,
} from "./programs.ts";
import {
  createProductSourceId,
  findDuplicateAmazonAsin,
  findDuplicateNormalizedAffiliateUrl,
  productSourceRecordSchema,
  type ProductSourceRecord,
} from "../product-sources/records.ts";

export const AMAZON_US_AFFILIATE_PROGRAM_RECORD_ID = "amazon-us" as const;
export const AMAZON_US_PROGRAM_ID = "amazon-associates" as const;
export const AMAZON_US_MARKETPLACE = "amazon.com" as const;
export const AMAZON_US_APPROVED_HOSTS = [
  "amazon.com",
  "www.amazon.com",
  "smile.amazon.com",
  "amzn.to",
  "a.co",
] as const;

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const SHORT_LINK_HOSTS = new Set(["amzn.to", "a.co"]);
const amazonUrlFieldSchema = z.enum(["product", "affiliate"]);

export type AmazonUrlField = z.infer<typeof amazonUrlFieldSchema>;

export interface AmazonUrlInspection {
  field: AmazonUrlField;
  submittedUrl: string;
  normalizedUrl?: string;
  host?: string;
  asin?: string;
  visibleTrackingTags: string[];
  shortLink: boolean;
  errors: string[];
  warnings: string[];
}

export interface AmazonAffiliateIntakeInput {
  productUrl: string;
  affiliateUrl: string;
  trackingId: string;
  sourceId?: string;
}

export interface AmazonAffiliateIntakeValidation {
  product: AmazonUrlInspection;
  affiliate: AmazonUrlInspection;
  trackingId: string;
  asin?: string;
  normalizedProductUrl?: string;
  normalizedAffiliateUrl?: string;
  errors: string[];
  warnings: string[];
}

function normalizedHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isApprovedAmazonUsHost(value: string): boolean {
  const host = normalizedHost(value) ?? value.trim().toLowerCase();
  return (AMAZON_US_APPROVED_HOSTS as readonly string[]).includes(host);
}

export function normalizeAmazonUrl(value: string): string {
  const url = new URL(value.trim());
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === "https:" && url.port === "443") url.port = "";
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export function extractAmazonAsin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!safeHttpUrlSchema.safeParse(value.trim()).success) return undefined;
  if (!isApprovedAmazonUsHost(value)) return undefined;
  if (SHORT_LINK_HOSTS.has(url.hostname.toLowerCase())) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const pathMatch = path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:[/?]|$)/i);
  if (pathMatch?.[1] && ASIN_PATTERN.test(pathMatch[1].toUpperCase())) {
    return pathMatch[1].toUpperCase();
  }

  for (const [key, candidate] of url.searchParams) {
    if (key.toLowerCase() === "asin" && ASIN_PATTERN.test(candidate.toUpperCase())) {
      return candidate.toUpperCase();
    }
  }
  return undefined;
}

function visibleTrackingTags(url: URL): string[] {
  return [...url.searchParams.entries()]
    .filter(([key, value]) => key.toLowerCase() === "tag" && value.trim())
    .map(([, value]) => value.trim());
}

function inspectAmazonUrl(
  field: AmazonUrlField,
  submittedUrl: string,
  approvedHosts: readonly string[],
): AmazonUrlInspection {
  const trimmed = submittedUrl.trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  let url: URL | undefined;

  if (!trimmed) {
    errors.push("Falta la URL.");
  } else {
    try {
      url = new URL(trimmed);
    } catch {
      errors.push("La URL no es válida.");
    }
  }

  if (url && url.protocol !== "https:") errors.push("La URL debe usar https.");
  const host = url?.hostname.toLowerCase();
  if (host && !approvedHosts.map((item) => item.toLowerCase()).includes(host)) {
    errors.push(`El host no está aprobado para Amazon US: ${host}.`);
  }

  const shortLink = Boolean(host && SHORT_LINK_HOSTS.has(host));
  const tags = url ? visibleTrackingTags(url) : [];
  if (shortLink) {
    warnings.push("El enlace corto no permite inspeccionar localmente su destino ni su tag.");
  }

  const asin = url ? extractAmazonAsin(trimmed) : undefined;
  return {
    field,
    submittedUrl: trimmed,
    ...(url && errors.length === 0 ? { normalizedUrl: normalizeAmazonUrl(trimmed) } : {}),
    ...(host ? { host } : {}),
    ...(asin ? { asin } : {}),
    visibleTrackingTags: tags,
    shortLink,
    errors,
    warnings,
  };
}

function prefix(field: AmazonUrlField): string {
  return field === "product" ? "URL de producto" : "URL afiliada";
}

export function readAmazonUsAffiliateProgram(repositoryRoot = REPOSITORY_ROOT): AffiliateProgram {
  const record = readAffiliateProgramRecords(repositoryRoot).find(
    (candidate) => candidate.program?.id === AMAZON_US_AFFILIATE_PROGRAM_RECORD_ID,
  );
  if (!record) throw new TypeError("No existe el perfil de afiliados Amazon US.");
  if (record.error) throw new TypeError(`El perfil Amazon US es inválido: ${record.error}`);
  if (!record.program) throw new TypeError("El perfil Amazon US está vacío.");
  return record.program;
}

function configuredAmazonProgram(program: AffiliateProgram): string[] {
  const errors: string[] = [];
  if (program.programId !== AMAZON_US_PROGRAM_ID) {
    errors.push("El perfil no usa el programa Amazon Associates esperado.");
  }
  if (program.marketplace !== AMAZON_US_MARKETPLACE) {
    errors.push("El perfil no usa el marketplace Amazon US esperado.");
  }
  if (!program.enabled) errors.push("El perfil Amazon US está desactivado.");
  if (program.approvedHosts.length === 0) errors.push("El perfil no tiene hosts Amazon aprobados.");
  const unknownHosts = program.approvedHosts.filter(
    (host) => !(AMAZON_US_APPROVED_HOSTS as readonly string[]).includes(host.toLowerCase()),
  );
  if (unknownHosts.length) {
    errors.push(`El perfil contiene hosts Amazon no aprobados: ${unknownHosts.join(", ")}.`);
  }
  const missing = missingAffiliateProgramConfiguration(program);
  if (missing.length) errors.push(`Falta configuración del programa: ${missing.join(", ")}.`);
  return errors;
}

export function validateAmazonAffiliateIntake(
  input: AmazonAffiliateIntakeInput,
  program: AffiliateProgram,
  existingSources: ProductSourceRecord[] = [],
): AmazonAffiliateIntakeValidation {
  const trackingId = input.trackingId.trim();
  const approvedHosts = program.approvedHosts.filter((host) =>
    (AMAZON_US_APPROVED_HOSTS as readonly string[]).includes(host.toLowerCase()),
  );
  const product = inspectAmazonUrl("product", input.productUrl, approvedHosts);
  const affiliate = inspectAmazonUrl("affiliate", input.affiliateUrl, approvedHosts);
  const errors = configuredAmazonProgram(program);
  const warnings = [
    ...product.warnings.map((warning) => `${prefix("product")}: ${warning}`),
    ...affiliate.warnings.map((warning) => `${prefix("affiliate")}: ${warning}`),
  ];

  if (!trackingId || !program.allowedTrackingIds.includes(trackingId)) {
    errors.push("Seleccioná un tracking ID aprobado para el perfil Amazon US.");
  }
  errors.push(...product.errors.map((error) => `${prefix("product")}: ${error}`));
  errors.push(...affiliate.errors.map((error) => `${prefix("affiliate")}: ${error}`));

  if (affiliate.visibleTrackingTags.length === 0 && !affiliate.shortLink) {
    warnings.push("URL afiliada: no se ve ningún tracking tag; no se agregará automáticamente.");
  } else if (affiliate.visibleTrackingTags.some((tag) => tag !== trackingId)) {
    errors.push(
      `URL afiliada: el tracking tag visible no coincide con el seleccionado (${trackingId}).`,
    );
  }

  const asin = affiliate.asin ?? product.asin;
  if (product.asin && affiliate.asin && product.asin !== affiliate.asin) {
    errors.push("Las URLs pegadas tienen ASIN distintos.");
  }
  if (asin) {
    const duplicate = findDuplicateAmazonAsin(existingSources, asin, input.sourceId);
    if (duplicate) errors.push(`El ASIN ya está vinculado a la fuente ${duplicate.id}.`);
  }
  if (affiliate.normalizedUrl) {
    const duplicate = findDuplicateNormalizedAffiliateUrl(
      existingSources,
      affiliate.normalizedUrl,
      input.sourceId,
    );
    if (duplicate) errors.push(`La URL afiliada normalizada ya está guardada en ${duplicate.id}.`);
  }

  return {
    product,
    affiliate,
    trackingId,
    ...(asin ? { asin } : {}),
    ...(product.normalizedUrl ? { normalizedProductUrl: product.normalizedUrl } : {}),
    ...(affiliate.normalizedUrl ? { normalizedAffiliateUrl: affiliate.normalizedUrl } : {}),
    errors,
    warnings,
  };
}

export function createAmazonProductSourceRecord(
  productId: string,
  input: AmazonAffiliateIntakeInput,
  validation: AmazonAffiliateIntakeValidation,
  importedAt = new Date().toISOString(),
): ProductSourceRecord {
  if (validation.errors.length || !validation.normalizedAffiliateUrl) {
    throw new TypeError("No se puede guardar un intake Amazon inválido.");
  }
  return productSourceRecordSchema.parse({
    id: input.sourceId ?? createProductSourceId(),
    productId,
    sourceKind: "manual-amazon",
    provider: "Amazon Associates",
    marketplace: AMAZON_US_MARKETPLACE,
    ...(validation.asin ? { externalId: validation.asin } : {}),
    sourceUrl: input.productUrl.trim(),
    importMethod: "manual",
    importedAt,
    sourceStatus: "active",
    originalProductUrl: input.productUrl.trim(),
    originalAffiliateUrl: input.affiliateUrl.trim(),
    normalizedAffiliateUrl: validation.normalizedAffiliateUrl,
    trackingId: validation.trackingId,
  });
}
