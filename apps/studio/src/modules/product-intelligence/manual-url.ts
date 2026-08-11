import { safeHttpUrlSchema } from "@the-good-present/content-schema";

import {
  amazonProductUrlForAsin,
  extractAmazonAsin,
  inspectAmazonUrl,
  isApprovedAmazonUsHost,
  normalizeAmazonUrl,
  readAmazonUsAffiliateProgram,
  validateAmazonAffiliateIntake,
} from "../affiliate-operations/amazon.ts";
import type { ProductSourceCandidateInput } from "./sourcing.ts";

export interface ManualProductUrlInput {
  url?: string;
  productUrl?: string;
  affiliateUrl?: string;
  trackingId?: string;
}

export interface ManualProductUrlResolution {
  sourceUrl: string;
  productUrl?: string;
  affiliateUrl?: string;
  originalProductUrl?: string;
  originalAffiliateUrl?: string;
  asin?: string;
  trackingId?: string;
  provider: string;
  marketplace?: string;
  warnings: string[];
  errors: string[];
}

function normalizedGenericUrl(value: string): string | undefined {
  if (!safeHttpUrlSchema.safeParse(value).success) return undefined;
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function addUnique(values: string[], additions: readonly string[]): void {
  for (const addition of additions)
    if (addition && !values.includes(addition)) values.push(addition);
}

function inspectGenericUrl(value: string, label: string, errors: string[]): string | undefined {
  const normalized = normalizedGenericUrl(value);
  if (!normalized) errors.push(`${label}: la URL debe ser HTTP(S) y absoluta.`);
  return normalized;
}

export function inspectManualProductUrl(
  rawInput: ManualProductUrlInput,
  repositoryRoot?: string,
): ManualProductUrlResolution {
  const rawUrl = rawInput.url?.trim();
  const rawProductUrl = rawInput.productUrl?.trim();
  const rawAffiliateUrl = rawInput.affiliateUrl?.trim();
  const primary = rawUrl || rawProductUrl || rawAffiliateUrl || "";
  const warnings: string[] = [];
  const errors: string[] = [];
  let productUrl: string | undefined;
  let affiliateUrl: string | undefined;
  let asin: string | undefined;
  let trackingId = rawInput.trackingId?.trim() || undefined;
  let amazonProduct = false;
  let amazonAffiliate = false;

  if (!primary) errors.push("Pegá una URL de producto o afiliado.");

  if (rawProductUrl) {
    amazonProduct = isApprovedAmazonUsHost(rawProductUrl);
    if (amazonProduct) {
      const inspection = inspectAmazonUrl("product", rawProductUrl);
      addUnique(
        errors,
        inspection.errors.map((error) => `URL de producto: ${error}`),
      );
      addUnique(
        warnings,
        inspection.warnings.map((warning) => `URL de producto: ${warning}`),
      );
      productUrl = inspection.normalizedUrl;
      asin = inspection.asin;
    } else {
      productUrl = inspectGenericUrl(rawProductUrl, "URL de producto", errors);
    }
  }

  if (rawAffiliateUrl) {
    amazonAffiliate = isApprovedAmazonUsHost(rawAffiliateUrl);
    if (amazonAffiliate) {
      const inspection = inspectAmazonUrl("affiliate", rawAffiliateUrl);
      addUnique(
        errors,
        inspection.errors.map((error) => `URL afiliada: ${error}`),
      );
      addUnique(
        warnings,
        inspection.warnings.map((warning) => `URL afiliada: ${warning}`),
      );
      affiliateUrl = inspection.normalizedUrl;
      if (inspection.asin && asin && inspection.asin !== asin) {
        errors.push("Las URLs Amazon tienen ASIN distintos.");
      }
      asin ??= inspection.asin;
      if (!inspection.visibleTrackingTags.length && !inspection.shortLink) {
        warnings.push("URL afiliada: no se ve ningún tracking tag; confirmalo en P.1.");
      }
      trackingId ??= inspection.visibleTrackingTags[0];
    } else {
      affiliateUrl = inspectGenericUrl(rawAffiliateUrl, "URL afiliada", errors);
    }
  }

  if (rawUrl) {
    if (isApprovedAmazonUsHost(rawUrl)) {
      const inspection = inspectAmazonUrl(
        trackingId || inspectionHasTrackingTag(rawUrl) ? "affiliate" : "product",
        rawUrl,
      );
      addUnique(
        errors,
        inspection.errors.map((error) => `URL pegada: ${error}`),
      );
      addUnique(
        warnings,
        inspection.warnings.map((warning) => `URL pegada: ${warning}`),
      );
      const pastedIsAffiliate =
        inspection.field === "affiliate" ||
        Boolean(rawInput.trackingId) ||
        inspection.visibleTrackingTags.length > 0;
      if (pastedIsAffiliate) {
        amazonAffiliate = true;
        affiliateUrl = inspection.normalizedUrl;
        if (inspection.asin && asin && inspection.asin !== asin) {
          errors.push("Las URLs Amazon tienen ASIN distintos.");
        }
        asin ??= inspection.asin;
        if (!inspection.visibleTrackingTags.length && !inspection.shortLink) {
          warnings.push("URL afiliada: no se ve ningún tracking tag; confirmalo en P.1.");
        }
        trackingId ??= inspection.visibleTrackingTags[0];
      } else {
        amazonProduct = true;
        productUrl = inspection.normalizedUrl;
        asin ??= inspection.asin;
      }
    } else {
      productUrl = inspectGenericUrl(rawUrl, "URL pegada", errors);
    }
  }

  if (amazonAffiliate && asin && !productUrl) {
    productUrl = amazonProductUrlForAsin(asin);
  }
  if (amazonProduct && !asin) {
    warnings.push("La URL Amazon no permite identificar un ASIN localmente; completalo en P.1.");
  }
  if (amazonProduct && affiliateUrl && !amazonAffiliate) {
    errors.push("Un producto Amazon no puede usar un destino afiliado no Amazon.");
  }
  if (amazonAffiliate && productUrl && !isApprovedAmazonUsHost(productUrl)) {
    errors.push("Una URL afiliada Amazon requiere una URL de producto Amazon.");
  }
  if (affiliateUrl && !amazonAffiliate && trackingId) {
    warnings.push("El tracking ID sólo aplica a URLs afiliadas Amazon.");
  }

  if (amazonAffiliate && productUrl && affiliateUrl && trackingId && repositoryRoot) {
    try {
      const validation = validateAmazonAffiliateIntake(
        { productUrl, affiliateUrl, trackingId },
        readAmazonUsAffiliateProgram(repositoryRoot),
      );
      addUnique(errors, validation.errors);
      addUnique(warnings, validation.warnings);
      asin ??= validation.asin;
    } catch (error) {
      warnings.push(
        `La validación completa de afiliados queda pendiente en P.1: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (amazonAffiliate && !trackingId) {
    warnings.push("Falta un tracking ID verificado; P.1 lo pedirá antes de guardar.");
  }

  return {
    sourceUrl: primary,
    ...(productUrl ? { productUrl } : {}),
    ...(affiliateUrl ? { affiliateUrl } : {}),
    ...(rawProductUrl
      ? { originalProductUrl: rawProductUrl }
      : rawUrl && productUrl && !amazonAffiliate
        ? { originalProductUrl: rawUrl }
        : {}),
    ...(rawAffiliateUrl
      ? { originalAffiliateUrl: rawAffiliateUrl }
      : rawUrl && affiliateUrl && amazonAffiliate
        ? { originalAffiliateUrl: rawUrl }
        : {}),
    ...(asin ? { asin } : {}),
    ...(trackingId ? { trackingId } : {}),
    provider: amazonAffiliate ? "Amazon Associates" : amazonProduct ? "Amazon" : "Manual",
    ...(amazonAffiliate || amazonProduct ? { marketplace: "amazon.com" } : {}),
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

function inspectionHasTrackingTag(value: string): boolean {
  try {
    return [...new URL(value).searchParams.keys()].some((key) => key.toLowerCase() === "tag");
  } catch {
    return false;
  }
}

export function manualUrlCandidateInput(
  resolution: ManualProductUrlResolution,
): ProductSourceCandidateInput {
  return {
    sourceKind: "manual",
    provider: resolution.provider,
    ...(resolution.marketplace ? { marketplace: resolution.marketplace } : {}),
    ...(resolution.asin ? { externalId: resolution.asin } : {}),
    sourceUrl: resolution.sourceUrl,
    ...(resolution.productUrl ? { productUrl: resolution.productUrl } : {}),
    ...(resolution.affiliateUrl ? { affiliateUrl: resolution.affiliateUrl } : {}),
    ...(resolution.originalProductUrl ? { originalProductUrl: resolution.originalProductUrl } : {}),
    ...(resolution.originalAffiliateUrl
      ? { originalAffiliateUrl: resolution.originalAffiliateUrl }
      : {}),
    ...(resolution.trackingId ? { trackingId: resolution.trackingId } : {}),
    ...(resolution.warnings.length ? { urlWarnings: resolution.warnings } : {}),
    name: `Pasted ${resolution.provider} URL`,
    sourceFacts: [],
  };
}
