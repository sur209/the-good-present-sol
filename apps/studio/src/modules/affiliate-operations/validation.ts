import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  guidePath,
  productDestination,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import type { AffiliateProgram, AffiliateProgramRecord } from "./programs.ts";

export type AffiliateFindingSeverity = "warning" | "error";
export type AffiliateCoverageKind = "affiliate" | "ordinary" | "none";

export interface AffiliateFinding {
  severity: AffiliateFindingSeverity;
  productId: string;
  product: string;
  guideId: string;
  guide: string;
  route: string;
  field: string;
  reason: string;
}

export interface AffiliateCoverageEntry {
  productId: string;
  product: string;
  guideId: string;
  guide: string;
  route: string;
  kind: AffiliateCoverageKind;
  destination?: string;
}

export interface AffiliateValidationOptions {
  siteDistRoot?: string;
}

export interface AffiliateValidationReport {
  coverage: AffiliateCoverageEntry[];
  findings: AffiliateFinding[];
  errors: AffiliateFinding[];
  warnings: AffiliateFinding[];
  renderedOutput: "checked" | "skipped";
}

const DEMO_HOSTS = new Set(["example.com", "www.example.com"]);
const SHORT_LINK_HOSTS = new Set(["a.co", "amzn.to", "bit.ly", "ow.ly", "t.co", "tinyurl.com"]);
const TRACKING_QUERY_KEYS = new Set([
  "affid",
  "affiliate_id",
  "affiliateid",
  "tag",
  "tracking_id",
  "tracking-id",
  "trackingid",
]);

interface FindingContext {
  productId: string;
  product: string;
  guideId: string;
  guide: string;
  route: string;
}

function hostToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function routeForGuide(
  guide: { clusterId: string; slug: string },
  clusters: ValidatedPublicContent["clusters"],
): string {
  const cluster = clusters.find((candidate) => candidate.id === guide.clusterId);
  if (!cluster) return "<unknown route>";
  try {
    return guidePath(cluster.slug, guide.slug);
  } catch {
    return "<unknown route>";
  }
}

function findingContext(
  guide: ValidatedPublicContent["guides"][number],
  recommendation: ValidatedPublicContent["guides"][number]["recommendations"][number],
  product: ValidatedPublicContent["products"][number] | undefined,
  route: string,
): FindingContext {
  return {
    productId: recommendation.productId,
    product: product?.name ?? "<missing product>",
    guideId: guide.id,
    guide: guide.title,
    route,
  };
}

function addFinding(
  findings: AffiliateFinding[],
  severity: AffiliateFindingSeverity,
  context: FindingContext,
  field: string,
  reason: string,
): void {
  findings.push({ severity, ...context, field, reason });
}

function inspectUrl(
  value: unknown,
  context: FindingContext,
  field: "productUrl" | "affiliateUrl",
  findings: AffiliateFinding[],
): URL | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    addFinding(findings, "error", context, field, "La URL almacenada no es una cadena no vacía.");
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    addFinding(findings, "error", context, field, "La URL almacenada no es válida.");
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addFinding(
      findings,
      "error",
      context,
      field,
      `La URL usa el protocolo inseguro "${url.protocol}"; sólo se permiten http y https.`,
    );
    return undefined;
  }

  return url;
}

function matchingPrograms(
  host: string,
  records: AffiliateProgramRecord[],
): Array<{ program: AffiliateProgram; approvedHost: boolean }> {
  return records.flatMap((record) => {
    if (!record.program || record.error) return [];
    const program = record.program;
    const marketplace = hostToken(program.marketplace);
    const approvedHosts = new Set(program.approvedHosts.map(hostToken).filter(Boolean));
    if (marketplace !== host && !approvedHosts.has(host)) return [];
    return [{ program, approvedHost: approvedHosts.has(host) }];
  });
}

function visibleTrackingIds(url: URL): string[] {
  return [...url.searchParams.entries()]
    .filter(([key, value]) => TRACKING_QUERY_KEYS.has(key.toLowerCase()) && value.trim())
    .map(([, value]) => value.trim());
}

function checkAffiliateUrl(
  url: URL,
  context: FindingContext,
  records: AffiliateProgramRecord[],
  findings: AffiliateFinding[],
): void {
  const host = hostToken(url.hostname) ?? "<unknown host>";
  const matches = matchingPrograms(host, records);
  const shortLink = SHORT_LINK_HOSTS.has(host);
  if (matches.length === 0) {
    addFinding(
      findings,
      "warning",
      context,
      "affiliateUrl.program",
      `No hay un programa afiliado local que reconozca el host "${host}".`,
    );
    if (!DEMO_HOSTS.has(host)) {
      addFinding(
        findings,
        "error",
        context,
        "affiliateUrl.host",
        `El host "${host}" no está aprobado por ningún programa afiliado configurado.`,
      );
    }
    if (shortLink) {
      addFinding(
        findings,
        "warning",
        context,
        "affiliateUrl.trackingId",
        "El enlace corto requiere revisión: sus parámetros finales de tracking no son visibles localmente.",
      );
    }
    return;
  }

  const match = matches[0]!;
  const program = match.program;
  if (!match.approvedHost) {
    addFinding(
      findings,
      "error",
      context,
      "affiliateUrl.host",
      `El host "${host}" coincide con el marketplace, pero no está en la lista de hosts aprobados de "${program.id}".`,
    );
  }
  if (!program.enabled) {
    addFinding(
      findings,
      "error",
      context,
      "affiliateUrl.program",
      `El programa afiliado "${program.id}" está desactivado.`,
    );
  }

  const trackingIds = visibleTrackingIds(url);
  if (shortLink) {
    addFinding(
      findings,
      "warning",
      context,
      "affiliateUrl.trackingId",
      "El enlace corto requiere revisión: sus parámetros finales de tracking no son visibles localmente.",
    );
  }

  if (trackingIds.length > 0) {
    if (program.allowedTrackingIds.length === 0) {
      addFinding(
        findings,
        "error",
        context,
        "affiliateUrl.trackingId",
        `La URL expone ${trackingIds.join(", ")}, pero el programa "${program.id}" no tiene tracking IDs aprobados configurados.`,
      );
    } else {
      const mismatches = trackingIds.filter(
        (trackingId) => !program.allowedTrackingIds.includes(trackingId),
      );
      if (mismatches.length > 0) {
        addFinding(
          findings,
          "error",
          context,
          "affiliateUrl.trackingId",
          `El tracking ID visible ${mismatches.join(", ")} no coincide con los IDs aprobados del programa "${program.id}".`,
        );
      }
    }
  } else if (!shortLink) {
    addFinding(
      findings,
      "warning",
      context,
      "affiliateUrl.trackingId",
      `La URL afiliada no expone un tracking ID verificable; los IDs finales no se reescriben automáticamente.`,
    );
  }
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function productCardHtml(html: string, product: string): string {
  let productIndex = html.indexOf(product);
  while (productIndex >= 0) {
    const start = html.lastIndexOf('<article class="recommendation', productIndex);
    if (start >= 0) {
      const end = html.indexOf("</article>", productIndex);
      if (end >= 0) return html.slice(start, end + "</article>".length);
    }
    productIndex = html.indexOf(product, productIndex + product.length);
  }
  return html;
}

function renderedGuideFile(siteDistRoot: string, route: string): string {
  const segments = route.split("/").filter(Boolean);
  return resolve(siteDistRoot, ...segments, "index.html");
}

function checkRenderedGuide(
  entries: AffiliateCoverageEntry[],
  siteDistRoot: string,
  findings: AffiliateFinding[],
): void {
  const first = entries[0];
  if (!first) return;
  const context = {
    productId: first.productId,
    product: first.product,
    guideId: first.guideId,
    guide: first.guide,
    route: first.route,
  };
  const file = renderedGuideFile(siteDistRoot, first.route);
  let html: string;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    addFinding(
      findings,
      "error",
      context,
      "route",
      `No se encontró la salida estática esperada en "${file}".`,
    );
    return;
  }

  const affiliateEntries = entries.filter((entry) => entry.kind === "affiliate");
  const hasDisclosure =
    html.includes('class="guide-disclosure') && html.includes("/affiliate-disclosure/");
  if (affiliateEntries.length > 0 && !hasDisclosure) {
    const commercial = affiliateEntries[0]!;
    addFinding(
      findings,
      "error",
      {
        productId: commercial.productId,
        product: commercial.product,
        guideId: commercial.guideId,
        guide: commercial.guide,
        route: commercial.route,
      },
      "guide-disclosure",
      "La página tiene un enlace afiliado, pero no renderiza el componente de disclosure esperado.",
    );
  } else if (affiliateEntries.length === 0 && hasDisclosure) {
    addFinding(
      findings,
      "error",
      context,
      "guide-disclosure",
      "La página renderiza un disclosure afiliado aunque no tiene enlaces afiliados.",
    );
  }

  for (const entry of entries) {
    if (!entry.destination) continue;
    const card = productCardHtml(html, entry.product);
    const href = `href="${htmlAttribute(entry.destination)}"`;
    if (!card.includes(href)) {
      addFinding(
        findings,
        "error",
        {
          productId: entry.productId,
          product: entry.product,
          guideId: entry.guideId,
          guide: entry.guide,
          route: entry.route,
        },
        entry.kind === "affiliate" ? "affiliateUrl" : "productUrl",
        `La CTA del producto no renderiza el destino esperado "${entry.destination}".`,
      );
      continue;
    }
    if (!card.includes('target="_blank"')) {
      addFinding(
        findings,
        "error",
        {
          productId: entry.productId,
          product: entry.product,
          guideId: entry.guideId,
          guide: entry.guide,
          route: entry.route,
        },
        entry.kind === "affiliate" ? "affiliateUrl" : "productUrl",
        "La CTA comercial no abre el destino en una pestaña nueva.",
      );
    }
    const expectedRel =
      entry.kind === "affiliate" ? "sponsored nofollow noopener" : "nofollow noopener";
    if (!card.includes(`rel="${expectedRel}"`)) {
      addFinding(
        findings,
        "error",
        {
          productId: entry.productId,
          product: entry.product,
          guideId: entry.guideId,
          guide: entry.guide,
          route: entry.route,
        },
        entry.kind === "affiliate" ? "affiliateUrl" : "productUrl",
        `La CTA no usa la relación esperada "${expectedRel}".`,
      );
    }
  }
}

export function validateAffiliateOperations(
  content: ValidatedPublicContent,
  programRecords: AffiliateProgramRecord[],
  options: AffiliateValidationOptions = {},
): AffiliateValidationReport {
  const coverage: AffiliateCoverageEntry[] = [];
  const findings: AffiliateFinding[] = [];
  const productsById = new Map(content.products.map((product) => [product.id, product]));
  const routesByGuideId = new Map(
    content.guides.map((guide) => [guide.id, routeForGuide(guide, content.clusters)]),
  );
  const renderedOutput =
    options.siteDistRoot && existsSync(options.siteDistRoot) ? "checked" : "skipped";

  for (const guide of content.guides) {
    const route = routesByGuideId.get(guide.id) ?? "<unknown route>";
    const guideEntries: AffiliateCoverageEntry[] = [];
    for (const recommendation of guide.recommendations) {
      const product = productsById.get(recommendation.productId);
      const context = findingContext(guide, recommendation, product, route);
      if (!product) {
        addFinding(
          findings,
          "error",
          context,
          "productId",
          `La recomendación referencia el producto publicado inexistente "${recommendation.productId}".`,
        );
        const missingEntry: AffiliateCoverageEntry = {
          ...context,
          kind: "none",
        };
        coverage.push(missingEntry);
        guideEntries.push(missingEntry);
        continue;
      }

      inspectUrl(product.productUrl, context, "productUrl", findings);
      const affiliateUrl = inspectUrl(product.affiliateUrl, context, "affiliateUrl", findings);
      const destination = productDestination(product);
      const affiliateIsDestination = Boolean(
        destination && affiliateUrl && product.affiliateUrl && destination === product.affiliateUrl,
      );
      const kind: AffiliateCoverageKind = affiliateIsDestination
        ? "affiliate"
        : destination
          ? "ordinary"
          : "none";
      const entry: AffiliateCoverageEntry = {
        ...context,
        kind,
        ...(destination ? { destination } : {}),
      };
      coverage.push(entry);
      guideEntries.push(entry);

      if (affiliateUrl) checkAffiliateUrl(affiliateUrl, context, programRecords, findings);
      if (kind === "ordinary" && !product.affiliateUrl && product.productUrl) {
        addFinding(
          findings,
          "warning",
          context,
          "productUrl",
          "Sólo hay una URL ordinaria; es una brecha de monetización, no un producto inválido.",
        );
      }
      if (kind === "none" && !product.productUrl && !product.affiliateUrl) {
        addFinding(
          findings,
          "warning",
          context,
          "productUrl/affiliateUrl",
          "No hay URL de salida; es una brecha de monetización y la recomendación sigue siendo válida editorialmente.",
        );
      }
    }

    if (renderedOutput === "checked")
      checkRenderedGuide(guideEntries, options.siteDistRoot!, findings);
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return { coverage, findings, errors, warnings, renderedOutput };
}

export function formatAffiliateValidationReport(report: AffiliateValidationReport): string {
  const counts = report.coverage.reduce(
    (result, entry) => {
      result[entry.kind] += 1;
      return result;
    },
    { affiliate: 0, ordinary: 0, none: 0 } as Record<AffiliateCoverageKind, number>,
  );
  const lines = [
    "Affiliate QA",
    `Coverage: ${counts.affiliate} affiliate, ${counts.ordinary} ordinary, ${counts.none} without outbound URL(s).`,
    `Findings: ${report.errors.length} error(s), ${report.warnings.length} warning(s).`,
    `Rendered CTA/disclosure output: ${report.renderedOutput}.`,
  ];
  if (report.findings.length === 0) lines.push("No findings.");
  else {
    lines.push(
      ...report.findings.map(
        (finding) =>
          `[${finding.severity.toUpperCase()}] product="${finding.productId}" (${finding.product}) :: guide="${finding.guideId}" (${finding.guide}) :: route=${finding.route} :: field=${finding.field} :: ${finding.reason}`,
      ),
    );
  }
  return lines.join("\n");
}
