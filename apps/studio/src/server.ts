import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRIMARY_AXES,
  PUBLIC_SCHEMA_VERSION,
  clusterPath,
  guidePath,
  isAmazonProduct,
  productDestination,
  type PrimaryAxis,
  type Product,
} from "@the-good-present/content-schema";

import {
  MockGuideGenerationProvider,
  ProviderError,
  createGuideGenerationProvider,
  type GuideGenerationProvider,
} from "./ai-provider.ts";
import { DraftStore } from "./draft-store.ts";
import {
  addGuideToGroup,
  addNavigationGroup,
  moveGuideInGroup,
  moveNavigationGroup,
  removeGuideFromGroup,
  removeNavigationGroup,
  reopenClusterDraft,
  validateClusterDraft,
} from "./cluster-editor.ts";
import {
  MAX_GIFT_COUNT,
  MIN_GIFT_COUNT,
  clusterDraftSchema,
  createClusterDraft,
  createGuideDraft,
  guideDraftSchema,
  type ClusterDraft,
  type EditorialDraft,
  type GuideDraft,
} from "./drafts.ts";
import {
  addManualRecommendation,
  clearRecommendationProduct,
  duplicateProductIds,
  generateFinalGuide,
  generateGuideOutline,
  moveRecommendation,
  normalizeQuestionnaire,
  regenerateRecommendation,
  removeRecommendation,
  reopenGuideDraft,
  selectRecommendationProduct,
  updateGuideEditorialCopy,
  updateRecommendationEditorialCopy,
  validateGuideDraft,
} from "./guide-editor.ts";
import { FINAL_PROMPT_VERSION, prepareFinalPrompt } from "./final-prompt.ts";
import { prepareOutlinePrompt } from "./outline-prompt.ts";
import {
  ProductCatalog,
  createProductId,
  matchProducts,
  productSlotMatchScore,
  productUsage,
  suggestProductsForSlot,
  validateProductUrl,
  type ProductStatusFilter,
} from "./product-catalog.ts";
import { Publisher, type PublicationResult } from "./publication.ts";
import {
  RECOMMENDATION_PROMPT_VERSION,
  prepareRecommendationPrompt,
} from "./recommendation-prompt.ts";
import {
  missingAffiliateProgramConfiguration,
  readAffiliateProgramRecords,
} from "./modules/affiliate-operations/programs.ts";
import { validateAffiliateOperations } from "./modules/affiliate-operations/validation.ts";
import {
  createAmazonProductSourceRecord,
  isApprovedAmazonUsHost,
  readAmazonUsAffiliateProgram,
  validateAmazonAffiliateIntake,
  type AmazonAffiliateIntakeValidation,
} from "./modules/affiliate-operations/amazon.ts";
import {
  PRODUCT_SOURCE_IMPORT_METHODS,
  PRODUCT_SOURCE_KINDS,
  PRODUCT_SOURCE_STATUSES,
  ProductSourceStore,
  createProductSourceId,
  productSourceRecordSchema,
  type ProductSourceRecord,
} from "./modules/product-sources/records.ts";
import {
  DEFAULT_PRODUCT_DISCOVERY_LIMITS,
  createProductDiscoverySource,
  generateProductSearchPlans,
  runProductDiscovery,
  type ProductDiscoverySource,
} from "./modules/product-sources/discovery.ts";
import {
  commitManualProductIntake,
  prepareManualProductIntake,
  type ManualProductIntakeInput,
  type ManualProductIntakePreview,
} from "./modules/product-intelligence/intake.ts";
import {
  analyzeProductCoverage,
  type GuideEvidence,
  type ProductCoverageAnalysis,
  type ProductEvidence,
} from "./modules/product-intelligence/coverage.ts";
import {
  inspectManualProductUrl,
  manualUrlCandidateInput,
  type ManualProductUrlResolution,
} from "./modules/product-intelligence/manual-url.ts";
import { readProductGapReports } from "./modules/product-intelligence/gaps.ts";
import {
  PRODUCT_SOURCING_REQUEST_STATUSES,
  ProductSourcingRequestStore,
  addProductSourceCandidates,
  assertProductSourcingOrigin,
  assignSourcedProductToDraftSlot,
  catalogMatchesForRequest,
  createProductSourcingRequest,
  createProductSourcingRequestForDraftSlot,
  findProductSourcingRequestForDraftSlot,
  linkProductSourceCandidate,
  productRequirementOriginSchema,
  productSourcingPrefillForDraftSlot,
  productSourcingReturnPath,
  reviewProductSourceCandidates,
  selectCanonicalProductForRequest,
  transitionProductSourcingRequest,
  type ProductRequirementOrigin,
  type ProductSourceCandidate,
  type ProductSourcingRequest,
  type ProductSourcingRequestInput,
  type ProductSourcingRequestStatus,
} from "./modules/product-intelligence/sourcing.ts";
import {
  CANDIDATE_DECISIONS,
  CANDIDATE_STATUSES,
  OPPORTUNITY_SESSION_MODES,
  ArticleCandidateStore,
  applyCandidateDecision,
  candidateStatusTransitions,
  transitionArticleCandidate,
  type ArticleCandidate,
  type CandidateStatus,
} from "./modules/content-opportunity-lab/candidates.ts";
import {
  OPPORTUNITY_SIGNAL_KINDS,
  compareArticleCandidate,
  type ApprovedEditorialBriefComparisonRecord,
  type OpportunityComparison,
  type OpportunityComparisonReport,
  type OpportunityComparisonTargetKind,
  type OpportunitySignalKind,
} from "./modules/content-opportunity-lab/comparison.ts";
import {
  DEFAULT_OPPORTUNITY_CANDIDATE_COUNT,
  MAX_OPPORTUNITY_CANDIDATE_COUNT,
  OPPORTUNITY_GENERATION_PROMPT_VERSION,
  OPPORTUNITY_SESSION_OBJECTIVES,
  generateDivergentOpportunities,
  opportunityCatalogCategories,
  opportunityCoverageSignals,
} from "./modules/content-opportunity-lab/generation.ts";
import {
  OPPORTUNITY_EVALUATION_PROMPT_VERSION,
  OpportunityEvaluationStore,
  evaluateConvergentOpportunities,
  type OpportunityEvaluationSession,
} from "./modules/content-opportunity-lab/evaluation.ts";
import {
  EditorialBriefStore,
  approveCandidateForBrief,
  approveEditorialBrief,
  convertApprovedBriefToGuideDraft,
  editorialBriefComparisonRecords,
  updateEditorialBrief,
  type EditorialBrief,
  type EditorialBriefEdits,
} from "./modules/content-opportunity-lab/review.ts";
import { REPOSITORY_ROOT, readPublicContent } from "./repository.ts";

export const STUDIO_HOST = "127.0.0.1";
const DEFAULT_PORT = 4322;
const MAX_FORM_BYTES = 1_000_000;

const axisLabels: Record<PrimaryAxis, string> = {
  general: "General",
  occasion: "Ocasión",
  recipient: "Destinatario",
  "career-stage": "Etapa profesional",
  "work-context": "Contexto laboral",
  "gift-style": "Estilo de regalo",
  budget: "Presupuesto",
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · The Good Present Studio</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f8f5ee; color: #24201b; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header, main { width: min(70rem, calc(100% - 2rem)); margin-inline: auto; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-block: 1.25rem; }
    header a { color: inherit; font-weight: 750; text-decoration: none; }
    nav { display: flex; flex-wrap: wrap; gap: 1rem; }
    main { padding-block: 2rem 4rem; }
    h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin: 0 0 .75rem; }
    h2 { margin-top: 0; }
    p { line-height: 1.6; }
    .muted { color: #675f55; }
    .notice, .error { border-left: .3rem solid #866939; padding: .75rem 1rem; background: #fffaf0; }
    .error { border-color: #a12828; background: #fff0f0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 1rem; margin-block: 2rem; }
    .card { border: 1px solid #d8d0c4; border-radius: .75rem; background: white; padding: 1.25rem; }
    .card h2, .card h3 { margin: 0 0 .5rem; }
    form { display: grid; gap: .85rem; }
    label { display: grid; gap: .35rem; font-weight: 650; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; border: 1px solid #91887b; border-radius: .35rem; padding: .65rem; background: white; }
    input[type="checkbox"] { width: auto; }
    button, .button { width: fit-content; border: 0; border-radius: 999px; padding: .7rem 1.1rem; background: #34271d; color: white; cursor: pointer; text-decoration: none; font-weight: 700; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; }
    dt { font-weight: 700; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-size: .9em; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .status { display: inline-block; border-radius: 999px; padding: .2rem .55rem; background: #ece7dc; font-size: .85rem; }
    .status--active { background: #dcebdd; color: #204525; }
    .status--inactive { background: #eee0df; color: #6d2924; }
    .wide { grid-column: 1 / -1; }
    ul { line-height: 1.6; }
    pre { max-height: 34rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #1e1b18; color: #fffaf0; padding: 1rem; border-radius: .5rem; }
    .checks { display: grid; gap: .5rem; }
    .checks label { display: flex; align-items: start; gap: .5rem; font-weight: 500; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .65rem; border-bottom: 1px solid #d8d0c4; text-align: left; vertical-align: top; }
    [id^="slot-"] { scroll-margin-top: 1rem; }
    [id^="slot-"]:target { outline: .2rem solid #866939; }
  </style>
</head>
<body>
  <header>
    <a href="/">The Good Present · Studio</a>
    <nav aria-label="Principal"><a href="/">Borradores</a><a href="/drafts/new">Crear</a><a href="/products">Productos</a><a href="/product-intelligence">Cobertura</a><a href="/product-sourcing">Sourcing</a><a href="/opportunities">Oportunidades</a><a href="/products/intake">Ingreso asistido</a><a href="/affiliate-programs">Programas afiliados</a><a href="/affiliate-operations">QA afiliados</a></nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    throw new TypeError("El formulario debe usar application/x-www-form-urlencoded.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new RangeError("El formulario es demasiado grande.");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function optionalValue(form: URLSearchParams, name: string): string | undefined {
  const value = form.get(name)?.trim();
  return value ? value : undefined;
}

function requiredValue(form: URLSearchParams, name: string, label: string): string {
  const value = optionalValue(form, name);
  if (!value) throw new TypeError(`${label} es obligatorio.`);
  return value;
}

function primaryAxisValue(form: URLSearchParams, name = "axis"): PrimaryAxis {
  const axis = requiredValue(form, name, "El eje") as PrimaryAxis;
  if (!PRIMARY_AXES.includes(axis)) throw new TypeError("El eje principal no es válido.");
  return axis;
}

function listValue(form: URLSearchParams, name: string, separator = ","): string[] | undefined {
  const value = optionalValue(form, name);
  if (!value) return undefined;
  const values = value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function productFromForm(form: URLSearchParams, id = createProductId()): Product {
  const status = form.get("status");
  if (status !== "active" && status !== "inactive") {
    throw new TypeError("El estado del producto no es válido.");
  }
  const brand = optionalValue(form, "brand");
  const productUrl = optionalValue(form, "productUrl");
  const affiliateUrl = optionalValue(form, "affiliateUrl");
  if (!validateProductUrl(productUrl)) {
    throw new TypeError("La URL del producto debe ser HTTP(S) y absoluta.");
  }
  if (!validateProductUrl(affiliateUrl)) {
    throw new TypeError("La URL afiliada debe ser HTTP(S) y absoluta.");
  }
  if (affiliateUrl && isApprovedAmazonUsHost(affiliateUrl)) {
    throw new TypeError("Los enlaces Amazon deben guardarse desde el intake Amazon US.");
  }
  const verifiedFacts = listValue(form, "verifiedFacts", "\n");
  const priceLabel = optionalValue(form, "priceLabel");
  const image = optionalValue(form, "image");
  const imageAlt = optionalValue(form, "imageAlt");
  const categories = listValue(form, "categories");
  const interests = listValue(form, "interests");
  const recipients = listValue(form, "recipients");
  const occasions = listValue(form, "occasions");
  const lastCheckedAt = optionalValue(form, "lastCheckedAt");
  return {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    id,
    name: requiredValue(form, "name", "El nombre"),
    ...(brand ? { brand } : {}),
    merchant: requiredValue(form, "merchant", "El comercio"),
    ...(productUrl ? { productUrl } : {}),
    ...(affiliateUrl ? { affiliateUrl } : {}),
    shortDescription: requiredValue(form, "shortDescription", "La descripción breve"),
    ...(verifiedFacts ? { verifiedFacts } : {}),
    ...(priceLabel ? { priceLabel } : {}),
    ...(image ? { image } : {}),
    ...(imageAlt ? { imageAlt } : {}),
    ...(categories ? { categories } : {}),
    ...(interests ? { interests } : {}),
    ...(recipients ? { recipients } : {}),
    ...(occasions ? { occasions } : {}),
    status,
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
  };
}

function manualProductIntakeFromForm(form: URLSearchParams): ManualProductIntakeInput {
  const discoverySourceKind = optionalValue(form, "discoverySourceKind");
  const discoveryProvider = optionalValue(form, "discoveryProvider");
  const discoveryObservedAt = optionalValue(form, "discoveryObservedAt");
  return {
    productUrl: optionalValue(form, "productUrl"),
    affiliateUrl: optionalValue(form, "affiliateUrl"),
    asin: optionalValue(form, "asin"),
    trackingId: optionalValue(form, "trackingId"),
    name: form.get("name")?.trim() ?? "",
    brand: optionalValue(form, "brand"),
    merchant: form.get("merchant")?.trim() ?? "",
    shortDescription: form.get("shortDescription")?.trim() ?? "",
    sourceFacts: listValue(form, "sourceFacts", "\n") ?? [],
    verifiedFacts: listValue(form, "verifiedFacts", "\n") ?? [],
    verifiedFactsConfirmed: form.get("verifiedFactsConfirmed") === "yes",
    priceLabel: optionalValue(form, "priceLabel"),
    categories: listValue(form, "categories"),
    interests: listValue(form, "interests"),
    recipients: listValue(form, "recipients"),
    occasions: listValue(form, "occasions"),
    image: optionalValue(form, "image"),
    imageAlt: optionalValue(form, "imageAlt"),
    imageRightsNotes: optionalValue(form, "imageRightsNotes"),
    provenanceNotes: optionalValue(form, "provenanceNotes"),
    status: form.get("status") as Product["status"],
    productId: optionalValue(form, "productId"),
    sourceId: optionalValue(form, "sourceId"),
    importedAt: optionalValue(form, "importedAt"),
    ...(discoverySourceKind && discoveryProvider && discoveryObservedAt
      ? {
          discoveryProvenance: {
            sourceKind: discoverySourceKind as "serpapi" | "dataforseo",
            provider: discoveryProvider,
            marketplace: optionalValue(form, "discoveryMarketplace"),
            externalId: optionalValue(form, "discoveryExternalId"),
            sourceUrl: optionalValue(form, "discoverySourceUrl"),
            observedAt: discoveryObservedAt,
          },
        }
      : {}),
  };
}

const sourceKindLabels: Record<(typeof PRODUCT_SOURCE_KINDS)[number], string> = {
  manual: "Manual",
  "manual-amazon": "Manual · Amazon",
  "csv-import": "Importación CSV",
  "amazon-creators-api": "Amazon Creators API",
  serpapi: "SerpAPI",
  dataforseo: "DataForSEO",
};

const sourceStatusLabels: Record<(typeof PRODUCT_SOURCE_STATUSES)[number], string> = {
  active: "Activa",
  inactive: "Inactiva",
  "needs-review": "Necesita revisión",
};

function sourceTimestampValue(
  form: URLSearchParams,
  name: string,
  fallback?: string,
): string | undefined {
  const raw = optionalValue(form, name);
  if (!raw) return fallback;
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`La fecha ${name} no es válida.`);
  return date.toISOString();
}

function sourceTimestampInput(value: string | undefined): string {
  return value ? new Date(value).toISOString().slice(0, -1) : "";
}

function productSourceFromForm(form: URLSearchParams, productId: string): ProductSourceRecord {
  const sourceKind = requiredValue(form, "sourceKind", "El tipo de fuente");
  if (!(PRODUCT_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new TypeError("El tipo de fuente no es válido.");
  }
  if (sourceKind === "manual-amazon") {
    throw new TypeError("Las fuentes Amazon deben guardarse desde el intake Amazon US.");
  }
  const importMethod = optionalValue(form, "importMethod") ?? "manual";
  if (!(PRODUCT_SOURCE_IMPORT_METHODS as readonly string[]).includes(importMethod)) {
    throw new TypeError("El método de importación no es válido.");
  }
  const sourceStatus = optionalValue(form, "sourceStatus") ?? "active";
  if (!(PRODUCT_SOURCE_STATUSES as readonly string[]).includes(sourceStatus)) {
    throw new TypeError("El estado de la fuente no es válido.");
  }
  try {
    return productSourceRecordSchema.parse({
      id: optionalValue(form, "sourceId") ?? createProductSourceId(),
      productId,
      sourceKind,
      provider: requiredValue(form, "provider", "El proveedor"),
      ...(optionalValue(form, "marketplace")
        ? { marketplace: optionalValue(form, "marketplace") }
        : {}),
      ...(optionalValue(form, "externalId")
        ? { externalId: optionalValue(form, "externalId") }
        : {}),
      ...(optionalValue(form, "sourceUrl") ? { sourceUrl: optionalValue(form, "sourceUrl") } : {}),
      importMethod,
      importedAt: sourceTimestampValue(form, "importedAt", new Date().toISOString()),
      ...(sourceTimestampValue(form, "lastReviewedAt")
        ? { lastReviewedAt: sourceTimestampValue(form, "lastReviewedAt") }
        : {}),
      ...(sourceTimestampValue(form, "lastSynchronizedAt")
        ? { lastSynchronizedAt: sourceTimestampValue(form, "lastSynchronizedAt") }
        : {}),
      sourceStatus,
      ...(optionalValue(form, "notes") ? { notes: optionalValue(form, "notes") } : {}),
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(error instanceof Error ? error.message : String(error));
  }
}

function value(value: string | undefined): string {
  return escapeHtml(value ?? "");
}

function listText(items: string[] | undefined, separator = ", "): string {
  return value(items?.join(separator));
}

function safeReturnTo(value: string | null): string | undefined {
  return value &&
    (/^\/drafts\/[a-z0-9_-]+(?:#slot-[a-z0-9_-]+)?$/.test(value) ||
      /^\/product-sourcing\/request_[a-z0-9_-]+$/.test(value))
    ? value
    : undefined;
}

function guideDraftSlotPath(draftId: string, slotId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}#slot-${encodeURIComponent(slotId)}`;
}

function productRequirementOriginFromForm(form: URLSearchParams): ProductRequirementOrigin {
  const kind = requiredValue(form, "originKind", "El tipo de origen");
  const origin =
    kind === "candidate"
      ? { kind, candidateId: requiredValue(form, "candidateId", "El candidato de origen") }
      : kind === "brief"
        ? { kind, briefId: requiredValue(form, "briefId", "El brief de origen") }
        : kind === "guide-draft"
          ? {
              kind,
              guideDraftId: requiredValue(form, "guideDraftId", "El GuideDraft de origen"),
            }
          : kind === "recommendation-slot"
            ? {
                kind,
                guideDraftId: requiredValue(form, "guideDraftId", "El GuideDraft de origen"),
                recommendationSlotId: requiredValue(
                  form,
                  "recommendationSlotId",
                  "El slot de origen",
                ),
              }
            : { kind };
  return productRequirementOriginSchema.parse(origin);
}

function productSourcingRequestFromForm(form: URLSearchParams): ProductSourcingRequestInput {
  return {
    origin: productRequirementOriginFromForm(form),
    intendedRole: requiredValue(form, "intendedRole", "El rol editorial"),
    requiredCategory: requiredValue(form, "requiredCategory", "La categoría requerida"),
    audience: requiredValue(form, "audience", "La audiencia"),
    occasion: requiredValue(form, "occasion", "La ocasión"),
    budgetContext: requiredValue(form, "budgetContext", "El presupuesto"),
    mustHaveVerifiedFacts: listValue(form, "mustHaveVerifiedFacts", "\n") ?? [],
    exclusions: listValue(form, "exclusions", "\n") ?? [],
    searchTerms: listValue(form, "searchTerms") ?? [],
  };
}

async function ensureDraftSlotSourcingRequest(
  draft: GuideDraft,
  slotId: string,
  sourcingStore: ProductSourcingRequestStore,
  brief?: EditorialBrief,
): Promise<ProductSourcingRequest> {
  const slot = draft.recommendations.find(({ id }) => id === slotId);
  if (!slot) throw new TypeError(`No existe el slot "${slotId}".`);
  const existing = findProductSourcingRequestForDraftSlot(sourcingStore.list(), draft.id, slot.id);
  if (existing) {
    if (existing.status === "held") {
      return sourcingStore.save(transitionProductSourcingRequest(existing, "open"));
    }
    return existing;
  }
  return sourcingStore.save(
    createProductSourcingRequestForDraftSlot(
      draft,
      slot,
      brief ? { targetAudience: brief.targetAudience, risks: brief.risks } : undefined,
    ),
  );
}

function requestCandidate(
  request: ProductSourcingRequest,
  candidateId: string,
): ProductSourceCandidate {
  const candidate = request.sourceCandidates.find(({ id }) => id === candidateId);
  if (!candidate) throw new TypeError("El candidato no pertenece a la solicitud de sourcing.");
  return candidate;
}

function requireCandidateReviewConfirmations(
  form: URLSearchParams,
  candidate: ProductSourceCandidate,
): void {
  const required = ["confirmIdentity", "confirmProvenance", "confirmFacts", "confirmDescription"];
  if (candidate.affiliateUrl) required.push("confirmAffiliate");
  const missing = required.filter((name) => form.get(name) !== "yes");
  if (missing.length) {
    throw new TypeError(`Confirmá la revisión del candidato: ${missing.join(", ")}.`);
  }
}

function manualUrlResolutionPage(
  draftId: string,
  slotId: string,
  resolution: ManualProductUrlResolution,
): string {
  const errors = resolution.errors.length
    ? `<div class="error"><strong>La URL necesita cambios.</strong><ul>${resolution.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
    : "";
  const warnings = resolution.warnings.length
    ? `<div class="notice"><strong>Advertencias para P.1</strong><ul>${resolution.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`
    : "";
  return page(
    "Revisión de URL de producto",
    `<p><a href="${guideDraftSlotPath(draftId, slotId)}">← Volver al slot</a></p>
     <h1>Pegar URL de producto o afiliado</h1>
     ${errors}${warnings}
     <form method="post" action="/drafts/${encodeURIComponent(draftId)}/recommendations/${encodeURIComponent(slotId)}/resolve-url" class="card">
       <label>URL de producto o afiliado<input type="url" name="url" value="${value(resolution.sourceUrl)}" required></label>
       <label>Destino afiliado separado (opcional)<input type="url" name="affiliateUrl" value="${value(resolution.originalAffiliateUrl)}"></label>
       <label>Tracking ID conocido (opcional)<input name="trackingId" value="${value(resolution.trackingId)}"></label>
       <button type="submit">Crear candidato y revisar en P.1</button>
     </form>`,
  );
}

function productSourceSection(
  product: Product,
  sources: ProductSourceRecord[],
  selected?: ProductSourceRecord,
): string {
  const sourceCards = sources
    .map(
      (source) =>
        `<article class="card">
          <div class="actions"><h3>${escapeHtml(source.provider)}${source.marketplace ? ` · ${escapeHtml(source.marketplace)}` : ""}</h3><span class="status">${escapeHtml(sourceStatusLabels[source.sourceStatus])}</span></div>
          <dl><dt>Tipo</dt><dd>${escapeHtml(sourceKindLabels[source.sourceKind])}</dd><dt>ID externo</dt><dd>${escapeHtml(source.externalId ?? "No informado")}</dd><dt>Importado</dt><dd>${escapeHtml(source.importedAt)}</dd><dt>Origen</dt><dd>${source.sourceUrl ? escapeHtml(source.sourceUrl) : "No informado"}</dd></dl>
          ${source.notes ? `<p>${escapeHtml(source.notes)}</p>` : ""}
          ${source.sourceKind === "manual-amazon" ? "" : `<a href="/products/${encodeURIComponent(product.id)}/edit?sourceId=${encodeURIComponent(source.id)}">Editar esta fuente</a>`}
        </article>`,
    )
    .join("");
  const options = PRODUCT_SOURCE_KINDS.filter((kind) => kind !== "manual-amazon")
    .map(
      (kind) =>
        `<option value="${kind}"${selected?.sourceKind === kind ? " selected" : ""}>${sourceKindLabels[kind]}</option>`,
    )
    .join("");
  const statusOptions = PRODUCT_SOURCE_STATUSES.map(
    (status) =>
      `<option value="${status}"${(selected?.sourceStatus ?? "active") === status ? " selected" : ""}>${sourceStatusLabels[status]}</option>`,
  ).join("");
  const methodOptions = PRODUCT_SOURCE_IMPORT_METHODS.map(
    (method) =>
      `<option value="${method}"${(selected?.importMethod ?? "manual") === method ? " selected" : ""}>${method}</option>`,
  ).join("");
  return `<section class="card">
    <h2>Provenance non pública</h2>
    <p class="notice">Estas fuentes sólo ayudan al Studio a recordar el origen del producto. No entran en la ficha pública ni reemplazan los campos editoriales.</p>
    ${sourceCards || '<p class="muted">Todavía no hay fuentes registradas.</p>'}
    <h3>${selected ? "Actualizar fuente" : "Agregar fuente"}</h3>
    <form method="post" action="/products/${encodeURIComponent(product.id)}/sources">
      ${selected ? `<input type="hidden" name="sourceId" value="${escapeHtml(selected.id)}">` : ""}
      <div class="grid">
        <label>Tipo<select name="sourceKind" required>${options}</select></label>
        <label>Proveedor o merchant<input name="provider" required value="${value(selected?.provider)}"></label>
        <label>Marketplace (opcional)<input name="marketplace" value="${value(selected?.marketplace)}"></label>
        <label>ID externo (opcional)<input name="externalId" value="${value(selected?.externalId)}"></label>
        <label>URL de origen (opcional)<input type="url" name="sourceUrl" value="${value(selected?.sourceUrl)}" placeholder="https://…"></label>
        <label>Método<select name="importMethod">${methodOptions}</select></label>
        <label>Importado en (UTC)<input type="datetime-local" step="0.001" name="importedAt" value="${sourceTimestampInput(selected?.importedAt)}"></label>
        <label>Revisado en UTC (opcional)<input type="datetime-local" step="0.001" name="lastReviewedAt" value="${sourceTimestampInput(selected?.lastReviewedAt)}"></label>
        <label>Sincronizado en UTC (opcional)<input type="datetime-local" step="0.001" name="lastSynchronizedAt" value="${sourceTimestampInput(selected?.lastSynchronizedAt)}"></label>
        <label>Estado<select name="sourceStatus">${statusOptions}</select></label>
        <label class="wide">Notas<textarea name="notes" rows="3">${value(selected?.notes)}</textarea></label>
      </div>
      <button type="submit">${selected ? "Actualizar fuente" : "Guardar fuente"}</button>
    </form>
  </section>`;
}

function amazonAffiliateSection(
  product: Product,
  sources: ProductSourceRecord[],
  repositoryRoot: string,
  validation?: AmazonAffiliateIntakeValidation,
): string {
  let program;
  let programError: string | undefined;
  try {
    program = readAmazonUsAffiliateProgram(repositoryRoot);
  } catch (error) {
    programError = error instanceof Error ? error.message : String(error);
  }

  const amazonSources = sources.filter((source) => source.sourceKind === "manual-amazon");
  const sourceList = amazonSources.length
    ? `<ul>${amazonSources
        .map(
          (source) =>
            `<li><strong>${escapeHtml(source.externalId ?? "ASIN no visible")}</strong> · ${escapeHtml(source.normalizedAffiliateUrl ?? source.originalAffiliateUrl ?? "Special Link")}</li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">Todavia no hay un origen Amazon vinculado.</p>';
  const selectedTrackingId = validation?.trackingId ?? program?.allowedTrackingIds[0] ?? "";
  const trackingOptions =
    program?.allowedTrackingIds
      .map(
        (trackingId) =>
          `<option value="${escapeHtml(trackingId)}"${trackingId === selectedTrackingId ? " selected" : ""}>${escapeHtml(trackingId)}</option>`,
      )
      .join("") ?? "";
  const validationHtml = validation
    ? `<div class="${validation.errors.length ? "error" : "notice"}">
         <strong>${validation.errors.length ? "La validacion necesita cambios." : "Validacion local completada."}</strong>
         ${validation.errors.length ? `<ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
         ${validation.warnings.length ? `<p>Advertencias:</p><ul>${validation.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
         ${!validation.errors.length ? "<p>Revisa las advertencias y confirma explicitamente para guardar la URL afiliada.</p>" : ""}
       </div>`
    : "";
  const productUrl = validation?.product.submittedUrl ?? product.productUrl ?? "";
  const affiliateUrl = validation?.affiliate.submittedUrl ?? product.affiliateUrl ?? "";
  const programWarning = programError
    ? `<p class="error">${escapeHtml(programError)}</p>`
    : program && !program.enabled
      ? '<p class="error">El perfil Amazon US esta desactivado. Configuralo antes de guardar.</p>'
      : program && !program.allowedTrackingIds.length
        ? '<p class="error">El perfil Amazon US no tiene tracking IDs aprobados configurados.</p>'
        : "";
  return `<section class="card">
    <h2>Intake manual Amazon US</h2>
    <p class="notice">SiteStripe o Associates Central genera el Special Link. Este Studio solo inspecciona las cadenas pegadas: no visita Amazon, no expande redirecciones y no agrega tags.</p>
    ${programWarning}
    <p>Fuentes Amazon ya vinculadas:</p>${sourceList}
    ${validationHtml}
    <form method="post" action="/products/${encodeURIComponent(product.id)}/amazon-affiliate">
      <div class="grid">
        <label>URL de producto Amazon<input type="url" name="productUrl" required value="${value(productUrl)}" placeholder="https://www.amazon.com/dp/..."></label>
        <label>URL afiliada / Special Link<input type="url" name="affiliateUrl" required value="${value(affiliateUrl)}" placeholder="https://www.amazon.com/dp/...?...tag=..."></label>
        <label>Tracking ID aprobado<select name="trackingId" required>${trackingOptions || '<option value="">Configura un ID aprobado</option>'}</select></label>
      </div>
      <label><input type="checkbox" name="confirm" value="yes"> Confirmo que pegue el enlace generado por SiteStripe o Associates Central y quiero guardar la URL afiliada validada.</label>
      <button type="submit">Validar y guardar enlace Amazon</button>
    </form>
    <p class="muted">Hosts aprobados localmente: ${escapeHtml(program?.approvedHosts.join(", ") ?? "no configurados")}.</p>
  </section>`;
}

function productFormPage(
  product?: Product,
  returnTo?: string,
  sources: ProductSourceRecord[] = [],
  selectedSource?: ProductSourceRecord,
  repositoryRoot = REPOSITORY_ROOT,
  amazonValidation?: AmazonAffiliateIntakeValidation,
): string {
  const editing = Boolean(product);
  const action = editing ? `/products/${encodeURIComponent(product!.id)}` : "/products";
  const submitLabel = editing ? "Guardar producto" : "Crear producto";
  return page(
    editing ? `Editar ${product!.name}` : "Nuevo producto",
    `<p><a href="/products">← Catálogo</a></p>
     <h1>${editing ? "Editar producto" : "Nuevo producto"}</h1>
     <p class="notice">${editing ? `El ID estable <code>${escapeHtml(product!.id)}</code> y el nombre del archivo no cambian.` : "El Studio asignará un ID estable. Los productos se pueden reutilizar en varias guías."}</p>
     <form method="post" action="${action}" class="card">
       ${returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">` : ""}
       <div class="grid">
         <label>Nombre<input name="name" required value="${value(product?.name)}"></label>
         <label>Marca (opcional)<input name="brand" value="${value(product?.brand)}"></label>
         <label>Comercio<input name="merchant" required value="${value(product?.merchant)}"></label>
         <label>Estado<select name="status"><option value="active"${product?.status !== "inactive" ? " selected" : ""}>Activo</option><option value="inactive"${product?.status === "inactive" ? " selected" : ""}>Inactivo</option></select></label>
         <label class="wide">Descripción breve<textarea name="shortDescription" rows="3" required>${value(product?.shortDescription)}</textarea></label>
         <label>URL del producto (opcional)<input type="url" name="productUrl" value="${value(product?.productUrl)}" placeholder="https://…"></label>
         <label>URL afiliada (opcional)<input type="url" name="affiliateUrl" value="${value(product?.affiliateUrl)}" placeholder="https://…"></label>
         <label>Precio descriptivo (opcional)<input name="priceLabel" value="${value(product?.priceLabel)}"></label>
         <label>Última verificación (opcional)<input type="date" name="lastCheckedAt" value="${value(product?.lastCheckedAt)}"></label>
         <label class="wide">Datos verificados (uno por línea)<textarea name="verifiedFacts" rows="4">${listText(product?.verifiedFacts, "\n")}</textarea></label>
         <label>Imagen (URL o ruta raíz, opcional)<input name="image" value="${value(product?.image)}"></label>
         <label>Texto alternativo de imagen<input name="imageAlt" value="${value(product?.imageAlt)}"></label>
         <label>Categorías, separadas por coma<input name="categories" value="${listText(product?.categories)}"></label>
         <label>Intereses, separados por coma<input name="interests" value="${listText(product?.interests)}"></label>
         <label>Destinatarios, separados por coma<input name="recipients" value="${listText(product?.recipients)}"></label>
         <label>Ocasiones, separadas por coma<input name="occasions" value="${listText(product?.occasions)}"></label>
       </div>
       <button type="submit">${submitLabel}</button>
     </form>
     ${product ? productSourceSection(product, sources, selectedSource) : ""}
     ${product ? amazonAffiliateSection(product, sources, repositoryRoot, amazonValidation) : ""}`,
  );
}

function emptyManualProductIntake(): ManualProductIntakeInput {
  return {
    name: "",
    merchant: "",
    shortDescription: "",
    sourceFacts: [],
    verifiedFacts: [],
    verifiedFactsConfirmed: false,
    status: "active",
  };
}

interface ManualProductCandidateReview {
  requestId: string;
  candidateId: string;
  candidate: ProductSourceCandidate;
}

function manualProductIntakeFromCandidate(
  candidate: ProductSourceCandidate,
): ManualProductIntakeInput {
  let merchant =
    candidate.merchant ?? (/Amazon/i.test(candidate.provider) ? "Amazon" : candidate.provider);
  if (
    (merchant === "Manual" || merchant === "SerpAPI" || merchant === "DataForSEO") &&
    candidate.sourceUrl
  ) {
    try {
      merchant = new URL(candidate.sourceUrl).hostname;
    } catch {
      merchant = "";
    }
  }
  return {
    ...(candidate.originalProductUrl || candidate.productUrl
      ? { productUrl: candidate.originalProductUrl ?? candidate.productUrl }
      : {}),
    ...(candidate.originalAffiliateUrl || candidate.affiliateUrl
      ? { affiliateUrl: candidate.originalAffiliateUrl ?? candidate.affiliateUrl }
      : {}),
    ...(candidate.externalId && candidate.marketplace === "amazon.com"
      ? { asin: candidate.externalId }
      : {}),
    ...(candidate.trackingId ? { trackingId: candidate.trackingId } : {}),
    name: "",
    merchant,
    shortDescription: "",
    sourceFacts: [...candidate.sourceFacts],
    verifiedFacts: [],
    verifiedFactsConfirmed: false,
    status: "active",
    ...(candidate.sourceKind === "serpapi" || candidate.sourceKind === "dataforseo"
      ? {
          discoveryProvenance: {
            sourceKind: candidate.sourceKind,
            provider: candidate.provider,
            ...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
            ...(candidate.externalId ? { externalId: candidate.externalId } : {}),
            ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
            observedAt: candidate.observedAt!,
          },
        }
      : {}),
  };
}

function candidateReviewChecks(review?: ManualProductCandidateReview): string {
  if (!review) return "";
  const warnings = review.candidate.urlWarnings?.length
    ? `<div class="notice"><strong>Advertencias de URL</strong><ul>${review.candidate.urlWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`
    : "";
  return `${warnings}<fieldset class="card"><legend>Confirmaciones del candidato</legend><p class="muted">La URL solo prellena evidencia local. No identifica automaticamente el producto ni crea un Product.</p><div class="checks"><label><input type="checkbox" name="confirmIdentity" value="yes"> Confirmo la identidad y reconciliacion del Product con la fuente.</label><label><input type="checkbox" name="confirmProvenance" value="yes"> Confirmo la procedencia y el origen de la informacion.</label><label><input type="checkbox" name="confirmFacts" value="yes"> Revise y confirme los datos verificados seleccionados.</label><label><input type="checkbox" name="confirmDescription" value="yes"> Escribi y confirme la descripcion editorial breve.</label>${review.candidate.affiliateUrl ? '<label><input type="checkbox" name="confirmAffiliate" value="yes"> Confirmo el destino afiliado y su separacion del URL de producto.</label>' : ""}</div></fieldset>`;
}

function manualProductIntakePage(
  preview?: ManualProductIntakePreview,
  returnTo?: string,
  review?: ManualProductCandidateReview,
): string {
  const input =
    preview?.input ??
    (review ? manualProductIntakeFromCandidate(review.candidate) : emptyManualProductIntake());
  const errors = preview?.errors ?? [];
  const warnings = preview?.warnings ?? [];
  const errorHtml = errors.length
    ? `<div class="error"><strong>La revisión necesita cambios.</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
    : preview
      ? '<p class="notice"><strong>Vista previa lista.</strong> Todavía no se escribió ningún archivo.</p>'
      : "";
  const warningHtml = warnings.length
    ? `<div class="notice"><strong>Notas de revisión</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`
    : "";
  const duplicateHtml = preview?.duplicates.length
    ? `<div class="error"><strong>Posibles duplicados</strong><ul>${preview.duplicates.map((duplicate) => `<li>${escapeHtml(duplicate.kind)} · ${escapeHtml(duplicate.productId)}${duplicate.sourceId ? ` · ${escapeHtml(duplicate.sourceId)}` : ""}: ${escapeHtml(duplicate.reason)}</li>`).join("")}</ul></div>`
    : "";
  const statusOptions = ["active", "inactive"]
    .map(
      (status) =>
        `<option value="${status}"${input.status === status ? " selected" : ""}>${status === "active" ? "Activo" : "Inactivo"}</option>`,
    )
    .join("");
  const hidden = [
    returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">` : "",
    review
      ? `<input type="hidden" name="requestId" value="${escapeHtml(review.requestId)}"><input type="hidden" name="candidateId" value="${escapeHtml(review.candidateId)}">`
      : "",
    input.productId
      ? `<input type="hidden" name="productId" value="${escapeHtml(input.productId)}">`
      : "",
    input.sourceId
      ? `<input type="hidden" name="sourceId" value="${escapeHtml(input.sourceId)}">`
      : "",
    input.importedAt
      ? `<input type="hidden" name="importedAt" value="${escapeHtml(input.importedAt)}">`
      : "",
    input.discoveryProvenance
      ? `<input type="hidden" name="discoverySourceKind" value="${escapeHtml(input.discoveryProvenance.sourceKind)}"><input type="hidden" name="discoveryProvider" value="${escapeHtml(input.discoveryProvenance.provider)}"><input type="hidden" name="discoveryObservedAt" value="${escapeHtml(input.discoveryProvenance.observedAt)}">${input.discoveryProvenance.marketplace ? `<input type="hidden" name="discoveryMarketplace" value="${escapeHtml(input.discoveryProvenance.marketplace)}">` : ""}${input.discoveryProvenance.externalId ? `<input type="hidden" name="discoveryExternalId" value="${escapeHtml(input.discoveryProvenance.externalId)}">` : ""}${input.discoveryProvenance.sourceUrl ? `<input type="hidden" name="discoverySourceUrl" value="${escapeHtml(input.discoveryProvenance.sourceUrl)}">` : ""}`
      : "",
  ].join("");
  const productPreview = preview?.product
    ? `<pre>${escapeHtml(JSON.stringify(preview.product, null, 2))}</pre>`
    : '<p class="muted">Se mostrará después de completar los campos válidos.</p>';
  const sourcePreview = preview?.source
    ? `<pre>${escapeHtml(JSON.stringify(preview.source, null, 2))}</pre>`
    : '<p class="muted">Se mostrará después de completar los campos válidos.</p>';

  return page(
    review ? "Revision P.1 del candidato" : "Ingreso manual de producto",
    `<p><a href="/products">← Catálogo</a></p>
     <h1>${review ? "Revision P.1 del candidato" : "Ingreso manual de producto"}</h1>
     ${review ? `<p>Solicitud I.2: <code>${escapeHtml(review.requestId)}</code> - candidato <code>${escapeHtml(review.candidateId)}</code>. Esta revision volvera al mismo requisito y no cumple ni asigna el slot automaticamente.</p>` : ""}
     <p class="notice">Este flujo acepta sólo información pegada y verificada por el editor. No visita Amazon, no raspa páginas, no descarga imágenes y no genera URLs afiliadas.</p>
     ${errorHtml}${warningHtml}${duplicateHtml}
     <form method="post" action="/products/intake" class="card">
       ${hidden}
       <section>
         <h2>Información de la fuente</h2>
         <p class="muted">Estos datos describen el origen y permanecen en el registro no público de Studio.</p>
         <div class="grid">
           <label>URL de producto (Amazon u otro comercio; opcional si ingresas el ASIN)<input type="url" name="productUrl" value="${value(input.productUrl)}" placeholder="https://..."></label>
           <label>ASIN (opcional si aparece en la URL)<input name="asin" value="${value(input.asin)}" pattern="[A-Za-z0-9]{10}"></label>
           <label>URL afiliada pegada desde el intake de afiliados (opcional)<input type="url" name="affiliateUrl" value="${value(input.affiliateUrl)}" placeholder="https://www.amazon.com/dp/...?...tag=..."></label>
           <label>Tracking ID verificado (si hay URL afiliada)<input name="trackingId" value="${value(input.trackingId)}"></label>
           <label class="wide">Hechos ingresados desde la fuente (uno por línea)<textarea name="sourceFacts" rows="4">${listText(input.sourceFacts, "\n")}</textarea></label>
           <label class="wide">Notas de procedencia o derechos de imagen<textarea name="provenanceNotes" rows="3">${value(input.provenanceNotes)}</textarea></label>
         </div>
       </section>
       <section>
         <h2>Copy editorial original</h2>
         <p class="muted">Esta copia la escribe el editor. No se copia automáticamente ninguna descripción del comerciante.</p>
         <div class="grid">
           <label>Nombre<input name="name" required value="${value(input.name)}"></label>
           <label>Marca (opcional)<input name="brand" value="${value(input.brand)}"></label>
           <label>Comercio<input name="merchant" required value="${value(input.merchant)}"></label>
           <label>Estado<select name="status">${statusOptions}</select></label>
           <label class="wide">Descripción breve original<textarea name="shortDescription" rows="3" required>${value(input.shortDescription)}</textarea></label>
           <label class="wide">Datos verificados seleccionados (uno por línea)<textarea name="verifiedFacts" rows="4">${listText(input.verifiedFacts, "\n")}</textarea></label>
           <label class="wide"><input type="checkbox" name="verifiedFactsConfirmed" value="yes"${input.verifiedFactsConfirmed ? " checked" : ""}> Afirmo que cada dato verificado seleccionado está respaldado por los hechos ingresados de la fuente.</label>
           <label>Etiqueta de precio revisada, no precio vivo<input name="priceLabel" value="${value(input.priceLabel)}" placeholder="Menos de $25"></label>
           <label>Referencia de imagen, sin descarga automática<input name="image" value="${value(input.image)}" placeholder="https://... o /images/..."></label>
           <label>Texto alternativo de imagen<input name="imageAlt" value="${value(input.imageAlt)}"></label>
           <label>Notas específicas de derechos/procedencia de imagen<input name="imageRightsNotes" value="${value(input.imageRightsNotes)}"></label>
           <label>Categorías, separadas por coma<input name="categories" value="${listText(input.categories)}"></label>
           <label>Intereses, separados por coma<input name="interests" value="${listText(input.interests)}"></label>
           <label>Destinatarios, separados por coma<input name="recipients" value="${listText(input.recipients)}"></label>
           <label>Ocasiones, separadas por coma<input name="occasions" value="${listText(input.occasions)}"></label>
         </div>
       </section>
       <label><input type="checkbox" name="confirm" value="yes"> Confirmo la vista previa y autorizo escribir el Product canónico y su registro de fuente de forma atómica.</label>
        ${candidateReviewChecks(review)}
        <button type="submit">Revisar y guardar producto</button>
     </form>
     ${preview ? `<div class="grid"><section class="card"><h2>Product canónico previsto</h2>${productPreview}</section><section class="card"><h2>Registro de fuente no público previsto</h2>${sourcePreview}</section></div>` : ""}`,
  );
}

function productListPage(catalog: ProductCatalog, url: URL): string {
  const query = url.searchParams.get("q")?.trim() ?? "";
  const requestedStatus = url.searchParams.get("status") ?? "all";
  const status: ProductStatusFilter =
    requestedStatus === "active" || requestedStatus === "inactive" ? requestedStatus : "all";
  const content = catalog.read();
  const products = matchProducts(content.products, query, status);
  const clusters = new Map(content.clusters.map((cluster) => [cluster.id, cluster]));
  const saved = url.searchParams.has("saved")
    ? '<p class="notice">Producto guardado y contenido público validado.</p>'
    : "";
  const cards = products
    .map((product) => {
      const uses = productUsage(content.guides, product.id);
      const usage = uses.length
        ? `<ul>${uses
            .map((guide) => {
              const cluster = clusters.get(guide.clusterId)!;
              return `<li>${escapeHtml(guide.title)} <code>${escapeHtml(guidePath(cluster.slug, guide.slug))}</code></li>`;
            })
            .join("")}</ul>`
        : '<p class="muted">Todavía no se usa en guías publicadas.</p>';
      const nextAction = product.status === "active" ? "Desactivar" : "Activar";
      return `<article class="card">
        <p><span class="status status--${product.status}">${product.status === "active" ? "Activo" : "Inactivo"}</span></p>
        <h2>${escapeHtml(product.name)}</h2>
        <p>${escapeHtml(product.merchant)}${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}</p>
        <p>${escapeHtml(product.shortDescription)}</p>
        <details><summary>Uso en guías (${uses.length})</summary>${usage}</details>
        <div class="actions">
          <a class="button" href="/products/${encodeURIComponent(product.id)}/edit">Editar</a>
          <form method="post" action="/products/${encodeURIComponent(product.id)}/toggle"><button type="submit">${nextAction}</button></form>
        </div>
      </article>`;
    })
    .join("");
  return page(
    "Productos",
    `<div class="actions"><div><h1>Catálogo de productos</h1><p>Buscá por nombre, marca, comercio, categoría, interés, destinatario u ocasión.</p></div><div class="actions"><a class="button" href="/products/intake">Ingreso asistido</a><a class="button" href="/products/new">Agregar producto</a></div></div>
     ${saved}
     <form method="get" action="/products" class="card">
       <div class="grid">
         <label>Buscar<input type="search" name="q" value="${escapeHtml(query)}"></label>
         <label>Estado<select name="status"><option value="all"${status === "all" ? " selected" : ""}>Todos</option><option value="active"${status === "active" ? " selected" : ""}>Activos</option><option value="inactive"${status === "inactive" ? " selected" : ""}>Inactivos</option></select></label>
       </div>
       <button type="submit">Aplicar</button>
     </form>
     <p class="muted">${products.length} de ${content.products.length} productos</p>
     <div class="grid">${cards || '<p class="notice">No hay productos que coincidan.</p>'}</div>`,
  );
}

function affiliateProgramStatusPage(repositoryRoot = REPOSITORY_ROOT): string {
  const records = readAffiliateProgramRecords(repositoryRoot);
  const cards = records
    .map((record) => {
      if (record.error) {
        return `<article class="card"><h2>${escapeHtml(record.file)}</h2><p class="error">Configuración inválida: ${escapeHtml(record.error)}</p></article>`;
      }
      const program = record.program!;
      const missing = missingAffiliateProgramConfiguration(program);
      const status = missing.length
        ? "Falta configuración"
        : program.enabled
          ? "Activo"
          : "Desactivado";
      return `<article class="card">
        <div class="actions"><h2>${escapeHtml(program.id)}</h2><span class="status">${status}</span></div>
        <dl>
          <dt>Archivo</dt><dd><code>${escapeHtml(record.file)}</code></dd>
          <dt>Program ID</dt><dd>${escapeHtml(program.programId ?? "No configurado")}</dd>
          <dt>Marketplace</dt><dd>${escapeHtml(program.marketplace ?? "No configurado")}</dd>
          <dt>Store o associate ID</dt><dd>${escapeHtml(program.storeOrAssociateId ?? "No configurado")}</dd>
          <dt>Tracking IDs permitidos</dt><dd>${escapeHtml(program.allowedTrackingIds.join(", ") || "Ninguno")}</dd>
          <dt>Hosts aprobados</dt><dd>${escapeHtml(program.approvedHosts.join(", ") || "Ninguno")}</dd>
          <dt>Disclosure</dt><dd>${escapeHtml(program.disclosureText ?? "No configurado")}</dd>
          <dt>Versión disclosure</dt><dd>${escapeHtml(program.disclosureVersion ?? "No configurada")}</dd>
        </dl>
        ${missing.length ? `<p class="error"><strong>Falta:</strong> ${escapeHtml(missing.join(", "))}.</p>` : '<p class="notice">Configuración completa para revisión editorial.</p>'}
      </article>`;
    })
    .join("");
  return page(
    "Programas afiliados",
    `<div class="actions"><div><h1>Programas afiliados</h1><p>Estado local de programas y configuración editorial no pública.</p></div></div>
     <p class="notice">Esta pantalla no genera enlaces, importa reportes ni guarda secretos. Las credenciales futuras deben vivir en el proceso del servidor.</p>
     ${cards || '<p class="notice">No hay programas configurados. Agregá un JSON en <code>editorial-data/affiliate-programs/</code>.</p>'}
     <p class="muted">La configuración de afiliados nunca entra en <code>content/</code> ni en la salida estática de Astro.</p>`,
  );
}

function affiliateValidationPage(repositoryRoot = REPOSITORY_ROOT): string {
  const report = validateAffiliateOperations(
    readPublicContent(repositoryRoot),
    readAffiliateProgramRecords(repositoryRoot),
    {
      siteDistRoot: resolve(repositoryRoot, "apps/site/dist"),
    },
  );
  const counts = report.coverage.reduce(
    (result, entry) => {
      result[entry.kind] += 1;
      return result;
    },
    { affiliate: 0, ordinary: 0, "amazon-pending": 0, none: 0 },
  );
  const coverage = report.coverage
    .map(
      (entry) => `<article class="card">
        <div class="actions"><h3>${escapeHtml(entry.product)}</h3><span class="status">${escapeHtml(entry.kind)}</span></div>
        <dl><dt>Producto</dt><dd><code>${escapeHtml(entry.productId)}</code></dd><dt>Guía</dt><dd>${escapeHtml(entry.guide)} <code>${escapeHtml(entry.guideId)}</code></dd><dt>Ruta</dt><dd><code>${escapeHtml(entry.route)}</code></dd><dt>Destino</dt><dd>${entry.destination ? escapeHtml(entry.destination) : "Sin CTA"}</dd></dl>
      </article>`,
    )
    .join("");
  const findings = report.findings
    .map(
      (finding) => `<article class="card">
        <div class="actions"><h3>${escapeHtml(finding.field)}</h3><span class="status status--${finding.severity === "error" ? "inactive" : "active"}">${escapeHtml(finding.severity)}</span></div>
        <dl><dt>Producto</dt><dd>${escapeHtml(finding.product)} <code>${escapeHtml(finding.productId)}</code></dd><dt>Guía</dt><dd>${escapeHtml(finding.guide)} <code>${escapeHtml(finding.guideId)}</code></dd><dt>Ruta</dt><dd><code>${escapeHtml(finding.route)}</code></dd><dt>Campo</dt><dd><code>${escapeHtml(finding.field)}</code></dd><dt>Razón</dt><dd>${escapeHtml(finding.reason)}</dd></dl>
      </article>`,
    )
    .join("");
  return page(
    "Affiliate QA",
    `<div class="actions"><div><h1>QA de enlaces afiliados</h1><p>Revisión local de cobertura, tracking, hosts, CTA y disclosure de las guías publicadas.</p></div></div>
     <p class="notice">No se hacen requests de red, no se siguen enlaces y no se reescriben URLs. Salida renderizada: <strong>${escapeHtml(report.renderedOutput)}</strong>.</p>
     <div class="grid"><article class="card"><h2>${counts.affiliate}</h2><p>Recomendaciones con enlace afiliado</p></article><article class="card"><h2>${counts.ordinary}</h2><p>Con sólo URL ordinaria</p></article><article class="card"><h2>${counts["amazon-pending"]}</h2><p>Monetización Amazon pendiente</p></article><article class="card"><h2>${counts.none}</h2><p>Sin URL de salida</p></article><article class="card"><h2>${report.errors.length}</h2><p>Errores · ${report.warnings.length} advertencias</p></article></div>
     <h2>Cobertura publicada</h2>
     <div class="grid">${coverage || '<p class="notice">No hay recomendaciones publicadas.</p>'}</div>
     <h2>Hallazgos</h2>
     <div class="grid">${findings || '<p class="notice">No hay hallazgos.</p>'}</div>`,
  );
}

function productEvidenceList(products: ProductEvidence[]): string {
  return `<ul>${products
    .map(
      (product) =>
        `<li><a href="/products/${encodeURIComponent(product.productId)}/edit">${escapeHtml(product.name)}</a> <code>${escapeHtml(product.productId)}</code></li>`,
    )
    .join("")}</ul>`;
}

function guideEvidenceList(guides: GuideEvidence[]): string {
  return `<ul>${guides
    .map(
      (guide) =>
        `<li>${escapeHtml(guide.title)} <code>${escapeHtml(guide.guideId)}</code>${guide.route ? ` <code>${escapeHtml(guide.route)}</code>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

function coverageCards(cards: string[], empty: string): string {
  return cards.length
    ? `<div class="grid">${cards.join("")}</div>`
    : `<p class="notice">${empty}</p>`;
}

function productIntelligencePage(
  repositoryRoot: string,
  drafts: GuideDraft[],
  draftErrors: string[],
): string {
  const analysis = analyzeProductCoverage(
    readPublicContent(repositoryRoot),
    drafts,
    readProductGapReports(repositoryRoot),
  );
  const { catalogHealth, editorialCoverage, thresholds } = analysis;
  const draftErrorHtml = draftErrors.length
    ? `<div class="error"><strong>Borradores omitidos por errores de lectura</strong><ul>${draftErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
    : "";
  const activeUnused = catalogHealth.activeProductsUnused.map(
    (product) => `<article class="card"><h3>${escapeHtml(product.name)}</h3>
      <p><code>${escapeHtml(product.productId)}</code></p>
      <p>No aparece en ninguna guía publicada. Esto describe uso actual; no recomienda crear contenido.</p>
      <p><a href="/products/${encodeURIComponent(product.productId)}/edit">Inspeccionar producto</a></p></article>`,
  );
  const reused = catalogHealth.productsReusedAcrossGuides.map(
    ({ product, guides }) => `<article class="card"><h3>${escapeHtml(product.name)}</h3>
      <p><code>${escapeHtml(product.productId)}</code> aparece en ${guides.length} guías publicadas distintas. Repeticiones dentro de una guía cuentan una sola vez.</p>
      ${guideEvidenceList(guides)}
      <p><a href="/products/${encodeURIComponent(product.productId)}/edit">Inspeccionar producto</a></p></article>`,
  );
  const substantialCategories = catalogHealth.substantialCategories.map(
    ({ category, products }) => `<article class="card"><h3>${escapeHtml(category)}</h3>
      <p>${products.length} productos activos distintos.</p>${productEvidenceList(products)}</article>`,
  );
  const singleCategories = catalogHealth.singleProductCategories.map(
    ({ category, products }) => `<article class="card"><h3>${escapeHtml(category)}</h3>
      <p>Un solo producto activo aporta esta categoría.</p>${productEvidenceList(products)}</article>`,
  );
  const lowDiversity = catalogHealth.clustersWithLowCategoryDiversity.map(
    ({
      clusterId,
      title,
      categories,
      products,
      guides,
    }) => `<article class="card"><h3>${escapeHtml(title)}</h3>
      <p><code>${escapeHtml(clusterId)}</code> usa ${products.length} productos activos distintos y ${categories.length} categorías distintas: ${escapeHtml(categories.join(", ") || "ninguna")}.</p>
      <details><summary>Productos contribuyentes (${products.length})</summary>${productEvidenceList(products)}</details>
      <details><summary>Guías contribuyentes (${guides.length})</summary>${guideEvidenceList(guides)}</details></article>`,
  );
  const broadMetadata = catalogHealth.productsWithBroadMetadata.map(
    (product) => `<article class="card"><h3>${escapeHtml(product.name)}</h3>
      <p><code>${escapeHtml(product.productId)}</code></p>
      <dl><dt>Destinatarios (${product.recipients.length})</dt><dd>${escapeHtml(product.recipients.join(", ") || "ninguno")}</dd><dt>Ocasiones (${product.occasions.length})</dt><dd>${escapeHtml(product.occasions.join(", ") || "ninguna")}</dd></dl>
      <p>La amplitud de metadata es una observación para revisión, no una oportunidad editorial.</p>
      <p><a href="/products/${encodeURIComponent(product.productId)}/edit">Inspeccionar producto</a></p></article>`,
  );
  const inactive = catalogHealth.inactiveProducts.map(
    ({ product, guides }) => `<article class="card"><h3>${escapeHtml(product.name)}</h3>
      <p><code>${escapeHtml(product.productId)}</code> está inactivo y se excluye de cobertura, diversidad y coincidencias de slots.</p>
      ${guides.length ? `<details><summary>Referencias publicadas (${guides.length})</summary>${guideEvidenceList(guides)}</details>` : "<p>No tiene referencias publicadas.</p>"}
      <p><a href="/products/${encodeURIComponent(product.productId)}/edit">Inspeccionar producto</a></p></article>`,
  );
  const draftSlots = editorialCoverage.draftSlotsWithoutSuitableProducts.map(
    (slot) => `<article class="card"><h3>${escapeHtml(slot.slotLabel)}</h3>
      <p><a href="/drafts/${encodeURIComponent(slot.guideId)}">${escapeHtml(slot.guideTitle ?? slot.guideId)}</a> <code>${escapeHtml(slot.guideId)}</code> · slot <code>${escapeHtml(slot.slotId)}</code></p>
      <p>Ningún producto activo comparte al menos ${thresholds.minimumSlotMatchTokenCount} términos distintos con el label, la intención o los términos de búsqueda del slot.</p>
      <p class="muted">Términos: ${escapeHtml(slot.searchTerms.join(", ") || "sin términos adicionales")}.</p></article>`,
  );
  const publishedProductGaps = editorialCoverage.publishedRecommendationsWithoutProducts.map(
    (recommendation) => `<article class="card"><h3>${escapeHtml(recommendation.heading)}</h3>
      <p>${escapeHtml(recommendation.guideTitle)} <code>${escapeHtml(recommendation.guideId)}</code>${recommendation.route ? ` · <code>${escapeHtml(recommendation.route)}</code>` : ""}</p>
      <p>La recomendación <code>${escapeHtml(recommendation.recommendationId)}</code> está publicada editorialmente, pero todavía no tiene Product canónico.</p></article>`,
  );
  const briefRequirements = editorialCoverage.briefRequirementsWithoutCatalogCoverage.map(
    (requirement) => `<article class="card"><h3>${escapeHtml(requirement.requirement)}</h3>
      <p>Reporte <code>${escapeHtml(requirement.reportId)}</code> · guía <a href="/drafts/${encodeURIComponent(requirement.guideId)}"><code>${escapeHtml(requirement.guideId)}</code></a> · cluster <code>${escapeHtml(requirement.clusterId)}</code> · requisito <code>${escapeHtml(requirement.slotId)}</code></p>
      <p>${escapeHtml(requirement.reason)}</p></article>`,
  );

  const signalCount =
    catalogHealth.activeProductsUnused.length +
    catalogHealth.productsReusedAcrossGuides.length +
    catalogHealth.substantialCategories.length +
    catalogHealth.singleProductCategories.length +
    catalogHealth.clustersWithLowCategoryDiversity.length +
    catalogHealth.productsWithBroadMetadata.length +
    editorialCoverage.publishedRecommendationsWithoutProducts.length +
    editorialCoverage.draftSlotsWithoutSuitableProducts.length +
    editorialCoverage.briefRequirementsWithoutCatalogCoverage.length;

  return page(
    "Cobertura de productos",
    `<h1>Cobertura de productos</h1>
     <p>Señales deterministas sobre cómo el catálogo activo sostiene el contenido publicado, los GuideDrafts y los requisitos de briefs estructurados.</p>
     <p class="notice"><strong>Límite editorial:</strong> estas ${signalCount} observaciones no son un ranking, no proponen guías y no convierten el uso o la falta de uso en una decisión editorial.</p>
     ${draftErrorHtml}
     <details class="card"><summary>Umbrales explícitos</summary><dl><dt>Reuso entre guías</dt><dd>${thresholds.reusedGuideCount} guías publicadas distintas o más</dd><dt>Cobertura sustancial</dt><dd>${thresholds.substantialCategoryProductCount} productos activos distintos o más</dd><dt>Diversidad baja de cluster</dt><dd>menos de ${thresholds.minimumClusterCategoryCount} categorías activas distintas</dd><dt>Metadata amplia</dt><dd>${thresholds.broadMetadataValueCount} destinatarios o ${thresholds.broadMetadataValueCount} ocasiones distintas o más</dd><dt>Coincidencia de slot</dt><dd>${thresholds.minimumSlotMatchTokenCount} términos distintos compartidos o más</dd></dl></details>
     <h2>Salud del catálogo</h2>
     <h3>Productos activos sin uso publicado (${catalogHealth.activeProductsUnused.length})</h3>
     ${coverageCards(activeUnused, "Todos los productos activos aparecen en al menos una guía publicada.")}
     <h3>Productos reutilizados entre muchas guías (${catalogHealth.productsReusedAcrossGuides.length})</h3>
     ${coverageCards(reused, "Ningún producto alcanza el umbral de reuso.")}
     <h3>Categorías con cobertura sustancial (${catalogHealth.substantialCategories.length})</h3>
     ${coverageCards(substantialCategories, "Ninguna categoría alcanza el umbral de cobertura sustancial.")}
     <h3>Categorías con un solo producto (${catalogHealth.singleProductCategories.length})</h3>
     ${coverageCards(singleCategories, "No hay categorías representadas por un solo producto activo.")}
     <h3>Clusters con diversidad baja (${catalogHealth.clustersWithLowCategoryDiversity.length})</h3>
     ${coverageCards(lowDiversity, "Ningún cluster está por debajo del umbral de diversidad.")}
     <h3>Productos con metadata amplia (${catalogHealth.productsWithBroadMetadata.length})</h3>
     ${coverageCards(broadMetadata, "Ningún producto activo alcanza el umbral de destinatarios u ocasiones.")}
     <h3>Productos inactivos (${catalogHealth.inactiveProducts.length})</h3>
     ${coverageCards(inactive, "No hay productos inactivos.")}
      <h2>Cobertura editorial</h2>
      <h3>Recomendaciones publicadas sin Product (${editorialCoverage.publishedRecommendationsWithoutProducts.length})</h3>
      ${coverageCards(publishedProductGaps, "Todas las recomendaciones publicadas tienen un Product canónico.")}
      <h3>Slots de GuideDraft sin coincidencias activas (${editorialCoverage.draftSlotsWithoutSuitableProducts.length})</h3>
     ${coverageCards(draftSlots, "Todos los slots no asignados tienen al menos una coincidencia textual activa, o no hay slots para analizar.")}
     <h3>Requisitos de briefs sin cobertura declarada (${editorialCoverage.briefRequirementsWithoutCatalogCoverage.length})</h3>
     ${coverageCards(briefRequirements, "Ningún requisito estructurado está marcado como no asignado.")}`,
  );
}

function sourcingOriginLabel(request: ProductSourcingRequest): string {
  const { origin } = request;
  if (origin.kind === "candidate") return `Candidate ${origin.candidateId}`;
  if (origin.kind === "brief") return `EditorialBrief ${origin.briefId}`;
  if (origin.kind === "guide-draft") return `GuideDraft ${origin.guideDraftId}`;
  return `GuideDraft ${origin.guideDraftId} · slot ${origin.recommendationSlotId}`;
}

function productSourcingListPage(
  store: ProductSourcingRequestStore,
  discoverySource?: ProductDiscoverySource,
): string {
  const requests = store.list();
  const cards = requests
    .map(
      (request) => `<article class="card">
        <div class="actions"><h2><a href="/product-sourcing/${encodeURIComponent(request.id)}">${escapeHtml(request.requiredCategory)}</a></h2><span class="status">${escapeHtml(request.status)}</span></div>
        <p>${escapeHtml(request.intendedRole)}</p>
        <p><code>${escapeHtml(request.id)}</code> · ${escapeHtml(sourcingOriginLabel(request))}</p>
        <p>${request.approvedProductIds.length} Product canónico(s) seleccionado(s) · ${request.sourceCandidates.length} candidato(s) de fuente.</p>
        ${request.status === "open" || request.status === "partially-fulfilled" ? `<label><input type="checkbox" name="requestId" value="${escapeHtml(request.id)}"> Incluir en el SearchPlan por lote</label>` : ""}
      </article>`,
    )
    .join("");
  return page(
    "Sourcing de productos",
    `<div class="actions"><div><h1>Sourcing de productos</h1><p>Requisitos editoriales trazables conectados al catálogo y al intake existentes.</p></div></div>
     <p class="notice">Un candidato de fuente nunca satisface un requisito. Sólo una selección editorial explícita de un Product canónico activo puede hacerlo.</p>
     <form method="post" action="/product-sourcing/discovery/plan"><div class="grid">${cards || '<p class="notice">Todavía no hay solicitudes.</p>'}</div>${requests.length ? '<button type="submit">Planificar búsquedas seleccionadas</button>' : ""}</form>
     <p class="muted">La planificación usa una sola solicitud por lote al proveedor editorial existente. Descubrimiento externo: ${discoverySource ? `${escapeHtml(discoverySource.providerId)} · uso pago visible` : "desactivado; catálogo, URL manual e idea-only siguen disponibles"}.</p>
     <form method="post" action="/product-sourcing" class="card">
       <h2>Crear solicitud</h2>
       <div class="grid">
         <label>Tipo de origen<select name="originKind"><option value="candidate">Candidate</option><option value="brief">EditorialBrief</option><option value="guide-draft">GuideDraft</option><option value="recommendation-slot">Slot de GuideDraft</option></select></label>
         <label>Candidate ID<input name="candidateId"></label>
         <label>EditorialBrief ID<input name="briefId"></label>
         <label>GuideDraft ID<input name="guideDraftId"></label>
         <label>Recommendation slot ID<input name="recommendationSlotId"></label>
         <label>Rol editorial<input name="intendedRole" required></label>
         <label>Categoría requerida<input name="requiredCategory" required></label>
         <label>Audiencia<input name="audience" required></label>
         <label>Ocasión<input name="occasion" required></label>
         <label>Contexto de presupuesto<input name="budgetContext" required></label>
         <label class="wide">Datos verificados obligatorios · uno por línea<textarea name="mustHaveVerifiedFacts" rows="3"></textarea></label>
         <label class="wide">Exclusiones · una por línea<textarea name="exclusions" rows="3"></textarea></label>
         <label class="wide">Términos de búsqueda · separados por coma<input name="searchTerms" required></label>
       </div>
       <button type="submit">Crear solicitud trazable</button>
     </form>`,
  );
}

function productSelectionForm(request: ProductSourcingRequest, product: Product): string {
  return `<article class="card"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.merchant)} · <code>${escapeHtml(product.id)}</code></p><p>${escapeHtml(product.shortDescription)}</p>
    <div class="actions">
      <form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/products"><input type="hidden" name="productId" value="${escapeHtml(product.id)}"><input type="hidden" name="fulfillmentStatus" value="partially-fulfilled"><button type="submit">Seleccionar como parcial</button></form>
      <form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/products"><input type="hidden" name="productId" value="${escapeHtml(product.id)}"><input type="hidden" name="fulfillmentStatus" value="fulfilled"><button type="submit">Seleccionar y cumplir</button></form>
    </div></article>`;
}

function productSourcingDetailPage(
  request: ProductSourcingRequest,
  url: URL,
  catalog: ProductCatalog,
  sourceStore: ProductSourceStore,
  discoverySource?: ProductDiscoverySource,
): string {
  const content = catalog.read();
  const productsById = new Map(content.products.map((product) => [product.id, product]));
  const sources = sourceStore.list(content.products);
  const activeRequest = request.status === "open" || request.status === "partially-fulfilled";
  const highlighted = url.searchParams.get("productId");
  const linkedIds = request.sourceCandidates.flatMap(({ canonicalProductId }) =>
    canonicalProductId ? [canonicalProductId] : [],
  );
  const matchIds = new Set([
    ...catalogMatchesForRequest(request, content.products).map(({ id }) => id),
    ...linkedIds,
    ...(highlighted ? [highlighted] : []),
  ]);
  const matches = activeRequest
    ? content.products
        .filter(({ id, status }) => status === "active" && matchIds.has(id))
        .map((product) => productSelectionForm(request, product))
        .join("")
    : "";
  const selected = request.approvedProductIds
    .map((id) => productsById.get(id))
    .filter((product): product is Product => Boolean(product))
    .map(
      (
        product,
      ) => `<article class="card"><h3>${escapeHtml(product.name)}</h3><p><code>${escapeHtml(product.id)}</code></p>
        <p><a href="/products/${encodeURIComponent(product.id)}/edit">Abrir Product canónico</a></p>
        ${request.origin.kind === "recommendation-slot" ? `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/assign"><input type="hidden" name="productId" value="${escapeHtml(product.id)}"><label><input type="checkbox" name="allowDuplicate" value="yes"> Confirmar duplicado si este Product ya ocupa otro slot.</label><button type="submit">Asignar al slot de origen</button></form>` : ""}
      </article>`,
    )
    .join("");
  const candidateCards = request.sourceCandidates
    .filter(({ status }) => status !== "needs-review")
    .map((candidate) => {
      const linkOptions = sources
        .filter((source) => productsById.get(source.productId)?.status === "active")
        .map(
          (source) =>
            `<option value="${escapeHtml(source.id)}">${escapeHtml(productsById.get(source.productId)!.name)} · ${escapeHtml(source.id)}</option>`,
        )
        .join("");
      return `<article class="card"><div class="actions"><h3>${escapeHtml(candidate.name)}</h3><span class="status">${escapeHtml(candidate.status)}</span></div>
        <p>${escapeHtml(candidate.provider)}${candidate.merchant ? ` · ${escapeHtml(candidate.merchant)}` : ""}${candidate.domain ? ` · ${escapeHtml(candidate.domain)}` : ""}${candidate.marketplace ? ` · ${escapeHtml(candidate.marketplace)}` : ""}${candidate.externalId ? ` · <code>${escapeHtml(candidate.externalId)}</code>` : ""}</p>
        ${candidate.query ? `<p class="muted">Consulta: ${escapeHtml(candidate.query)} · observado ${escapeHtml(formatDate(candidate.observedAt!))}</p>` : ""}
        ${candidate.observedPrice ? `<p>Precio observado: ${escapeHtml(candidate.observedPrice)}</p>` : ""}${candidate.observedRating !== undefined ? `<p>Rating observado: ${candidate.observedRating}${candidate.observedReviewCount !== undefined ? ` · ${candidate.observedReviewCount} reseñas observadas` : ""}</p>` : ""}
        ${candidate.productUrl ? `<p>URL de producto: <code>${escapeHtml(candidate.productUrl)}</code></p>` : ""}
        ${candidate.affiliateUrl ? `<p>URL afiliada: <code>${escapeHtml(candidate.affiliateUrl)}</code></p>` : ""}
        ${candidate.urlWarnings?.length ? `<p class="muted">Advertencias de URL: ${candidate.urlWarnings.map((warning) => escapeHtml(warning)).join(" · ")}</p>` : ""}
        ${candidate.sourceFacts.length ? `<ul>${candidate.sourceFacts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : ""}
        ${activeRequest && candidate.status === "approved-for-intake" ? `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/source-candidates/${encodeURIComponent(candidate.id)}/link"><label>ProductSourceRecord del intake<select name="productSourceId" required><option value="">Elegir</option>${linkOptions}</select></label><button type="submit">Vincular intake revisado</button></form>` : ""}
        ${activeRequest && candidate.status === "approved-for-intake" ? `<p><a href="/products/intake?returnTo=${encodeURIComponent(`/product-sourcing/${request.id}`)}&requestId=${encodeURIComponent(request.id)}&candidateId=${encodeURIComponent(candidate.id)}">Abrir P.1 con esta evidencia observada</a></p>` : ""}
        ${candidate.canonicalProductId ? `<p>Vinculado a <code>${escapeHtml(candidate.canonicalProductId)}</code> mediante <code>${escapeHtml(candidate.productSourceId)}</code>. Esto no cumple la solicitud.</p>` : ""}
      </article>`;
    })
    .join("");
  const pendingCandidateCards = request.sourceCandidates
    .filter(({ status }) => status === "needs-review")
    .map(
      (candidate) =>
        `<article class="card"><h3>${escapeHtml(candidate.name)}</h3><p>${escapeHtml(candidate.provider)}${candidate.merchant ? ` · ${escapeHtml(candidate.merchant)}` : ""}${candidate.externalId ? ` · <code>${escapeHtml(candidate.externalId)}</code>` : ""}</p>${candidate.query ? `<p class="muted">Consulta: ${escapeHtml(candidate.query)} · observado ${escapeHtml(formatDate(candidate.observedAt!))}</p>` : ""}${candidate.productUrl ? `<p>URL de producto: <code>${escapeHtml(candidate.productUrl)}</code></p>` : ""}${candidate.affiliateUrl ? `<p>URL afiliada: <code>${escapeHtml(candidate.affiliateUrl)}</code></p>` : ""}${candidate.observedPrice ? `<p>Precio observado: ${escapeHtml(candidate.observedPrice)}</p>` : ""}${candidate.observedRating !== undefined ? `<p>Rating observado: ${candidate.observedRating}${candidate.observedReviewCount !== undefined ? ` · ${candidate.observedReviewCount} reseñas observadas` : ""}</p>` : ""}${candidate.sourceFacts.length ? `<ul>${candidate.sourceFacts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : ""}${candidate.urlWarnings?.length ? `<p class="muted">Advertencias de URL: ${candidate.urlWarnings.map((warning) => escapeHtml(warning)).join(" · ")}</p>` : ""}<label>Decisión de lote<select name="${escapeHtml(candidate.id)}"><option value="">Sin cambio</option><option value="approved-for-intake">Aprobar para intake</option><option value="rejected">Rechazar</option></select></label></article>`,
    )
    .join("");
  const reviewable =
    activeRequest && request.sourceCandidates.some(({ status }) => status === "needs-review");
  const discoveryHistory = request.discoveryRounds
    .map(
      (round) =>
        `<li>Ronda ${round.round} · ${escapeHtml(round.provider)} · ${escapeHtml(round.status)} · ${round.providerCalls} llamada(s) · ${round.storedCandidateCount} candidato(s) guardado(s)${round.failureCode ? ` · ${escapeHtml(round.failureCode)}` : ""}</li>`,
    )
    .join("");
  const nextRound = request.discoveryRounds.length + 1;
  const discoveryControls = request.searchPlan
    ? `<section class="card wide"><h2>SearchPlan y descubrimiento acotado</h2><dl><dt>Product class</dt><dd>${escapeHtml(request.searchPlan.productClass)}</dd><dt>Must-have</dt><dd>${escapeHtml(request.searchPlan.mustHaveAttributes.join(", ") || "—")}</dd><dt>Useful</dt><dd>${escapeHtml(request.searchPlan.usefulAttributes.join(", ") || "—")}</dd><dt>Exclusiones</dt><dd>${escapeHtml(request.searchPlan.exclusions.join(", ") || "—")}</dd><dt>Consultas</dt><dd>${escapeHtml(request.searchPlan.queries.join(" · "))}</dd></dl>${discoveryHistory ? `<ol>${discoveryHistory}</ol>` : ""}${activeRequest && discoverySource && nextRound <= DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxRounds ? `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/discover"><input type="hidden" name="round" value="${nextRound}"><p>Proveedor pago seleccionado: <strong>${escapeHtml(discoverySource.providerId)}</strong>. Máximo ${DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxQueriesPerSlot} consultas y ${DEFAULT_PRODUCT_DISCOVERY_LIMITS.maxStoredCandidatesPerSlot} candidatos externos guardados por slot.</p><label><input type="checkbox" name="forceExternal" value="yes"> Usar llamadas externas aunque haya coincidencias compatibles en catálogo o candidatos recientes.</label><button type="submit">${nextRound === 1 ? "Ejecutar primera ronda" : "Ejecutar segunda ronda explícita"}</button></form>` : activeRequest && !discoverySource ? '<p class="notice">El proveedor externo está desactivado. Catálogo, URL manual e idea-only siguen disponibles.</p>' : ""}</section>`
    : '<section class="notice"><p>Este requisito todavía no tiene SearchPlan. Seleccionalo en la lista de sourcing para planificar uno o varios slots con una sola solicitud editorial.</p></section>';
  const transitions = (
    request.status === "open"
      ? ["held", "rejected"]
      : request.status === "partially-fulfilled"
        ? ["held", "rejected"]
        : request.status === "held"
          ? ["open", "rejected"]
          : []
  )
    .map(
      (status) =>
        `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/status"><input type="hidden" name="status" value="${status}"><button type="submit">Marcar ${escapeHtml(status)}</button></form>`,
    )
    .join("");
  return page(
    request.requiredCategory,
    `<p><a href="/product-sourcing">← Solicitudes</a></p>
     <div class="actions"><div><h1>${escapeHtml(request.requiredCategory)}</h1><p><code>${escapeHtml(request.id)}</code></p></div><span class="status">${escapeHtml(request.status)}</span></div>
     <p class="notice">Sourcing, candidate review, Product canónico y slot editorial conservan identidades distintas. Ninguna acción publica una guía.</p>
     ${discoveryControls}
     <div class="grid"><section class="card"><h2>Requisito</h2><dl><dt>Origen</dt><dd>${escapeHtml(sourcingOriginLabel(request))}</dd><dt>Rol</dt><dd>${escapeHtml(request.intendedRole)}</dd><dt>Audiencia</dt><dd>${escapeHtml(request.audience)}</dd><dt>Ocasión</dt><dd>${escapeHtml(request.occasion)}</dd><dt>Presupuesto</dt><dd>${escapeHtml(request.budgetContext)}</dd><dt>Búsqueda</dt><dd>${escapeHtml(request.searchTerms.join(", "))}</dd></dl><h3>Datos obligatorios</h3>${request.mustHaveVerifiedFacts.length ? `<ul>${request.mustHaveVerifiedFacts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : '<p class="muted">—</p>'}<h3>Exclusiones</h3>${request.exclusions.length ? `<ul>${request.exclusions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p class="muted">—</p>'}</section>
       <section class="card"><h2>Retorno editorial</h2><p><a class="button" href="${escapeHtml(productSourcingReturnPath(request))}">Volver al requisito de origen</a></p><p>Creado ${escapeHtml(formatDate(request.createdAt))}<br>Actualizado ${escapeHtml(formatDate(request.updatedAt))}</p><div class="actions">${transitions}</div></section></div>
     <h2>Products canónicos seleccionados</h2><div class="grid">${selected || '<p class="notice">Todavía no se seleccionó ningún Product canónico.</p>'}</div>
     <h2>Coincidencias manuales del catálogo</h2><div class="grid">${matches || '<p class="notice">No hay coincidencias deterministas activas.</p>'}</div>
     ${activeRequest ? `<p><a href="/products/intake?returnTo=${encodeURIComponent(`/product-sourcing/${request.id}`)}">Abrir el intake manual y volver a esta solicitud</a></p>` : ""}
     <h2>Candidatos de fuente para revisión</h2>
     ${reviewable ? `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/source-candidates/review"><div class="grid">${pendingCandidateCards}</div><button type="submit">Guardar revisión del lote</button></form>` : ""}
     <div class="grid">${candidateCards || (reviewable ? "" : '<p class="notice">No hay candidatos de fuente.</p>')}</div>
     ${activeRequest ? `<form method="post" action="/product-sourcing/${encodeURIComponent(request.id)}/source-candidates" class="card"><h3>Agregar candidato de fuente</h3><div class="grid"><label>Origen<select name="sourceKind"><option value="manual">Manual</option><option value="amazon-creators-api">Amazon Creators API (si está disponible)</option></select></label><label>Proveedor<input name="provider" required></label><label>Marketplace<input name="marketplace"></label><label>ID externo<input name="externalId"></label><label>Nombre observado<input name="name" required></label><label>URL de fuente<input type="url" name="sourceUrl"></label><label class="wide">Hechos de fuente · uno por línea<textarea name="sourceFacts" rows="3"></textarea></label></div><button type="submit">Agregar para revisión</button></form>` : ""}`,
  );
}

const opportunityScoreLabels: Record<keyof ArticleCandidate["scores"], string> = {
  intentDifferentiation: "Diferenciación de intención",
  editorialUsefulness: "Utilidad editorial",
  productDifferentiation: "Diferenciación de productos",
  audienceClarity: "Claridad de audiencia",
  seasonalValue: "Valor estacional",
  commercialPotential: "Potencial comercial",
  visualDistributionPotential: "Potencial de distribución visual",
  productReusePotential: "Potencial de reutilización de productos",
  thinContentRisk: "Riesgo de contenido débil",
  cannibalizationRisk: "Riesgo de canibalización",
  maintenanceCost: "Costo de mantenimiento",
};

const opportunityDecisionLabels: Record<(typeof CANDIDATE_DECISIONS)[number], string> = {
  "create-article": "Aprobar para brief",
  "add-as-section": "Convertir en sección",
  merge: "Fusionar con contenido existente",
  hold: "Mantener en espera",
  reject: "Rechazar",
};

const opportunityObjectiveLabels: Record<(typeof OPPORTUNITY_SESSION_OBJECTIVES)[number], string> =
  {
    "expand-cluster": "Expandir un cluster",
    "find-missing-intents": "Buscar intenciones faltantes",
    "find-seasonal-opportunities": "Buscar oportunidades estacionales",
    "find-section-opportunities": "Buscar oportunidades de sección",
    "reuse-existing-products": "Reutilizar productos existentes",
    "review-cannibalization": "Revisar posible canibalización",
    "find-localization-candidates": "Buscar candidatos de localización",
  };

const opportunityModeLabels: Record<(typeof OPPORTUNITY_SESSION_MODES)[number], string> = {
  "intent-first": "Desde una intención editorial",
  "product-first": "Desde productos o categorías",
  "coverage-first": "Desde señales deterministas I.0",
};

function opportunityGenerationRequestFromForm(
  form: URLSearchParams,
  regenerationSource?: ArticleCandidate,
) {
  if (form.get("promptVersion") !== OPPORTUNITY_GENERATION_PROMPT_VERSION) {
    throw new TypeError("Revisá el prompt divergente vigente antes de generar.");
  }
  const candidateCount = Number(requiredValue(form, "candidateCount", "La cantidad"));
  if (
    !Number.isInteger(candidateCount) ||
    candidateCount < 1 ||
    candidateCount > MAX_OPPORTUNITY_CANDIDATE_COUNT
  ) {
    throw new TypeError(
      `La cantidad debe ser un entero entre 1 y ${MAX_OPPORTUNITY_CANDIDATE_COUNT}.`,
    );
  }
  const sessionObjective = requiredValue(form, "sessionObjective", "El objetivo de sesión");
  if (!(OPPORTUNITY_SESSION_OBJECTIVES as readonly string[]).includes(sessionObjective)) {
    throw new TypeError("El objetivo de sesión no es válido.");
  }
  const sessionMode = requiredValue(form, "sessionMode", "El modo de sesión");
  if (!(OPPORTUNITY_SESSION_MODES as readonly string[]).includes(sessionMode)) {
    throw new TypeError("El modo de sesión no es válido.");
  }
  return {
    clusterId: regenerationSource?.clusterId ?? requiredValue(form, "clusterId", "El cluster"),
    sessionMode: sessionMode as (typeof OPPORTUNITY_SESSION_MODES)[number],
    sessionObjective: sessionObjective as (typeof OPPORTUNITY_SESSION_OBJECTIVES)[number],
    ...(optionalValue(form, "editorialIntent")
      ? { editorialIntent: optionalValue(form, "editorialIntent") }
      : {}),
    sourceProductIds: form.getAll("sourceProductId"),
    sourceCategoryIds: form.getAll("sourceCategoryId"),
    sourceCoverageSignalIds: form.getAll("sourceCoverageSignalId"),
    candidateCount,
    targetMarket: requiredValue(form, "targetMarket", "El mercado objetivo"),
    language: requiredValue(form, "language", "El idioma"),
    ...(optionalValue(form, "planningHorizon")
      ? { planningHorizon: optionalValue(form, "planningHorizon") }
      : {}),
    ...(regenerationSource ? { regenerateFromCandidateId: regenerationSource.id } : {}),
  };
}

const opportunitySignalLabels: Record<OpportunitySignalKind, string> = {
  "normalized-title": "Título normalizado",
  "slug-tokens": "Tokens del slug",
  "primary-axis": "Eje primario",
  "primary-intent": "Intención primaria",
  taxonomies: "Taxonomías",
  "problem-solved": "Problema resuelto",
  "proposed-sections": "Secciones propuestas",
  "product-categories": "Categorías de producto",
};

const opportunityTargetLabels: Record<OpportunityComparisonTargetKind, string> = {
  "published-cluster": "hub publicado",
  "published-guide": "guía publicada",
  "cluster-draft": "ClusterDraft",
  "guide-draft": "GuideDraft",
  "editorial-brief": "EditorialBrief aprobado",
  "candidate-history": "candidato con decisión previa",
};

function opportunityComparisonCards(
  comparisons: readonly OpportunityComparison[],
  emptyMessage: string,
): string {
  if (!comparisons.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return comparisons
    .map((comparison) => {
      const counts = Object.fromEntries(
        (["low", "medium", "high"] as const).map((level) => [
          level,
          comparison.signals.filter((signal) => signal.level === level).length,
        ]),
      );
      const signals = OPPORTUNITY_SIGNAL_KINDS.map((kind) =>
        comparison.signals.find((signal) => signal.kind === kind),
      )
        .filter((signal) => signal !== undefined)
        .map(
          (signal) =>
            `<li><strong>${escapeHtml(opportunitySignalLabels[signal.kind])} · ${escapeHtml(signal.level)}</strong><br>${escapeHtml(signal.reason)}</li>`,
        )
        .join("");
      const history = comparison.decision
        ? `<p><strong>Decisión previa:</strong> ${escapeHtml(opportunityDecisionLabels[comparison.decision.action])}. ${escapeHtml(comparison.decision.reason)} · ${escapeHtml(formatDate(comparison.decision.decidedAt))}${comparison.decision.targetContentId ? ` · destino <code>${escapeHtml(comparison.decision.targetContentId)}</code>` : ""}</p>`
        : "";
      const evidence = comparison.evidenceChange
        ? comparison.evidenceChange.changed
          ? `<p><strong>Evidencia fuente cambiada:</strong> nuevas ${comparison.evidenceChange.addedSourceSignalIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}; retiradas ${comparison.evidenceChange.removedSourceSignalIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}.</p>`
          : `<p><strong>Sin evidencia fuente cambiada.</strong> IDs compartidos: ${comparison.evidenceChange.sharedSourceSignalIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "ninguno"}.</p>`
        : "";
      return `<article class="card wide">
        <p><span class="status">${escapeHtml(opportunityTargetLabels[comparison.targetKind])}</span>${comparison.status ? ` · ${escapeHtml(comparison.status)}` : ""}</p>
        <h3>${escapeHtml(comparison.title)}</h3>
        <p><code>${escapeHtml(comparison.targetId)}</code> · ${counts.high} high · ${counts.medium} medium · ${counts.low} low</p>
        ${history}${evidence}<ul>${signals}</ul>
      </article>`;
    })
    .join("");
}

function opportunityListPage(
  store: ArticleCandidateStore,
  content: ReturnType<typeof readPublicContent>,
  productCoverage: ProductCoverageAnalysis,
  provider: GuideGenerationProvider,
  briefs: readonly EditorialBrief[],
): string {
  const candidates = store.list();
  const clusterOptions = content.clusters
    .map(
      (cluster) =>
        `<option value="${escapeHtml(cluster.id)}">${escapeHtml(cluster.title)}</option>`,
    )
    .join("");
  const objectiveOptions = OPPORTUNITY_SESSION_OBJECTIVES.map(
    (objective) =>
      `<option value="${objective}">${escapeHtml(opportunityObjectiveLabels[objective])}</option>`,
  ).join("");
  const modeOptions = OPPORTUNITY_SESSION_MODES.map(
    (mode) => `<option value="${mode}">${escapeHtml(opportunityModeLabels[mode])}</option>`,
  ).join("");
  const productOptions = content.products
    .filter(({ status }) => status === "active")
    .map(
      (product) =>
        `<label><input type="checkbox" name="sourceProductId" value="${escapeHtml(product.id)}"> ${escapeHtml(product.name)} <code>${escapeHtml(product.id)}</code></label>`,
    )
    .join("");
  const categoryOptions = opportunityCatalogCategories(content)
    .map(
      (category) =>
        `<label><input type="checkbox" name="sourceCategoryId" value="${escapeHtml(category.id)}"> ${escapeHtml(category.label)} <code>${escapeHtml(category.id)}</code></label>`,
    )
    .join("");
  const coverageOptions = opportunityCoverageSignals(productCoverage)
    .map(
      (signal) =>
        `<label><input type="checkbox" name="sourceCoverageSignalId" value="${escapeHtml(signal.id)}"> ${escapeHtml(signal.summary)} <code>${escapeHtml(signal.id)}</code></label>`,
    )
    .join("");
  const list = candidates.length
    ? `<div class="grid">${candidates
        .map(
          (candidate) => `<article class="card">
            <p><span class="status">${escapeHtml(candidate.status)}</span> · <code>${escapeHtml(candidate.clusterId)}</code></p>
            ${candidate.sessionMode ? `<p>${escapeHtml(opportunityModeLabels[candidate.sessionMode])}</p>` : ""}
            <h2><a href="/opportunities/${encodeURIComponent(candidate.id)}">${escapeHtml(candidate.proposedTitle)}</a></h2>
            <p>${escapeHtml(candidate.primaryIntent)}</p>
            <p class="muted"><code>${escapeHtml(candidate.id)}</code> · actualizado ${escapeHtml(formatDate(candidate.updatedAt))}</p>
          </article>`,
        )
        .join("")}</div>`
    : '<p class="notice">Todavía no hay oportunidades guardadas.</p>';
  const evaluationChoices = candidates
    .filter(({ status }) => status === "generated")
    .map(
      (candidate) =>
        `<label><input type="checkbox" name="candidateId" value="${escapeHtml(candidate.id)}"> ${escapeHtml(candidate.proposedTitle)} <code>${escapeHtml(candidate.id)}</code></label>`,
    )
    .join("");
  const briefList = briefs.length
    ? `<div class="grid">${briefs
        .map(
          (brief) => `<article class="card">
            <p><span class="status">${escapeHtml(brief.status)}</span> · <code>${escapeHtml(brief.clusterId)}</code></p>
            <h3><a href="/opportunities/briefs/${encodeURIComponent(brief.id)}">${escapeHtml(brief.workingTitle)}</a></h3>
            <p class="muted"><code>${escapeHtml(brief.id)}</code> · candidato <code>${escapeHtml(brief.sourceCandidateId)}</code></p>
          </article>`,
        )
        .join("")}</div>`
    : '<p class="muted">Todavía no hay briefs editoriales.</p>';
  return page(
    "Oportunidades de contenido",
    `<h1>Oportunidades de contenido</h1>
     <p>Los candidatos registran análisis editorial previo. No son briefs, GuideDrafts ni contenido público.</p>
     <p class="notice">Los puntajes son ayudas editoriales independientes de 0 a 10; no son métricas SEO objetivas ni se suman en un ranking.</p>
     <section class="card wide">
       <h2>Generación divergente</h2>
       <p>El proveedor propone hipótesis editoriales. El Studio asigna IDs y slugs, ejecuta la comparación determinista y guarda los candidatos como <code>generated</code>, sin evaluarlos ni decidir por ellos.</p>
       <p class="muted">Proveedor: ${escapeHtml(provider.providerId)}${provider.modelId ? ` · ${escapeHtml(provider.modelId)}` : ""}. Los valores 0 de candidatos generados significan “sin evaluar”.</p>
       <form method="post" action="/opportunities/generate">
         <input type="hidden" name="promptVersion" value="${OPPORTUNITY_GENERATION_PROMPT_VERSION}">
         <label>Cluster<select name="clusterId" required>${clusterOptions}</select></label>
         <label>Modo de sesión<select name="sessionMode" required>${modeOptions}</select></label>
         <label>Objetivo de sesión<select name="sessionObjective" required>${objectiveOptions}</select></label>
         <label>Intención editorial (obligatoria para intent-first)<textarea name="editorialIntent" rows="3" placeholder="Audiencia, problema, ocasión o intención concreta"></textarea></label>
         <details><summary>Fuentes product-first</summary><fieldset class="checks"><legend>Productos activos</legend>${productOptions}</fieldset><fieldset class="checks"><legend>Categorías activas</legend>${categoryOptions}</fieldset></details>
         <details><summary>Fuentes coverage-first</summary><fieldset class="checks"><legend>Señales deterministas I.0</legend>${coverageOptions || '<p class="muted">I.0 no produjo señales seleccionables.</p>'}</fieldset></details>
         <label>Cantidad<input type="number" name="candidateCount" min="1" max="${MAX_OPPORTUNITY_CANDIDATE_COUNT}" value="${DEFAULT_OPPORTUNITY_CANDIDATE_COUNT}" required></label>
         <label>Mercado objetivo<input name="targetMarket" value="US" required></label>
         <label>Idioma<input name="language" value="en-US" required></label>
         <label>Horizonte de planificación (opcional)<input name="planningHorizon" placeholder="Próximos 6 meses"></label>
         <button type="submit">Generar candidatos</button>
       </form>
       <p class="muted">Los productos y las brechas son insumos, no justificación automática de una URL. Esta etapa no acepta métricas externas ni crea briefs, borradores o publicaciones.</p>
     </section>
     <section class="card wide">
       <h2>Evaluación convergente</h2>
       <p>Seleccioná candidatos <code>generated</code> para evaluarlos juntos. La IA interpreta la evidencia determinista e importada, pero sólo puede moverlos a <code>evaluated</code>.</p>
       <form method="post" action="/opportunities/evaluate">
         <input type="hidden" name="promptVersion" value="${OPPORTUNITY_EVALUATION_PROMPT_VERSION}">
         <fieldset class="checks"><legend>Candidatos</legend>${evaluationChoices || '<p class="muted">No hay candidatos pendientes de evaluación.</p>'}</fieldset>
         <fieldset><legend>Señal importada opcional</legend>
           <label>ID estable<input name="signalId" placeholder="signal_..."></label>
           <label>Fuente<input name="signalSource" placeholder="Exportación manual"></label>
           <label>Desde<input type="date" name="signalFrom"></label>
           <label>Hasta<input type="date" name="signalTo"></label>
           <label>Resumen<textarea name="signalSummary" rows="3"></textarea></label>
         </fieldset>
         <button type="submit"${evaluationChoices ? "" : " disabled"}>Evaluar selección</button>
       </form>
       <p class="muted">La fuente y el rango de fechas se conservan; ausencia de datos no equivale a cero. Shortlist y decisiones posteriores siguen siendo humanas.</p>
     </section>
     <h2>Candidatos guardados</h2>
     ${list}
     <h2>Briefs editoriales</h2>
     ${briefList}`,
  );
}

function opportunityDetailPage(
  candidate: ArticleCandidate,
  comparison: OpportunityComparisonReport,
  evaluation?: OpportunityEvaluationSession,
): string {
  const taxonomies = Object.entries(candidate.secondaryTaxonomies)
    .map(
      ([name, values]) =>
        `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(values?.join(", ") ?? "—")}</dd>`,
    )
    .join("");
  const sections = candidate.proposedSections
    .map(
      (section) =>
        `<li><strong>${escapeHtml(section.heading)}</strong>: ${escapeHtml(section.purpose)}</li>`,
    )
    .join("");
  const overlaps = candidate.overlapSignals.length
    ? `<ul>${candidate.overlapSignals
        .map(
          (signal) =>
            `<li><code>${escapeHtml(signal.contentId)}</code> · ${escapeHtml(signal.kind)} · ${escapeHtml(signal.level)}: ${escapeHtml(signal.reason)}</li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No se registraron señales de solapamiento.</p>';
  const scores = (Object.entries(candidate.scores) as [keyof ArticleCandidate["scores"], number][])
    .map(
      ([name, score]) =>
        `<dt>${escapeHtml(opportunityScoreLabels[name])}</dt><dd>${score} / 10</dd>`,
    )
    .join("");
  const aiJudgment = evaluation?.aiJudgment.evaluations.find(
    ({ candidateId }) => candidateId === candidate.id,
  );
  const importedEvidence = evaluation?.importedSignals.length
    ? `<ul>${evaluation.importedSignals
        .map(
          (signal) =>
            `<li><code>${escapeHtml(signal.id)}</code> · ${escapeHtml(signal.source)} · ${escapeHtml(signal.dateRange.from)}–${escapeHtml(signal.dateRange.to)}<br>${escapeHtml(signal.summary)}</li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No se suministraron señales importadas.</p>';
  const missingEvidence = aiJudgment?.missingEvidence.length
    ? `<ul>${aiJudgment.missingEvidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : '<p class="muted">La IA no marcó evidencia faltante.</p>';
  const deterministicEvidence = evaluation
    ? `<section class="card"><h2>Evidencia determinista</h2><p class="notice">Señales derivadas por el sistema; no son razonamiento de IA.</p><dl><dt>Comparaciones 5.1</dt><dd>${comparison.nearestEditorialState.length} estados editoriales · ${comparison.priorDecisionHistory.length} decisiones previas</dd><dt>Cobertura I.0</dt><dd>${evaluation.productCoverage.catalogHealth.substantialCategories.length} categorías sustanciales · ${evaluation.productCoverage.catalogHealth.singleProductCategories.length} categorías de un producto · ${evaluation.productCoverage.catalogHealth.activeProductsUnused.length} productos activos sin uso · ${evaluation.productCoverage.catalogHealth.productsReusedAcrossGuides.length} productos con reutilización alta</dd></dl></section>`
    : "";
  const evaluationAid = aiJudgment
    ? `${deterministicEvidence}<section class="card"><h2>Juicio de IA</h2><p class="notice">Interpretación consultiva, no evidencia observada ni decisión.</p><dl>${scores}</dl><h3>Riesgos de producto</h3><p><strong>Concentración:</strong> ${escapeHtml(aiJudgment.productConcentrationRisk)}</p><p><strong>Volatilidad del catálogo:</strong> ${escapeHtml(aiJudgment.catalogVolatility)}</p><h3>Recomendación</h3><p><strong>${escapeHtml(opportunityDecisionLabels[aiJudgment.recommendation])}</strong>${aiJudgment.targetContentId ? ` · <code>${escapeHtml(aiJudgment.targetContentId)}</code>` : ""}</p><p>${escapeHtml(aiJudgment.explanation)}</p>${aiJudgment.thinContentRiskAction ? `<p><strong>Acción por contenido débil:</strong> ${escapeHtml(aiJudgment.thinContentRiskAction)}</p>` : ""}${aiJudgment.cannibalizationRiskAction ? `<p><strong>Acción por canibalización:</strong> ${escapeHtml(aiJudgment.cannibalizationRiskAction)}</p>` : ""}<h3>Evidencia faltante</h3>${missingEvidence}<h3>Síntesis del lote</h3><p>${escapeHtml(evaluation!.aiJudgment.batchSynthesis)}</p></section>
       <section class="card"><h2>Señales importadas</h2><p class="notice">Evidencia factual importada con procedencia y rango de fechas.</p>${importedEvidence}</section>`
    : `<section class="card"><h2>Ayuda editorial guardada</h2><p class="notice">Sin una sesión convergente registrada. Los ceros de candidatos generados significan “sin evaluar”.</p><dl>${scores}</dl><h3>Recomendación consultiva</h3><p><strong>${escapeHtml(opportunityDecisionLabels[candidate.advisory.recommendation])}</strong></p><p>${escapeHtml(candidate.advisory.reason)}</p></section>`;
  const decision = candidate.decision
    ? `<dl><dt>Decisión</dt><dd>${escapeHtml(opportunityDecisionLabels[candidate.decision.action])}</dd><dt>Razón</dt><dd>${escapeHtml(candidate.decision.reason)}</dd><dt>Fecha</dt><dd>${escapeHtml(formatDate(candidate.decision.decidedAt))}</dd>${candidate.decision.targetContentId ? `<dt>Contenido destino</dt><dd><code>${escapeHtml(candidate.decision.targetContentId)}</code></dd>` : ""}</dl>`
    : '<p class="muted">Todavía no hay una decisión humana.</p>';
  const transitions = candidateStatusTransitions(candidate.status)
    .map(
      (status) =>
        `<button type="submit" name="status" value="${escapeHtml(status)}">Marcar ${escapeHtml(status)}</button>`,
    )
    .join("");
  const decisionOptions = CANDIDATE_DECISIONS.map(
    (action) =>
      `<option value="${action}">${escapeHtml(opportunityDecisionLabels[action])}</option>`,
  ).join("");
  const decisionForm =
    candidate.status === "evaluated" || candidate.status === "shortlisted"
      ? `<section class="card"><h2>Decisión humana</h2>
          <form method="post" action="/opportunities/${encodeURIComponent(candidate.id)}/decision">
            <label>Decisión<select name="action" required>${decisionOptions}</select></label>
            <label>Razón<textarea name="reason" rows="4" required></textarea></label>
            <label>ID de guía destino (sólo sección o fusión)<input name="targetContentId" placeholder="guide_..."></label>
            <button type="submit">Guardar decisión</button>
          </form></section>`
      : "";
  const regenerationSources = [
    ...(candidate.sessionMode === "product-first" ? (candidate.sourceProductIds ?? []) : []).map(
      (id) => `<input type="hidden" name="sourceProductId" value="${escapeHtml(id)}">`,
    ),
    ...(candidate.sessionMode === "product-first" ? (candidate.sourceCategoryIds ?? []) : []).map(
      (id) => `<input type="hidden" name="sourceCategoryId" value="${escapeHtml(id)}">`,
    ),
    ...(candidate.sessionMode === "coverage-first"
      ? (candidate.sourceCoverageSignalIds ?? [])
      : []
    ).map((id) => `<input type="hidden" name="sourceCoverageSignalId" value="${escapeHtml(id)}">`),
  ].join("");
  const regenerationForm =
    candidate.status === "generated"
      ? ""
      : `<section class="card"><h2>Regenerar alternativas</h2>
          <p class="muted">Crea una nueva sesión divergente enlazada a esta oportunidad y a su sesión de origen. No cambia la decisión humana.</p>
          <form method="post" action="/opportunities/${encodeURIComponent(candidate.id)}/regenerate">
            <input type="hidden" name="promptVersion" value="${OPPORTUNITY_GENERATION_PROMPT_VERSION}">
            <input type="hidden" name="sessionMode" value="${escapeHtml(candidate.sessionMode ?? "intent-first")}">
            <input type="hidden" name="editorialIntent" value="${escapeHtml(candidate.primaryIntent)}">
            ${regenerationSources}
            <label>Objetivo<select name="sessionObjective">${OPPORTUNITY_SESSION_OBJECTIVES.map((objective) => `<option value="${objective}">${escapeHtml(opportunityObjectiveLabels[objective])}</option>`).join("")}</select></label>
            <label>Cantidad<input type="number" name="candidateCount" min="1" max="${MAX_OPPORTUNITY_CANDIDATE_COUNT}" value="5" required></label>
            <label>Mercado<input name="targetMarket" value="US" required></label>
            <label>Idioma<input name="language" value="en-US" required></label>
            <label>Horizonte (opcional)<input name="planningHorizon"></label>
            <button type="submit">Regenerar alternativas</button>
          </form></section>`;
  const contractViolations = comparison.publicContractViolations.length
    ? `<ul>${comparison.publicContractViolations.map((violation) => `<li>${escapeHtml(violation)}</li>`).join("")}</ul>`
    : '<p class="muted">No se detectaron violaciones del contrato público.</p>';

  return page(
    candidate.proposedTitle,
    `<p><a href="/opportunities">← Volver a oportunidades</a></p>
     <div class="actions"><h1>${escapeHtml(candidate.proposedTitle)}</h1><span class="status">${escapeHtml(candidate.status)}</span></div>
     <p><code>${escapeHtml(candidate.id)}</code> · cluster <code>${escapeHtml(candidate.clusterId)}</code> · slug propuesto <code>${escapeHtml(candidate.proposedSlug)}</code></p>
     ${transitions ? `<form class="actions" method="post" action="/opportunities/${encodeURIComponent(candidate.id)}/status">${transitions}</form>` : ""}
     <div class="grid">
       <section class="card"><h2>Intención</h2><dl><dt>Eje</dt><dd>${escapeHtml(candidate.primaryAxis)}</dd><dt>Intención primaria</dt><dd>${escapeHtml(candidate.primaryIntent)}</dd><dt>Problema resuelto</dt><dd>${escapeHtml(candidate.problemSolved)}</dd><dt>Audiencia</dt><dd>${escapeHtml(candidate.targetAudience)}</dd></dl></section>
       <section class="card"><h2>Taxonomías secundarias</h2><dl>${taxonomies || "<dt>Valores</dt><dd>—</dd>"}</dl></section>
       <section class="card wide"><h2>Secciones propuestas</h2><ol>${sections}</ol><h3>Categorías de producto distintivas</h3><p>${escapeHtml(candidate.distinctiveProductCategories.join(", ") || "—")}</p>${candidate.differentiation ? `<h3>Diferenciación</h3><p>${escapeHtml(candidate.differentiation)}</p>` : ""}${candidate.maintenanceImplications ? `<h3>Implicaciones de mantenimiento</h3><p>${escapeHtml(candidate.maintenanceImplications)}</p>` : ""}<h3>Requisitos de producto</h3><p>${escapeHtml(candidate.productRequirements?.join(", ") || "—")}</p><h3>Brechas de catálogo propuestas</h3><p>${escapeHtml(candidate.catalogGaps?.join(", ") || "Ninguna identificada")}</p></section>
       <section class="card"><h2>Contenido cercano</h2><p>${candidate.closestExistingContentIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}</p><h3>Señales de solapamiento</h3>${overlaps}</section>
       ${evaluationAid}
       <section class="card"><h2>Decisión humana</h2>${decision}<p class="muted">Puede contradecir la recomendación de IA; no se ejecuta automáticamente.</p></section>
       <section class="card"><h2>Trazabilidad</h2><dl><dt>Modo</dt><dd>${candidate.sessionMode ? escapeHtml(opportunityModeLabels[candidate.sessionMode]) : "—"}</dd><dt>Sesión de generación</dt><dd>${candidate.generationSessionId ? `<code>${escapeHtml(candidate.generationSessionId)}</code>` : "—"}</dd><dt>Productos fuente</dt><dd>${candidate.sourceProductIds?.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}</dd><dt>Categorías fuente</dt><dd>${candidate.sourceCategoryIds?.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}</dd><dt>Señales I.0 fuente</dt><dd>${candidate.sourceCoverageSignalIds?.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}</dd><dt>Regenerada desde</dt><dd>${candidate.regeneratedFromCandidateId ? `<code>${escapeHtml(candidate.regeneratedFromCandidateId)}</code>${candidate.regeneratedFromSessionId ? ` · <code>${escapeHtml(candidate.regeneratedFromSessionId)}</code>` : ""}` : "—"}</dd><dt>Señales importadas</dt><dd>${candidate.sourceSignalIds?.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "—"}</dd><dt>EditorialBrief</dt><dd>${candidate.editorialBriefId ? `<a href="/opportunities/briefs/${encodeURIComponent(candidate.editorialBriefId)}"><code>${escapeHtml(candidate.editorialBriefId)}</code></a>` : "—"}</dd><dt>GuideDraft</dt><dd>${candidate.guideDraftId ? `<a href="/drafts/${encodeURIComponent(candidate.guideDraftId)}"><code>${escapeHtml(candidate.guideDraftId)}</code></a>` : "—"}</dd></dl><p class="muted">Cada referencia conserva un ciclo de vida separado; sólo la decisión humana de crear artículo inicia un brief.</p></section>
     </div>
     <section><h2>Comparación determinista</h2><p class="notice">Las ocho señales se mantienen separadas y explican sus coincidencias. El orden usa solamente la cantidad visible de señales high y medium; no existe un puntaje total ni una decisión automática.</p></section>
     <section class="card"><h2>Violaciones del contrato público</h2>${contractViolations}<p class="muted">Estas violaciones son independientes del solapamiento consultivo.</p></section>
     <section><h2>Estado editorial más cercano</h2><div class="grid">${opportunityComparisonCards(comparison.nearestEditorialState, "No hay páginas, borradores ni briefs aprobados para comparar.")}</div></section>
     <section><h2>Decisiones anteriores comparables</h2><div class="grid">${opportunityComparisonCards(comparison.priorDecisionHistory, "No hay candidatos rechazados, fusionados, mantenidos en espera ni convertidos en sección.")}</div></section>
     ${decisionForm}${regenerationForm}`,
  );
}

function briefLineValues(form: URLSearchParams, name: string): string[] {
  return listValue(form, name, "\n") ?? [];
}

function briefSectionsValue(form: URLSearchParams): EditorialBrief["plannedSections"] {
  return briefLineValues(form, "plannedSections").map((line, index) => {
    const separator = line.indexOf("|");
    if (separator < 1 || separator === line.length - 1) {
      throw new TypeError(`La sección ${index + 1} debe usar el formato "Título | propósito".`);
    }
    return { heading: line.slice(0, separator).trim(), purpose: line.slice(separator + 1).trim() };
  });
}

function editorialBriefEditsFromForm(form: URLSearchParams): EditorialBriefEdits {
  return {
    workingTitle: requiredValue(form, "workingTitle", "El título de trabajo"),
    proposedSlug: requiredValue(form, "proposedSlug", "El slug propuesto"),
    primaryAxis: primaryAxisValue(form, "primaryAxis"),
    primaryIntent: requiredValue(form, "primaryIntent", "La intención primaria"),
    targetAudience: requiredValue(form, "targetAudience", "La audiencia"),
    problemSolved: requiredValue(form, "problemSolved", "El problema resuelto"),
    differentiation: requiredValue(form, "differentiation", "La diferenciación"),
    plannedSections: briefSectionsValue(form),
    productRequirements: briefLineValues(form, "productRequirements"),
    researchQuestions: briefLineValues(form, "researchQuestions"),
    expectedInternalLinks: listValue(form, "expectedInternalLinks") ?? [],
    relatedContentIds: listValue(form, "relatedContentIds") ?? [],
    editorialEvidenceNotes: briefLineValues(form, "editorialEvidenceNotes"),
    risks: briefLineValues(form, "risks"),
  };
}

function briefPage(
  brief: EditorialBrief,
  sourcingRequests: readonly ProductSourcingRequest[] = [],
): string {
  const itemList = (items: readonly string[]) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : '<p class="muted">—</p>';
  const axisOptions = PRIMARY_AXES.map(
    (axis) =>
      `<option value="${axis}"${brief.primaryAxis === axis ? " selected" : ""}>${escapeHtml(axisLabels[axis])}</option>`,
  ).join("");
  const editForm =
    brief.status === "draft"
      ? `<section class="card wide"><h2>Brief editable</h2>
          <form method="post" action="/opportunities/briefs/${encodeURIComponent(brief.id)}">
            <label>Título de trabajo<input name="workingTitle" value="${escapeHtml(brief.workingTitle)}" required></label>
            <label>Slug propuesto<input name="proposedSlug" value="${escapeHtml(brief.proposedSlug)}" required></label>
            <label>Eje primario<select name="primaryAxis">${axisOptions}</select></label>
            <label>Intención primaria<textarea name="primaryIntent" rows="2" required>${escapeHtml(brief.primaryIntent)}</textarea></label>
            <label>Audiencia<textarea name="targetAudience" rows="2" required>${escapeHtml(brief.targetAudience)}</textarea></label>
            <label>Problema<textarea name="problemSolved" rows="2" required>${escapeHtml(brief.problemSolved)}</textarea></label>
            <label>Diferenciación<textarea name="differentiation" rows="3" required>${escapeHtml(brief.differentiation)}</textarea></label>
            <label>Secciones · una por línea: Título | propósito<textarea name="plannedSections" rows="7" required>${escapeHtml(brief.plannedSections.map(({ heading, purpose }) => `${heading} | ${purpose}`).join("\n"))}</textarea></label>
            <label>Requisitos de producto · uno por línea<textarea name="productRequirements" rows="5">${escapeHtml(brief.productRequirements.join("\n"))}</textarea></label>
            <label>Preguntas de investigación · una por línea<textarea name="researchQuestions" rows="5">${escapeHtml(brief.researchQuestions.join("\n"))}</textarea></label>
            <label>Links internos esperados · IDs separados por coma<input name="expectedInternalLinks" value="${escapeHtml(brief.expectedInternalLinks.join(", "))}"></label>
            <label>Contenido relacionado · IDs separados por coma<input name="relatedContentIds" value="${escapeHtml(brief.relatedContentIds.join(", "))}"></label>
            <label>Notas editoriales de evidencia · una por línea<textarea name="editorialEvidenceNotes" rows="4">${escapeHtml(brief.evidenceNotes.editorial.join("\n"))}</textarea></label>
            <label>Riesgos · uno por línea<textarea name="risks" rows="4">${escapeHtml(brief.risks.join("\n"))}</textarea></label>
            <button type="submit">Guardar brief</button>
          </form>
          <form method="post" action="/opportunities/briefs/${encodeURIComponent(brief.id)}/approve"><button type="submit">Aprobar brief</button></form>
        </section>`
      : "";
  const nextAction =
    brief.status === "approved"
      ? `<form method="post" action="/opportunities/briefs/${encodeURIComponent(brief.id)}/convert"><button type="submit">Crear GuideDraft</button></form><p class="muted">La conversión crea un borrador común en estado questionnaire; no selecciona productos ni publica.</p>`
      : brief.guideDraftId
        ? `<p><a class="button" href="/drafts/${encodeURIComponent(brief.guideDraftId)}">Abrir GuideDraft</a></p>`
        : "";
  const evidence = (
    [
      ["Determinista", brief.evidenceNotes.deterministic],
      ["Observada/importada", brief.evidenceNotes.observed],
      ["Interpretación de IA", brief.evidenceNotes.aiInterpretation],
      ["Notas editoriales", brief.evidenceNotes.editorial],
    ] as const
  )
    .map(
      ([label, notes]) =>
        `<h3>${label}</h3>${notes.length ? `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : '<p class="muted">—</p>'}`,
    )
    .join("");
  const briefRequests = sourcingRequests.filter(
    ({ origin }) => origin.kind === "brief" && origin.briefId === brief.id,
  );
  const sourcing = `<section class="card wide"><h2>Sourcing de requisitos de producto</h2>
    <p>La solicitud conserva el requisito editorial; un Product sólo vuelve después de una selección explícita en el flujo de sourcing.</p>
    ${briefRequests.length ? `<ul>${briefRequests.map((request) => `<li><a href="/product-sourcing/${encodeURIComponent(request.id)}">${escapeHtml(request.requiredCategory)}</a> · <code>${escapeHtml(request.id)}</code> · ${escapeHtml(request.status)}</li>`).join("")}</ul>` : '<p class="muted">No hay solicitudes vinculadas.</p>'}
    ${brief.productRequirements
      .map(
        (requirement) =>
          `<form method="post" action="/product-sourcing" class="card"><h3>${escapeHtml(requirement)}</h3><input type="hidden" name="originKind" value="brief"><input type="hidden" name="briefId" value="${escapeHtml(brief.id)}"><input type="hidden" name="intendedRole" value="${escapeHtml(requirement)}"><input type="hidden" name="requiredCategory" value="${escapeHtml(requirement)}"><input type="hidden" name="audience" value="${escapeHtml(brief.targetAudience)}"><input type="hidden" name="searchTerms" value="${escapeHtml(requirement)}"><div class="grid"><label>Ocasión<input name="occasion" required></label><label>Contexto de presupuesto<input name="budgetContext" required></label><label class="wide">Datos verificados obligatorios · uno por línea<textarea name="mustHaveVerifiedFacts" rows="2"></textarea></label><label class="wide">Exclusiones · una por línea<textarea name="exclusions" rows="2"></textarea></label></div><button type="submit">Crear solicitud para este requisito</button></form>`,
      )
      .join("")}
  </section>`;
  return page(
    brief.workingTitle,
    `<p><a href="/opportunities/${encodeURIComponent(brief.sourceCandidateId)}">← Volver a la oportunidad</a></p>
     <div class="actions"><h1>${escapeHtml(brief.workingTitle)}</h1><span class="status">${escapeHtml(brief.status)}</span></div>
     <p><code>${escapeHtml(brief.id)}</code> · candidato <code>${escapeHtml(brief.sourceCandidateId)}</code> · cluster <code>${escapeHtml(brief.clusterId)}</code></p>
     <div class="grid">
       <section class="card"><h2>Decisión humana</h2><p>${escapeHtml(brief.evidenceNotes.humanDecision)}</p></section>
       <section class="card"><h2>Trazabilidad</h2><dl><dt>Creado</dt><dd>${escapeHtml(formatDate(brief.createdAt))}</dd><dt>Aprobado</dt><dd>${brief.approvedAt ? escapeHtml(formatDate(brief.approvedAt)) : "—"}</dd><dt>Convertido</dt><dd>${brief.convertedAt ? escapeHtml(formatDate(brief.convertedAt)) : "—"}</dd><dt>GuideDraft</dt><dd>${brief.guideDraftId ? `<code>${escapeHtml(brief.guideDraftId)}</code>` : "—"}</dd></dl>${nextAction}</section>
       <section class="card wide"><h2>Plan editorial</h2><dl><dt>Slug</dt><dd><code>${escapeHtml(brief.proposedSlug)}</code></dd><dt>Eje</dt><dd>${escapeHtml(brief.primaryAxis)}</dd><dt>Intención</dt><dd>${escapeHtml(brief.primaryIntent)}</dd><dt>Audiencia</dt><dd>${escapeHtml(brief.targetAudience)}</dd><dt>Problema</dt><dd>${escapeHtml(brief.problemSolved)}</dd><dt>Diferenciación</dt><dd>${escapeHtml(brief.differentiation)}</dd></dl><h3>Secciones</h3><ol>${brief.plannedSections.map(({ heading, purpose }) => `<li><strong>${escapeHtml(heading)}</strong>: ${escapeHtml(purpose)}</li>`).join("")}</ol><h3>Requisitos de producto</h3>${itemList(brief.productRequirements)}<h3>Preguntas de investigación</h3>${itemList(brief.researchQuestions)}<h3>Links internos esperados</h3>${itemList(brief.expectedInternalLinks)}<h3>Contenido relacionado</h3>${itemList(brief.relatedContentIds)}<h3>Riesgos</h3>${itemList(brief.risks)}</section>
       ${sourcing}
       <section class="card wide"><h2>Evidencia separada</h2>${evidence}</section>
     </div>
     ${editForm}`,
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function draftName(draft: EditorialDraft): string {
  return draft.title ?? (draft.draftType === "cluster-hub" ? "Nuevo hub" : "Nueva guía");
}

function draftListItem(draft: EditorialDraft): string {
  const type = draft.draftType === "cluster-hub" ? "Hub de cluster" : "Guía de regalos";
  return `<article class="card">
    <p class="muted">${type} · ${escapeHtml(draft.status)}</p>
    <h2><a href="/drafts/${encodeURIComponent(draft.id)}">${escapeHtml(draftName(draft))}</a></h2>
    <p><code>${escapeHtml(draft.id)}</code></p>
    <p class="muted">Actualizado ${escapeHtml(formatDate(draft.updatedAt))}</p>
  </article>`;
}

async function home(store: DraftStore): Promise<string> {
  const { drafts, errors } = await store.list();
  const errorHtml = errors.map((error) => `<p class="error">${escapeHtml(error)}</p>`).join("");
  const list = drafts.length
    ? `<div class="grid">${drafts.map(draftListItem).join("")}</div>`
    : '<p class="notice">Todavía no hay borradores locales.</p>';
  return page(
    "Borradores",
    `<h1>Borradores editoriales</h1>
     <p>Trabajá en español. El contenido publicado de esta etapa se escribe en inglés estadounidense.</p>
     <p class="muted">Los borradores viven sólo en <code>drafts/</code>. Publicar más adelante creará o actualizará archivos versionados del repositorio.</p>
     <p><a class="button" href="/drafts/new">Crear borrador</a></p>
     ${errorHtml}${list}`,
  );
}

function newDraftPage(): string {
  const content = readPublicContent();
  const clusterOptions = content.clusters
    .map(
      (cluster) =>
        `<option value="${escapeHtml(cluster.id)}">${escapeHtml(cluster.title)}</option>`,
    )
    .join("");
  const axisOptions = PRIMARY_AXES.map(
    (axis) => `<option value="${axis}">${escapeHtml(axisLabels[axis])}</option>`,
  ).join("");
  const reopenClusters = content.clusters
    .map(
      (cluster) =>
        `<li><form method="post" action="/drafts/reopen/cluster/${escapeHtml(cluster.id)}" class="actions"><span>${escapeHtml(cluster.title)} <code>${escapeHtml(cluster.id)}</code></span><button type="submit">Reabrir hub</button></form></li>`,
    )
    .join("");
  const reopenGuides = content.guides
    .map(
      (guide) =>
        `<li><form method="post" action="/drafts/reopen/guide/${escapeHtml(guide.id)}" class="actions"><span>${escapeHtml(guide.title)} <code>${escapeHtml(guide.id)}</code></span><button type="submit">Reabrir guía</button></form></li>`,
    )
    .join("");

  return page(
    "Crear borrador",
    `<h1>Crear borrador</h1>
     <p class="notice">El ID estable se asigna una sola vez y no se edita. Cambiar el slug después no cambia ese ID ni el nombre del archivo canónico.</p>
     <div class="grid">
       <section class="card">
         <h2>Nuevo hub de cluster</h2>
         <form method="post" action="/drafts/cluster">
           <label>Título inicial (opcional)<input name="title" autocomplete="off"></label>
           <label>Slug inicial (opcional)<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off"></label>
           <button type="submit">Crear hub</button>
         </form>
       </section>
       <section class="card">
         <h2>Nueva guía de regalos</h2>
         <form method="post" action="/drafts/guide">
           <label>Título inicial (opcional)<input name="title" autocomplete="off"></label>
           <label>Cluster inicial (opcional)<select name="clusterId"><option value="">Sin elegir</option>${clusterOptions}</select></label>
           <label>Slug inicial (opcional)<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off"></label>
           <label>Eje principal inicial (opcional)<select name="primaryAxis"><option value="">Sin elegir</option>${axisOptions}</select></label>
           <label>Intención principal (opcional)<textarea name="primaryIntent" rows="3"></textarea></label>
           <button type="submit">Crear guía</button>
         </form>
       </section>
     </div>
     <section class="card">
       <h2>Reabrir un hub publicado</h2>
       <p>Se conserva el ID estable y se crea o recupera su borrador local.</p>
       <ul>${reopenClusters}</ul>
     </section>
     <section class="card">
       <h2>Reabrir una guía publicada</h2>
       <p>Se conserva el ID, la selección de productos y la copia editorial publicada.</p>
       <ul>${reopenGuides}</ul>
     </section>`,
  );
}

function clusterEditorPage(draft: ClusterDraft): string {
  const content = readPublicContent();
  const guides = content.guides.filter((guide) => guide.clusterId === draft.id);
  const guidesById = new Map(guides.map((guide) => [guide.id, guide]));
  const groups = draft.navigationGroups
    .map((group, groupIndex) => {
      const axisOptions = PRIMARY_AXES.map(
        (axis) =>
          `<option value="${axis}"${axis === group.axis ? " selected" : ""}>${escapeHtml(axisLabels[axis])}</option>`,
      ).join("");
      const guideRows = group.guideIds
        .map((guideId, guideIndex) => {
          const guide = guidesById.get(guideId);
          return `<li>
            <strong>${escapeHtml(guide?.title ?? guideId)}</strong>
            <div class="actions">
              <form method="post" action="/drafts/${draft.id}/groups/${group.id}/guides/${guideId}/up"><button type="submit"${guideIndex === 0 ? " disabled" : ""}>Subir</button></form>
              <form method="post" action="/drafts/${draft.id}/groups/${group.id}/guides/${guideId}/down"><button type="submit"${guideIndex === group.guideIds.length - 1 ? " disabled" : ""}>Bajar</button></form>
              <form method="post" action="/drafts/${draft.id}/groups/${group.id}/guides/${guideId}/remove"><button type="submit">Quitar</button></form>
            </div>
          </li>`;
        })
        .join("");
      const availableGuides = guides.filter((guide) => !group.guideIds.includes(guide.id));
      const addGuideForm = availableGuides.length
        ? `<form method="post" action="/drafts/${draft.id}/groups/${group.id}/guides" class="actions">
            <label>Agregar guía publicada<select name="guideId" required>${availableGuides.map((guide) => `<option value="${guide.id}">${escapeHtml(guide.title)}</option>`).join("")}</select></label>
            <button type="submit">Agregar</button>
          </form>`
        : '<p class="muted">No hay más guías publicadas de este cluster para agregar.</p>';
      return `<section class="card">
        <div class="actions"><h3>Grupo ${groupIndex + 1}</h3><span><code>${escapeHtml(group.id)}</code></span></div>
        <form method="post" action="/drafts/${draft.id}/groups/${group.id}">
          <label>Etiqueta<input name="label" required value="${value(group.label)}"></label>
          <label>Eje<select name="axis">${axisOptions}</select></label>
          <button type="submit">Guardar grupo</button>
        </form>
        <div class="actions">
          <form method="post" action="/drafts/${draft.id}/groups/${group.id}/up"><button type="submit"${groupIndex === 0 ? " disabled" : ""}>Subir grupo</button></form>
          <form method="post" action="/drafts/${draft.id}/groups/${group.id}/down"><button type="submit"${groupIndex === draft.navigationGroups.length - 1 ? " disabled" : ""}>Bajar grupo</button></form>
          <form method="post" action="/drafts/${draft.id}/groups/${group.id}/remove"><button type="submit">Eliminar grupo</button></form>
        </div>
        <h4>Guías incluidas</h4>
        ${guideRows ? `<ol>${guideRows}</ol>` : '<p class="muted">Grupo vacío. No se publicará mientras siga vacío.</p>'}
        ${addGuideForm}
      </section>`;
    })
    .join("");
  const newGroupAxes = PRIMARY_AXES.map(
    (axis) => `<option value="${axis}">${escapeHtml(axisLabels[axis])}</option>`,
  ).join("");
  return page(
    draftName(draft),
    `<p><a href="/">← Borradores</a></p>
     <div class="actions"><div><h1>${escapeHtml(draftName(draft))}</h1><p><code>${escapeHtml(draft.id)}</code> · ${escapeHtml(draft.status)}</p></div><a class="button" href="/drafts/${draft.id}/preview">Vista previa</a><a class="button" href="/drafts/${draft.id}/validate">Validar</a></div>
     <p class="notice">El ID estable no se edita. El slug define la ruta, pero cambiarlo no cambia la identidad ni el nombre del archivo canónico.</p>
     <form method="post" action="/drafts/${draft.id}/cluster" class="card">
       <h2>Contenido del hub</h2>
       <div class="grid">
         <label>Slug<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value="${value(draft.slug)}"></label>
         <label>Idioma público<input value="en-US" disabled></label>
         <label class="wide">Título<input name="title" value="${value(draft.title)}"></label>
         <label class="wide">Extracto<textarea name="excerpt" rows="3">${value(draft.excerpt)}</textarea></label>
         <label class="wide">Introducción<textarea name="introduction" rows="6">${value(draft.introduction)}</textarea></label>
         <label class="wide">Título SEO<input name="seoTitle" value="${value(draft.seoTitle)}"></label>
         <label class="wide">Descripción SEO<textarea name="seoDescription" rows="3">${value(draft.seoDescription)}</textarea></label>
       </div>
       <button type="submit">Guardar contenido</button>
     </form>
     <section>
       <h2>Navegación curada</h2>
       <p>Un grupo enlaza sólo guías publicadas de este cluster. La misma guía puede incluirse expresamente en más de un grupo.</p>
       <div class="grid">${groups || '<p class="notice">Todavía no hay grupos.</p>'}</div>
       <form method="post" action="/drafts/${draft.id}/groups" class="card">
         <h3>Agregar grupo</h3>
         <label>Etiqueta<input name="label" required></label>
         <label>Eje<select name="axis">${newGroupAxes}</select></label>
         <button type="submit">Agregar grupo</button>
       </form>
     </section>`,
  );
}

async function readClusterDraft(store: DraftStore, id: string): Promise<ClusterDraft> {
  const draft = await store.read(id);
  if (draft.draftType !== "cluster-hub")
    throw new TypeError("El borrador no es un hub de cluster.");
  return draft;
}

function updateClusterFromForm(draft: ClusterDraft, form: URLSearchParams): ClusterDraft {
  return clusterDraftSchema.parse({
    ...draft,
    status: "editing",
    slug: optionalValue(form, "slug"),
    title: optionalValue(form, "title"),
    excerpt: optionalValue(form, "excerpt"),
    introduction: optionalValue(form, "introduction"),
    seoTitle: optionalValue(form, "seoTitle"),
    seoDescription: optionalValue(form, "seoDescription"),
  });
}

function clusterPreviewPage(draft: ClusterDraft): string {
  const content = readPublicContent();
  const validation = validateClusterDraft(draft, content);
  const guides = new Map(content.guides.map((guide) => [guide.id, guide]));
  const clusterRoute = validation.route ?? "(ruta incompleta)";
  const groups = draft.navigationGroups
    .filter((group) => group.guideIds.length > 0)
    .map(
      (group) =>
        `<section class="card"><p class="muted">${escapeHtml(axisLabels[group.axis])}</p><h2>${escapeHtml(group.label)}</h2><ul>${group.guideIds
          .map((guideId) => {
            const guide = guides.get(guideId);
            return guide && draft.slug
              ? `<li><a href="${escapeHtml(guidePath(draft.slug, guide.slug))}">${escapeHtml(guide.title)}</a></li>`
              : `<li>${escapeHtml(guideId)} (no disponible)</li>`;
          })
          .join("")}</ul></section>`,
    )
    .join("");
  const warnings = [...validation.errors, ...validation.warnings];
  return page(
    `Vista previa · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar hub</a></p>
     ${warnings.length ? `<aside class="error"><strong>Vista previa incompleta</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></aside>` : ""}
     <nav aria-label="Migas de pan"><span>Inicio</span> › <span>Guías de regalos</span> › <strong>${escapeHtml(draft.title ?? "Hub sin título")}</strong></nav>
     <p class="muted">Ruta canónica: <code>${escapeHtml(clusterRoute)}</code></p>
     <section class="card"><h2>Metadata de publicación</h2><dl><dt>Título SEO</dt><dd>${escapeHtml(draft.seoTitle ?? "Falta el título SEO.")}</dd><dt>Descripción SEO</dt><dd>${escapeHtml(draft.seoDescription ?? "Falta la descripción SEO.")}</dd></dl></section>
     <header><div><h1>${escapeHtml(draft.title ?? "Hub sin título")}</h1><p>${escapeHtml(draft.excerpt ?? "Falta el extracto.")}</p></div></header>
     <section class="card"><h2>Introducción</h2><p>${escapeHtml(draft.introduction ?? "Falta la introducción.")}</p></section>
     <section><h2>Explorar guías</h2><div class="grid">${groups || '<p class="notice">No hay grupos con guías para mostrar.</p>'}</div></section>`,
  );
}

function clusterValidationPage(draft: ClusterDraft): string {
  const result = validateClusterDraft(draft, readPublicContent());
  return page(
    `Validación · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar hub</a></p>
     <h1>Validación del hub</h1>
     ${result.errors.length ? `<div class="error"><strong>Falta resolver:</strong><ul>${result.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>` : '<p class="notice">El borrador está listo para la publicación de cluster.</p>'}
     ${result.warnings.length ? `<div class="notice"><strong>Avisos:</strong><ul>${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
     ${result.route ? `<p>Ruta canónica: <code>${escapeHtml(result.route)}</code></p>` : ""}
     <p><strong>Publicar crea o actualiza el contenido del repositorio. Para publicarlo en Internet todavía hay que hacer commit y push.</strong></p>
     ${result.errors.length ? "" : `<form method="post" action="/drafts/${draft.id}/publish"><button type="submit">Publicar hub en el repositorio</button></form>`}`,
  );
}

function optionalNumber(form: URLSearchParams, name: string, label: string): number | undefined {
  const value = optionalValue(form, name);
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label} debe ser un número mayor o igual que cero.`);
  }
  return number;
}

function guideWorkflowStatus(draft: GuideDraft): GuideDraft["status"] {
  if (draft.recommendations.some((recommendation) => recommendation.productId)) {
    return "selecting-products";
  }
  return draft.outline ? "outline-ready" : "questionnaire";
}

function guideArchitectureFromForm(draft: GuideDraft, form: URLSearchParams): GuideDraft {
  const content = readPublicContent();
  const clusterId = optionalValue(form, "clusterId");
  if (clusterId && !content.clusters.some((cluster) => cluster.id === clusterId)) {
    throw new TypeError("El cluster elegido no está publicado.");
  }
  const axisValue = optionalValue(form, "primaryAxis");
  const primaryAxis = axisValue ? primaryAxisValue(form, "primaryAxis") : undefined;
  const taxonomies = {
    ...(listValue(form, "occasions") ? { occasions: listValue(form, "occasions") } : {}),
    ...(listValue(form, "recipients") ? { recipients: listValue(form, "recipients") } : {}),
    ...(listValue(form, "careerStages") ? { careerStages: listValue(form, "careerStages") } : {}),
    ...(listValue(form, "workContexts") ? { workContexts: listValue(form, "workContexts") } : {}),
    ...(listValue(form, "giftStyles") ? { giftStyles: listValue(form, "giftStyles") } : {}),
    ...(listValue(form, "budgetLabels") ? { budgetLabels: listValue(form, "budgetLabels") } : {}),
  };
  const budgetLabel = optionalValue(form, "budgetLabel");
  const minimum = optionalNumber(form, "budgetMinimum", "El presupuesto mínimo");
  const maximum = optionalNumber(form, "budgetMaximum", "El presupuesto máximo");
  if ((minimum !== undefined || maximum !== undefined) && !budgetLabel) {
    throw new TypeError("Agregá una etiqueta para el contexto de presupuesto.");
  }
  const relatedGuideIds = form.getAll("relatedGuideIds").filter(Boolean);
  if (new Set(relatedGuideIds).size !== relatedGuideIds.length) {
    throw new TypeError("Las guías relacionadas no pueden repetirse.");
  }
  if (relatedGuideIds.includes(draft.id)) {
    throw new TypeError("Una guía no puede relacionarse consigo misma.");
  }
  for (const relatedId of relatedGuideIds) {
    const related = content.guides.find((guide) => guide.id === relatedId);
    if (!related || !clusterId || related.clusterId !== clusterId) {
      throw new TypeError("Las guías relacionadas deben estar publicadas en el mismo cluster.");
    }
  }
  return guideDraftSchema.parse({
    ...draft,
    status: guideWorkflowStatus(draft),
    clusterId,
    slug: optionalValue(form, "slug"),
    primaryAxis,
    primaryIntent: optionalValue(form, "primaryIntent"),
    taxonomies: Object.keys(taxonomies).length ? taxonomies : undefined,
    budgetContext:
      budgetLabel || minimum !== undefined || maximum !== undefined
        ? {
            currency: "USD",
            label: budgetLabel,
            ...(minimum !== undefined ? { minimum } : {}),
            ...(maximum !== undefined ? { maximum } : {}),
          }
        : undefined,
    relatedGuideIds,
  });
}

function questionnaireFromForm(draft: GuideDraft, form: URLSearchParams): GuideDraft {
  const questionnaire = normalizeQuestionnaire({
    recipient: form.get("recipient") ?? undefined,
    ageRange: form.get("ageRange") ?? undefined,
    occasion: form.get("occasion") ?? undefined,
    giftCount: form.get("giftCount") ?? undefined,
    budget: form.get("budget") ?? undefined,
    interests: form.get("interests") ?? undefined,
    avoid: form.get("avoid") ?? undefined,
    tone: form.get("tone") ?? undefined,
    additional: form.get("additional") ?? undefined,
  });
  return guideDraftSchema.parse({
    ...draft,
    status: guideWorkflowStatus(draft),
    questionnaire,
  });
}

function guideCopyFromForm(draft: GuideDraft, form: URLSearchParams): GuideDraft {
  return updateGuideEditorialCopy(draft, {
    title: optionalValue(form, "title"),
    excerpt: optionalValue(form, "excerpt"),
    introduction: optionalValue(form, "introduction"),
    conclusion: optionalValue(form, "conclusion"),
    seoTitle: optionalValue(form, "seoTitle"),
    seoDescription: optionalValue(form, "seoDescription"),
  });
}

function recommendationCopyFromForm(
  draft: GuideDraft,
  recommendationId: string,
  form: URLSearchParams,
): GuideDraft {
  return updateRecommendationEditorialCopy(
    draft,
    recommendationId,
    {
      heading: optionalValue(form, "heading"),
      editorialDescription: optionalValue(form, "editorialDescription"),
      whyItFits: optionalValue(form, "whyItFits"),
      bestFor: optionalValue(form, "bestFor"),
      considerations: optionalValue(form, "considerations"),
    },
    form.get("markReady") === "yes",
  );
}

function productChoiceForm(
  draft: GuideDraft,
  recommendationId: string,
  product: Product,
  duplicate: boolean,
  replacing: boolean,
  evidence?: { score: number; threshold: number; usedInGuide: boolean },
): string {
  const resolveThroughSourcing = !replacing;
  const action = resolveThroughSourcing
    ? `/drafts/${encodeURIComponent(draft.id)}/recommendations/${encodeURIComponent(recommendationId)}/catalog`
    : `/drafts/${encodeURIComponent(draft.id)}/recommendations/${encodeURIComponent(recommendationId)}/product`;
  const evidenceHtml = evidence
    ? `<p class="muted">I.0: ${evidence.score} tokens compartidos - umbral ${evidence.threshold}. Esto es evidencia determinista, no encaje editorial. ${evidence.usedInGuide ? "Ya se usa en esta guia." : "No se usa en esta guia."}</p>`
    : "";
  return `<form method="post" action="${action}" class="card">
    <input type="hidden" name="productId" value="${product.id}">
    ${resolveThroughSourcing ? '<input type="hidden" name="fulfillmentStatus" value="fulfilled">' : ""}
    <strong>${escapeHtml(product.name)}</strong>
    <span class="muted">${escapeHtml(product.merchant)}</span>
    <p>${escapeHtml(product.shortDescription)}</p>
    ${evidenceHtml}
    ${duplicate ? '<label><input type="checkbox" name="allowDuplicate" value="yes" required> Confirmo que quiero repetir este producto en la guía.</label>' : ""}
    <button type="submit">${resolveThroughSourcing ? "Seleccionar para este requisito" : replacing ? "Reemplazar con este producto" : "Seleccionar"}</button>
  </form>`;
}

function recommendationSelectionSection(
  draft: GuideDraft,
  url: URL,
  catalog: ProductCatalog,
  sourcingStore: ProductSourcingRequestStore,
  brief?: EditorialBrief,
): string {
  const content = catalog.read();
  const sourcingRequests = sourcingStore.list();
  const productsById = new Map(content.products.map((product) => [product.id, product]));
  const searchSlot = url.searchParams.get("slot");
  const productQuery = url.searchParams.get("productQ") ?? "";
  const duplicates = duplicateProductIds(draft);
  const duplicateWarning = duplicates.length
    ? `<div class="error"><strong>Productos repetidos confirmados:</strong> ${duplicates.map((id) => escapeHtml(productsById.get(id)?.name ?? id)).join(", ")}</div>`
    : "";
  const orderedRecommendations = [...draft.recommendations].sort(
    (left, right) => left.position - right.position,
  );
  const coverage = analyzeProductCoverage(content, [draft]);
  const slotsWithoutDeterministicMatch = new Set(
    coverage.editorialCoverage.draftSlotsWithoutSuitableProducts.map(({ slotId }) => slotId),
  );
  const activeSourcingStatuses: ProductSourcingRequestStatus[] = ["open", "partially-fulfilled"];
  const triage = orderedRecommendations
    .map((recommendation) => {
      const selected = recommendation.productId
        ? productsById.get(recommendation.productId)
        : undefined;
      const possibleMatch =
        !recommendation.productId && !slotsWithoutDeterministicMatch.has(recommendation.id)
          ? suggestProductsForSlot(content.products, recommendation, 1)[0]
          : undefined;
      const selectedMatchTokens = selected
        ? productSlotMatchScore(selected, recommendation)
        : undefined;
      const assignedNeedsFitReview =
        Boolean(recommendation.productId) &&
        (!selected || (selectedMatchTokens ?? 0) < coverage.thresholds.minimumSlotMatchTokenCount);
      const activeRequests = sourcingRequests.filter(
        ({ origin, status }) =>
          activeSourcingStatuses.includes(status) &&
          origin.kind === "recommendation-slot" &&
          origin.guideDraftId === draft.id &&
          origin.recommendationSlotId === recommendation.id,
      );
      const amazonMonetizationPending =
        Boolean(selected) && isAmazonProduct(selected!) && !productDestination(selected!);
      const state = recommendation.productId
        ? amazonMonetizationPending
          ? "Producto resuelto · monetización Amazon pendiente"
          : assignedNeedsFitReview
            ? "Producto asignado · revisar encaje"
            : recommendation.editorialStatus === "needs-generation"
              ? "Listo para generar recomendación"
              : "Asignado"
        : recommendation.editorialStatus === "ready"
          ? "Editorialmente lista · Product sin resolver"
          : possibleMatch
            ? "Posible coincidencia determinista"
            : "Sin coincidencia determinista · sourcing probable";
      const evidence = selected
        ? `${escapeHtml(selected.name)} · I.0: ${selectedMatchTokens} tokens compartidos`
        : recommendation.productId
          ? `<code>${escapeHtml(recommendation.productId)}</code> · no disponible en catálogo`
          : possibleMatch
            ? escapeHtml(possibleMatch.name)
            : `I.0: menos de ${coverage.thresholds.minimumSlotMatchTokenCount} tokens compartidos`;
      const sourcing = activeRequests.length
        ? activeRequests
            .map(
              (request) =>
                `<a href="/product-sourcing/${encodeURIComponent(request.id)}">Sourcing activo · <code>${escapeHtml(request.id)}</code></a>`,
            )
            .join("<br>")
        : "—";
      const monetizationAction = amazonMonetizationPending
        ? `<br><a href="/products/${encodeURIComponent(selected!.id)}/edit">Agregar link de afiliado</a>`
        : "";
      return `<tr><td>${recommendation.position}. ${escapeHtml(recommendation.slotLabel)}</td><td><span class="status">${escapeHtml(state)}</span><br><span class="muted">${evidence}</span></td><td>${sourcing}</td><td><a href="#slot-${encodeURIComponent(recommendation.id)}">Abrir slot</a>${recommendation.productId && recommendation.editorialStatus === "needs-generation" ? `<br><a href="/drafts/${encodeURIComponent(draft.id)}/recommendations/${encodeURIComponent(recommendation.id)}/prompt">Generar recomendación</a>` : ""}${monetizationAction}</td></tr>`;
    })
    .join("");
  const recommendations = orderedRecommendations
    .map((recommendation, index) => {
      const selected = recommendation.productId
        ? productsById.get(recommendation.productId)
        : undefined;
      const isDuplicate = (productId: string) =>
        draft.recommendations.some(
          (item) => item.id !== recommendation.id && item.productId === productId,
        );
      const matchEvidence = (product: Product) => ({
        score: productSlotMatchScore(product, recommendation),
        threshold: coverage.thresholds.minimumSlotMatchTokenCount,
        usedInGuide:
          draft.recommendations.some(
            (item) => item.id !== recommendation.id && item.productId === product.id,
          ) ||
          content.guides.some(
            (guide) =>
              guide.id === draft.id &&
              guide.recommendations.some(({ productId }) => productId === product.id),
          ),
      });
      const suggestions = suggestProductsForSlot(content.products, recommendation, 3)
        .filter((product) => product.id !== recommendation.productId)
        .map((product) =>
          productChoiceForm(
            draft,
            recommendation.id,
            product,
            isDuplicate(product.id),
            Boolean(selected),
            matchEvidence(product),
          ),
        )
        .join("");
      const results =
        searchSlot === recommendation.id
          ? matchProducts(content.products, productQuery, "active")
              .filter((product) => product.id !== recommendation.productId)
              .map((product) =>
                productChoiceForm(
                  draft,
                  recommendation.id,
                  product,
                  isDuplicate(product.id),
                  Boolean(selected),
                  matchEvidence(product),
                ),
              )
              .join("")
          : "";
      const replacementWarning =
        recommendation.editorialStatus === "needs-review"
          ? '<p class="error"><strong>Revisión obligatoria:</strong> el texto existente puede describir el producto anterior. Podés conservarlo temporalmente, pero la publicación queda bloqueada hasta editarlo o regenerar sólo esta recomendación.</p>'
          : "";
      const slotRequests = sourcingRequests.filter(
        ({ origin }) =>
          origin.kind === "recommendation-slot" &&
          origin.guideDraftId === draft.id &&
          origin.recommendationSlotId === recommendation.id,
      );
      const prefill = productSourcingPrefillForDraftSlot(draft, recommendation, brief);
      const slotPath = guideDraftSlotPath(draft.id, recommendation.id);
      const fastResolution = `<section class="card"><h4>Resolver Product con I.2</h4>
        ${slotRequests.length ? `<ul>${slotRequests.map((request) => `<li><a href="/product-sourcing/${encodeURIComponent(request.id)}"><code>${escapeHtml(request.id)}</code></a> - ${escapeHtml(request.status)}</li>`).join("")}</ul>` : '<p class="muted">La solicitud I.2 se crea automaticamente al elegir una coincidencia o pegar una URL.</p>'}
        ${!selected ? `<form method="post" action="${slotPath}/resolve-url" class="card"><label>URL de producto o afiliado<input type="url" name="url" required placeholder="https://..."></label><label>Destino afiliado separado (opcional)<input type="url" name="affiliateUrl" placeholder="https://..."></label><label>Tracking ID conocido (opcional)<input name="trackingId"></label><button type="submit">Pegar URL de producto/afiliado</button></form>` : ""}
        <details><summary>Contexto I.2 heredado automaticamente</summary><div class="grid"><label>Audiencia<input value="${value(prefill.audience)}" readonly></label><label>Ocasion o contexto<input value="${value(prefill.occasion)}" readonly></label><label>Presupuesto<input value="${value(prefill.budgetContext)}" readonly></label><label class="wide">Exclusiones<textarea rows="2" readonly>${listText(prefill.exclusions, "\n")}</textarea></label><label class="wide">Terminos de busqueda<input value="${listText(prefill.searchTerms)}" readonly></label></div></details>
      </section>`;
      return `<article class="card" id="slot-${escapeHtml(recommendation.id)}">
        <div class="actions"><h3>${recommendation.position}. ${escapeHtml(recommendation.slotLabel)}</h3><span class="status">${escapeHtml(recommendation.editorialStatus)} · ${selected ? "Product resuelto" : "Product sin resolver"}</span></div>
        ${recommendation.slotIntent ? `<p>${escapeHtml(recommendation.slotIntent)}</p>` : ""}
        ${recommendation.searchTerms?.length ? `<p class="muted">Búsqueda sugerida: ${escapeHtml(recommendation.searchTerms.join(", "))}</p>` : ""}
        ${recommendation.budgetHint ? `<p class="muted">Presupuesto: ${escapeHtml(recommendation.budgetHint)}</p>` : ""}
        <div class="actions">
          <form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/up"><button type="submit"${index === 0 ? " disabled" : ""}>Subir</button></form>
          <form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/down"><button type="submit"${index === draft.recommendations.length - 1 ? " disabled" : ""}>Bajar</button></form>
          <form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/remove"><button type="submit">Eliminar slot</button></form>
        </div>
        <section>
          <h4>${selected ? "Producto seleccionado" : "Sin producto asignado"}</h4>
          ${selected ? `<p><strong>${escapeHtml(selected.name)}</strong> · ${escapeHtml(selected.merchant)}${selected.status === "inactive" ? ' · <span class="error">Inactivo</span>' : ""}</p><p>${escapeHtml(selected.shortDescription)}</p>` : '<p class="notice">Podés completar y publicar esta idea sin Product; no tendrá datos comerciales ni CTA.</p>'}
          ${replacementWarning}
          ${selected ? `<form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/product/clear"><button type="submit">Quitar selección</button></form>` : ""}
        </section>
        <form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/copy" class="card">
          <h4>${selected ? "Editar esta recomendación" : "Editar idea editorial"}</h4>
          <label>Encabezado<input name="heading" value="${value(recommendation.heading)}"></label>
          <label>Descripción editorial<textarea name="editorialDescription" rows="4">${value(recommendation.editorialDescription)}</textarea></label>
          <label>Por qué encaja<textarea name="whyItFits" rows="3">${value(recommendation.whyItFits)}</textarea></label>
          <label>Ideal para<input name="bestFor" value="${value(recommendation.bestFor)}"></label>
          <label>Consideraciones<textarea name="considerations" rows="3">${value(recommendation.considerations)}</textarea></label>
          <label><input type="checkbox" name="markReady" value="yes"> ${selected ? "Revisé el producto actual" : "Revisé que esta idea no contenga nombres, comercios, precios ni datos específicos de un Product"} y quiero marcar esta recomendación como lista.</label>
          <div class="actions"><button type="submit">Guardar recomendación</button>${selected ? `<a href="/drafts/${draft.id}/recommendations/${recommendation.id}/prompt">Ver prompt y regenerar sólo esta recomendación</a>` : ""}</div>
        </form>
        <details open>
          <summary>${selected ? "Reemplazar producto" : "Sugerencias del catálogo"}</summary>
          <div class="grid">${suggestions || '<p class="muted">No hay coincidencias sugeridas.</p>'}</div>
        </details>
        <h4>Buscar en catalogo</h4>
        <form method="get" action="${slotPath}" class="card">
          <input type="hidden" name="slot" value="${recommendation.id}">
          <label>Buscar en todo el catálogo<input type="search" name="productQ" value="${searchSlot === recommendation.id ? escapeHtml(productQuery) : ""}"></label>
          <button type="submit">Buscar</button>
        </form>
        ${searchSlot === recommendation.id ? `<section><h4>Resultados del catálogo</h4><div class="grid">${results || '<p class="notice">No hay productos activos que coincidan.</p>'}</div></section>` : ""}
        ${fastResolution}
        <p><a href="/products/new?returnTo=${encodeURIComponent(slotPath)}">Crear un producto nuevo y volver a este slot</a> · <a href="/products/intake?returnTo=${encodeURIComponent(slotPath)}">ingreso asistido</a></p>
      </article>`;
    })
    .join("");
  return `<section>
    <h2>Selección de productos</h2>
    <p>Actualizar un producto cambia el catálogo compartido y todas sus guías. Reemplazarlo aquí cambia sólo este slot y conserva su ID, posición y propósito.</p>
    ${triage ? `<section class="card"><h3>Resumen de slots</h3><p class="muted">El umbral determinista I.0 es de ${coverage.thresholds.minimumSlotMatchTokenCount} tokens compartidos; no evalúa el encaje editorial ni selecciona productos.</p><table><thead><tr><th>Slot</th><th>Estado</th><th>Sourcing</th><th>Ir a</th></tr></thead><tbody>${triage}</tbody></table></section>` : ""}
    ${duplicateWarning}
    <div class="grid">${recommendations || `<p class="notice">No hay slots. <a href="/drafts/${draft.id}/outline-prompt">Revisá y generá el esquema</a> para crearlos con el flujo editorial, o agregá uno manualmente.</p>`}</div>
    <form method="post" action="/drafts/${draft.id}/recommendations" class="card">
      <h3>Agregar slot manual</h3>
      <label>Nombre del slot<input name="slotLabel" required></label>
      <label>Propósito (opcional)<textarea name="slotIntent" rows="2"></textarea></label>
      <label>Términos de búsqueda, separados por coma<input name="searchTerms"></label>
      <button type="submit">Agregar slot</button>
    </form>
  </section>`;
}

function guideEditorPage(
  draft: GuideDraft,
  url: URL,
  catalog: ProductCatalog,
  sourcingStore: ProductSourcingRequestStore,
  briefStore: EditorialBriefStore,
): string {
  const content = catalog.read();
  const clusters = content.clusters
    .map(
      (cluster) =>
        `<option value="${cluster.id}"${cluster.id === draft.clusterId ? " selected" : ""}>${escapeHtml(cluster.title)}</option>`,
    )
    .join("");
  const axes = PRIMARY_AXES.map(
    (axis) =>
      `<option value="${axis}"${axis === draft.primaryAxis ? " selected" : ""}>${escapeHtml(axisLabels[axis])}</option>`,
  ).join("");
  const related = content.guides
    .filter((guide) => guide.clusterId === draft.clusterId && guide.id !== draft.id)
    .map(
      (guide) =>
        `<label><input type="checkbox" name="relatedGuideIds" value="${guide.id}"${draft.relatedGuideIds.includes(guide.id) ? " checked" : ""}> ${escapeHtml(guide.title)}</label>`,
    )
    .join("");
  const q = draft.questionnaire;
  const outline = draft.outline
    ? `<section class="card">
        <h2>Esquema generado</h2>
        <p><strong>Título provisional:</strong> ${escapeHtml(draft.outline.provisionalTitle)}</p>
        <p><strong>Audiencia:</strong> ${escapeHtml(draft.outline.audienceSummary)}</p>
        <p><strong>Ángulo:</strong> ${escapeHtml(draft.outline.editorialAngle)}</p>
        <ol>${draft.outline.slots.map((slot) => `<li><strong>${escapeHtml(slot.label)}</strong><br>${escapeHtml(slot.intent)}<br><span class="muted">Búsqueda: ${escapeHtml(slot.searchTerms.join(", "))}${slot.budgetHint ? ` · ${escapeHtml(slot.budgetHint)}` : ""}</span></li>`).join("")}</ol>
      </section>`
    : `<section class="notice"><h2>Siguiente paso: generar el esquema</h2><p>Revisá el prompt y generá el esquema editorial. Los slots aparecerán después, sin seleccionar productos.</p><p><a class="button" href="/drafts/${draft.id}/outline-prompt">Revisar y generar esquema</a></p></section>`;
  const metadata = draft.generationMetadata
    ? `<p class="muted">Última generación: ${escapeHtml(draft.generationMetadata.providerId ?? "proveedor desconocido")} · ${escapeHtml(draft.generationMetadata.modelId ?? "modelo no informado")} · ${escapeHtml(draft.generationMetadata.promptVersion)} · ${escapeHtml(formatDate(draft.generationMetadata.generatedAt))}</p>`
    : "";
  return page(
    draftName(draft),
    `<p><a href="/">← Borradores</a></p>
     <div class="actions"><div><h1>${escapeHtml(draftName(draft))}</h1><p><code>${escapeHtml(draft.id)}</code> · ${escapeHtml(draft.status)}</p></div><a class="button" href="/drafts/${draft.id}/outline-prompt">${draft.outline ? "Revisar o regenerar esquema" : "Revisar y generar esquema"}</a><a class="button" href="/drafts/${draft.id}/final-prompt">Generación final</a><a class="button" href="/drafts/${draft.id}/preview">Vista previa</a><a class="button" href="/drafts/${draft.id}/validate">Validar</a></div>
     <aside class="notice"><strong>Cómo funciona la arquitectura editorial</strong><p>Las taxonomías clasifican contenido; no crean URLs. Una ruta pública existe sólo al publicar un hub o una guía. Cada guía hija pertenece a un cluster válido. Las guías relacionadas son enlaces editoriales, no jerarquía. “Nurse Gifts Under $25” es una guía con eje <code>budget</code>, no un filtro generado.</p></aside>
     <form method="post" action="/drafts/${draft.id}/guide/architecture" class="card">
       <h2>Arquitectura de la guía</h2>
       <div class="grid">
         <label>Cluster<select name="clusterId"><option value="">Sin elegir</option>${clusters}</select></label>
         <label>Slug<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value="${value(draft.slug)}"></label>
         <label>Idioma público<input value="en-US" disabled></label>
         <label>Eje principal<select name="primaryAxis"><option value="">Sin elegir</option>${axes}</select></label>
         <label class="wide">Intención principal<textarea name="primaryIntent" rows="3">${value(draft.primaryIntent)}</textarea></label>
         <label>Ocasiones, separadas por coma<input name="occasions" value="${listText(draft.taxonomies?.occasions)}"></label>
         <label>Destinatarios<input name="recipients" value="${listText(draft.taxonomies?.recipients)}"></label>
         <label>Etapas profesionales<input name="careerStages" value="${listText(draft.taxonomies?.careerStages)}"></label>
         <label>Contextos laborales<input name="workContexts" value="${listText(draft.taxonomies?.workContexts)}"></label>
         <label>Estilos de regalo<input name="giftStyles" value="${listText(draft.taxonomies?.giftStyles)}"></label>
         <label>Etiquetas de presupuesto<input name="budgetLabels" value="${listText(draft.taxonomies?.budgetLabels)}"></label>
         <label>Etiqueta de presupuesto<input name="budgetLabel" value="${value(draft.budgetContext?.label)}" placeholder="Under $50"></label>
         <label>Mínimo USD<input type="number" min="0" step="0.01" name="budgetMinimum" value="${draft.budgetContext?.minimum ?? ""}"></label>
         <label>Máximo USD<input type="number" min="0" step="0.01" name="budgetMaximum" value="${draft.budgetContext?.maximum ?? ""}"></label>
         <fieldset class="wide"><legend>Guías relacionadas</legend><div class="checks">${related || "No hay otras guías publicadas en el cluster elegido."}</div></fieldset>
       </div>
       <button type="submit">Guardar arquitectura</button>
     </form>
     <form method="post" action="/drafts/${draft.id}/guide/copy" class="card">
       <h2>Copia editorial de la guía</h2>
       <div class="grid">
         <label class="wide">Título<input name="title" value="${value(draft.title)}"></label>
         <label class="wide">Extracto<textarea name="excerpt" rows="3">${value(draft.excerpt)}</textarea></label>
         <label class="wide">Introducción<textarea name="introduction" rows="6">${value(draft.introduction)}</textarea></label>
         <label class="wide">Conclusión (opcional)<textarea name="conclusion" rows="4">${value(draft.conclusion)}</textarea></label>
         <label class="wide">Título SEO<input name="seoTitle" value="${value(draft.seoTitle)}"></label>
         <label class="wide">Descripción SEO<textarea name="seoDescription" rows="3">${value(draft.seoDescription)}</textarea></label>
       </div>
       <button type="submit">Guardar copia de la guía</button>
     </form>
     <form method="post" action="/drafts/${draft.id}/questionnaire" class="card">
       <h2>Cuestionario opcional</h2>
       <p>Podés dejar respuestas en blanco. La cantidad usa 8 por defecto.</p>
       <div class="grid">
         <label>¿Para quién está dirigida esta guía?<input name="recipient" value="${value(q.recipient)}"></label>
         <label>¿Qué edad o rango de edad tiene?<input name="ageRange" value="${value(q.ageRange)}"></label>
         <label>¿Para qué ocasión es?<input name="occasion" value="${value(q.occasion)}"></label>
         <label>¿Cuántos regalos debería incluir?<input type="number" name="giftCount" min="${MIN_GIFT_COUNT}" max="${MAX_GIFT_COUNT}" required value="${q.giftCount}"></label>
         <label>¿Qué presupuesto debería considerar?<input name="budget" value="${value(q.budget)}"></label>
         <label>¿Qué intereses o pasatiempos tiene?<input name="interests" value="${value(q.interests)}"></label>
         <label>¿Hay algo que deberíamos evitar?<input name="avoid" value="${value(q.avoid)}"></label>
         <label>¿Qué tono debería tener la guía?<input name="tone" value="${value(q.tone)}"></label>
         <label class="wide">¿Querés agregar alguna indicación adicional?<textarea name="additional" rows="3">${value(q.additional)}</textarea></label>
       </div>
       <button type="submit">Guardar cuestionario</button>
     </form>
       ${metadata}${outline}${recommendationSelectionSection(
         draft,
         url,
         catalog,
         sourcingStore,
         briefStore.list().find(({ guideDraftId }) => guideDraftId === draft.id),
       )}`,
  );
}

async function readGuideDraft(store: DraftStore, id: string): Promise<GuideDraft> {
  const draft = await store.read(id);
  if (draft.draftType !== "gift-guide")
    throw new TypeError("El borrador no es una guía de regalos.");
  return draft;
}

function outlinePromptPage(draft: GuideDraft, provider: GuideGenerationProvider): string {
  const prepared = prepareOutlinePrompt(draft, readPublicContent());
  const hasSelectedProducts = draft.recommendations.some(
    (recommendation) => recommendation.productId,
  );
  return page(
    `Prompt de esquema · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar guía</a></p>
     <h1>Revisar prompt de esquema</h1>
     <p class="notice">Esta etapa crea sólo slots editoriales y términos de búsqueda. No selecciona productos ni escribe la guía completa.</p>
     ${hasSelectedProducts ? '<p class="error">Quitá las selecciones de productos antes de regenerar el esquema para no perder trabajo editorial.</p>' : ""}
     <p>Versión <code>${escapeHtml(prepared.version)}</code> · proveedor <code>${escapeHtml(provider.providerId)}</code>${provider.modelId ? ` · modelo <code>${escapeHtml(provider.modelId)}</code>` : ""}</p>
     <pre>${escapeHtml(prepared.prompt)}</pre>
     <form method="post" action="/drafts/${draft.id}/outline/generate"><input type="hidden" name="promptVersion" value="${escapeHtml(prepared.version)}"><button type="submit"${hasSelectedProducts ? " disabled" : ""}>Generar esquema con este prompt</button></form>`,
  );
}

function finalPromptPage(draft: GuideDraft, provider: GuideGenerationProvider): string {
  const prepared = prepareFinalPrompt(draft, readPublicContent());
  return page(
    `Prompt final · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar guía</a></p>
     <h1>Revisar prompt de generación final</h1>
     <p class="notice">El prompt contiene sólo los productos seleccionados y datos verificados del catálogo. Nunca incluye URLs afiliadas.</p>
     <p>Versión <code>${escapeHtml(prepared.version)}</code> · proveedor <code>${escapeHtml(provider.providerId)}</code>${provider.modelId ? ` · modelo <code>${escapeHtml(provider.modelId)}</code>` : ""}</p>
     <pre>${escapeHtml(prepared.prompt)}</pre>
     <form method="post" action="/drafts/${draft.id}/final/generate"><input type="hidden" name="promptVersion" value="${escapeHtml(prepared.version)}"><button type="submit">Generar toda la copia editorial</button></form>`,
  );
}

function recommendationPromptPage(
  draft: GuideDraft,
  recommendationId: string,
  provider: GuideGenerationProvider,
): string {
  const prepared = prepareRecommendationPrompt(draft, recommendationId, readPublicContent());
  return page(
    `Prompt de recomendación · ${draftName(draft)}`,
    `<p><a href="${guideDraftSlotPath(draft.id, recommendationId)}">← Volver al slot</a></p>
     <h1>Regenerar una recomendación</h1>
     <p class="notice">Sólo cambiará la copia del slot <code>${escapeHtml(recommendationId)}</code>. Su ID, posición, propósito y producto seleccionado se conservan.</p>
     <p>Versión <code>${escapeHtml(prepared.version)}</code> · proveedor <code>${escapeHtml(provider.providerId)}</code>${provider.modelId ? ` · modelo <code>${escapeHtml(provider.modelId)}</code>` : ""}</p>
     <pre>${escapeHtml(prepared.prompt)}</pre>
     <form method="post" action="/drafts/${draft.id}/recommendations/${recommendationId}/regenerate"><input type="hidden" name="promptVersion" value="${escapeHtml(prepared.version)}"><button type="submit">Regenerar sólo esta recomendación</button></form>`,
  );
}

function guidePreviewPage(draft: GuideDraft): string {
  const content = readPublicContent();
  const validation = validateGuideDraft(draft, content);
  const cluster = content.clusters.find((item) => item.id === draft.clusterId);
  const products = new Map(content.products.map((product) => [product.id, product]));
  const guides = new Map(content.guides.map((guide) => [guide.id, guide]));
  const recommendations = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .map((recommendation) => {
      const product = recommendation.productId ? products.get(recommendation.productId) : undefined;
      const destination = product ? productDestination(product) : undefined;
      const isAffiliate = Boolean(destination && product?.affiliateUrl === destination);
      const linkRel = isAffiliate ? "sponsored nofollow noopener" : "nofollow noopener";
      return `<article class="card">
        <p class="muted">Recomendación ${recommendation.position}</p>
        <h2>${escapeHtml(recommendation.heading ?? product?.name ?? recommendation.slotLabel)}</h2>
        ${product ? `<p><strong>${escapeHtml(product.name)}</strong> · ${escapeHtml(product.merchant)}${product.priceLabel ? ` · ${escapeHtml(product.priceLabel)}` : ""}</p><p>${escapeHtml(product.shortDescription)}</p>` : '<p class="notice">Idea editorial publicada sin Product ni CTA.</p>'}
        <p>${escapeHtml(recommendation.editorialDescription ?? "Falta la descripción editorial.")}</p>
        <p><strong>Por qué encaja:</strong> ${escapeHtml(recommendation.whyItFits ?? "Falta este motivo.")}</p>
        ${recommendation.bestFor ? `<p><strong>Ideal para:</strong> ${escapeHtml(recommendation.bestFor)}</p>` : ""}
        ${recommendation.considerations ? `<p><strong>Consideraciones:</strong> ${escapeHtml(recommendation.considerations)}</p>` : ""}
        ${destination && product ? `<p><a href="${escapeHtml(destination)}" target="_blank" rel="${linkRel}">${isAffiliate ? "Ver en" : "Ver producto en"} ${escapeHtml(product.merchant)}</a></p>` : ""}
      </article>`;
    })
    .join("");
  const related = draft.relatedGuideIds
    .map((id) => guides.get(id))
    .filter((guide) => guide && cluster)
    .map(
      (guide) =>
        `<li><a href="${escapeHtml(guidePath(cluster!.slug, guide!.slug))}">${escapeHtml(guide!.title)}</a></li>`,
    )
    .join("");
  return page(
    `Vista previa · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar guía</a></p>
     ${validation.errors.length ? `<aside class="error"><strong>Vista previa incompleta</strong><ul>${validation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></aside>` : ""}
     <nav aria-label="Migas de pan"><span>Inicio</span> › <span>Guías de regalos</span> › ${cluster ? `<a href="${escapeHtml(clusterPath(cluster.slug))}">${escapeHtml(cluster.title)}</a>` : "Cluster sin definir"} › <strong>${escapeHtml(draft.title ?? "Guía sin título")}</strong></nav>
     <p class="muted">Ruta canónica: <code>${escapeHtml(validation.route ?? "(ruta incompleta)")}</code></p>
     <section class="card"><h2>Metadata de publicación</h2><dl><dt>Eje editorial</dt><dd>${draft.primaryAxis ? escapeHtml(axisLabels[draft.primaryAxis]) : "Falta el eje editorial."}</dd><dt>Intención</dt><dd>${escapeHtml(draft.primaryIntent ?? "Falta la intención principal.")}</dd>${draft.budgetContext ? `<dt>Presupuesto</dt><dd>${escapeHtml(draft.budgetContext.label)} USD</dd>` : ""}<dt>Título SEO</dt><dd>${escapeHtml(draft.seoTitle ?? "Falta el título SEO.")}</dd><dt>Descripción SEO</dt><dd>${escapeHtml(draft.seoDescription ?? "Falta la descripción SEO.")}</dd></dl></section>
     <header><div><p><a href="${cluster ? escapeHtml(clusterPath(cluster.slug)) : "#"}">← ${escapeHtml(cluster?.title ?? "Cluster")}</a></p><h1>${escapeHtml(draft.title ?? "Guía sin título")}</h1><p>${escapeHtml(draft.excerpt ?? "Falta el extracto.")}</p></div></header>
     <section class="card"><p>${escapeHtml(draft.introduction ?? "Falta la introducción.")}</p></section>
     <section><h2>Recomendaciones</h2><div class="grid">${recommendations || '<p class="notice">No hay recomendaciones.</p>'}</div></section>
     ${draft.conclusion ? `<section class="card"><h2>Conclusión</h2><p>${escapeHtml(draft.conclusion)}</p></section>` : ""}
     ${related ? `<nav aria-label="Guías relacionadas"><h2>Guías relacionadas</h2><ul>${related}</ul>${cluster ? `<p><a href="${escapeHtml(clusterPath(cluster.slug))}">Volver a ${escapeHtml(cluster.title)}</a></p>` : ""}</nav>` : ""}`,
  );
}

function guideValidationPage(draft: GuideDraft): string {
  const result = validateGuideDraft(draft, readPublicContent());
  return page(
    `Validación · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Editar guía</a></p>
     <h1>Validación de la guía</h1>
     ${result.errors.length ? `<div class="error"><strong>Falta resolver:</strong><ul>${result.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>` : '<p class="notice">La guía está lista para la publicación.</p>'}
     ${result.route ? `<p>Ruta canónica: <code>${escapeHtml(result.route)}</code></p>` : ""}
     <p><strong>Publicar crea o actualiza el contenido del repositorio. Para publicarlo en Internet todavía hay que hacer commit y push.</strong></p>
     ${result.errors.length ? "" : `<form method="post" action="/drafts/${draft.id}/publish"><button type="submit">Publicar guía en el repositorio</button></form>`}`,
  );
}

function publicationResultPage(draft: EditorialDraft, result: PublicationResult): string {
  return page(
    `Publicado · ${draftName(draft)}`,
    `<p><a href="/drafts/${draft.id}">← Volver al borrador</a></p>
     <h1>Contenido ${result.action === "created" ? "creado" : "actualizado"}</h1>
     <p class="notice">Se escribió y validó el archivo canónico.</p>
     <dl><dt>ID estable</dt><dd><code>${escapeHtml(result.id)}</code></dd><dt>Archivo</dt><dd><code>${escapeHtml(result.file)}</code></dd><dt>Ruta</dt><dd><code>${escapeHtml(result.route)}</code></dd></dl>
     <p><strong>Publicar crea o actualiza el contenido del repositorio. Para publicarlo en Internet todavía hay que hacer commit y push.</strong></p>`,
  );
}

async function createCluster(store: DraftStore, form: URLSearchParams): Promise<ClusterDraft> {
  return store.save({
    ...createClusterDraft(),
    ...(optionalValue(form, "title") ? { title: optionalValue(form, "title") } : {}),
    ...(optionalValue(form, "slug") ? { slug: optionalValue(form, "slug") } : {}),
  });
}

async function createGuide(store: DraftStore, form: URLSearchParams): Promise<GuideDraft> {
  const axis = optionalValue(form, "primaryAxis");
  return store.save({
    ...createGuideDraft(),
    ...(optionalValue(form, "title") ? { title: optionalValue(form, "title") } : {}),
    ...(optionalValue(form, "clusterId") ? { clusterId: optionalValue(form, "clusterId") } : {}),
    ...(optionalValue(form, "slug") ? { slug: optionalValue(form, "slug") } : {}),
    ...(axis ? { primaryAxis: axis as PrimaryAxis } : {}),
    ...(optionalValue(form, "primaryIntent")
      ? { primaryIntent: optionalValue(form, "primaryIntent") }
      : {}),
  });
}

export function createStudioServer(
  store = new DraftStore(),
  catalog = new ProductCatalog(),
  provider: GuideGenerationProvider = new MockGuideGenerationProvider(),
  publisher = new Publisher(),
  sourceStore = new ProductSourceStore(catalog.root),
  candidateStore = new ArticleCandidateStore(catalog.root),
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[] = [],
  evaluationStore = new OpportunityEvaluationStore(catalog.root),
  briefStore = new EditorialBriefStore(catalog.root, candidateStore),
  discoverySource: ProductDiscoverySource | undefined = createProductDiscoverySource(),
) {
  const sourcingStore = new ProductSourcingRequestStore(catalog.root);
  const currentApprovedBriefs = () => [
    ...new Map(
      [...approvedBriefs, ...editorialBriefComparisonRecords(briefStore.list())].map((brief) => [
        brief.id,
        brief,
      ]),
    ).values(),
  ];
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${STUDIO_HOST}`);

      if (method === "GET" && url.pathname === "/") {
        send(response, 200, await home(store));
        return;
      }
      if (method === "GET" && url.pathname === "/drafts/new") {
        send(response, 200, newDraftPage());
        return;
      }
      const reopenClusterMatch =
        method === "POST" ? /^\/drafts\/reopen\/cluster\/([a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (reopenClusterMatch?.[1]) {
        const existing = (await store.list()).drafts.find(
          (draft) => draft.id === reopenClusterMatch[1],
        );
        if (existing) {
          if (existing.draftType !== "cluster-hub") {
            throw new TypeError("Ya existe un borrador de otro tipo con ese ID.");
          }
          redirect(response, `/drafts/${existing.id}`);
          return;
        }
        const cluster = readPublicContent().clusters.find(
          (item) => item.id === reopenClusterMatch[1],
        );
        if (!cluster) throw new TypeError("El hub publicado no existe.");
        const draft = await store.save(reopenClusterDraft(cluster));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const reopenGuideMatch =
        method === "POST" ? /^\/drafts\/reopen\/guide\/([a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (reopenGuideMatch?.[1]) {
        const existing = (await store.list()).drafts.find(
          (draft) => draft.id === reopenGuideMatch[1],
        );
        if (existing) {
          if (existing.draftType !== "gift-guide") {
            throw new TypeError("Ya existe un borrador de otro tipo con ese ID.");
          }
          redirect(response, `/drafts/${existing.id}`);
          return;
        }
        const content = readPublicContent();
        const guide = content.guides.find((item) => item.id === reopenGuideMatch[1]);
        if (!guide) throw new TypeError("La guía publicada no existe.");
        const draft = await store.save(reopenGuideDraft(guide, content));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const previewMatch =
        method === "GET" ? /^\/drafts\/([a-z0-9_-]+)\/preview$/.exec(url.pathname) : null;
      if (previewMatch?.[1]) {
        const draft = await store.read(previewMatch[1]);
        send(
          response,
          200,
          draft.draftType === "cluster-hub" ? clusterPreviewPage(draft) : guidePreviewPage(draft),
        );
        return;
      }
      const validationMatch =
        method === "GET" ? /^\/drafts\/([a-z0-9_-]+)\/validate$/.exec(url.pathname) : null;
      if (validationMatch?.[1]) {
        let draft = await store.read(validationMatch[1]);
        if (draft.draftType === "cluster-hub") {
          const validation = validateClusterDraft(draft, readPublicContent());
          const status = validation.errors.length === 0 ? "ready-to-publish" : "editing";
          if (draft.status !== status) draft = await store.save({ ...draft, status });
          send(response, 200, clusterValidationPage(draft));
        } else {
          const validation = validateGuideDraft(draft, readPublicContent());
          const status = validation.errors.length === 0 ? "ready-to-publish" : "editing";
          if (draft.status !== status) draft = await store.save({ ...draft, status });
          send(response, 200, guideValidationPage(draft));
        }
        return;
      }
      const publishMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/publish$/.exec(url.pathname) : null;
      if (publishMatch?.[1]) {
        const draft = await store.read(publishMatch[1]);
        if (draft.status !== "ready-to-publish") {
          throw new TypeError("Validá el borrador antes de publicarlo.");
        }
        const result = await publisher.publish(draft);
        send(response, 200, publicationResultPage(draft, result));
        return;
      }
      const saveClusterMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/cluster$/.exec(url.pathname) : null;
      if (saveClusterMatch?.[1]) {
        const draft = await readClusterDraft(store, saveClusterMatch[1]);
        await store.save(updateClusterFromForm(draft, await readForm(request)));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const addGroupMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/groups$/.exec(url.pathname) : null;
      if (addGroupMatch?.[1]) {
        const form = await readForm(request);
        const draft = await readClusterDraft(store, addGroupMatch[1]);
        await store.save(
          addNavigationGroup(
            draft,
            requiredValue(form, "label", "La etiqueta"),
            primaryAxisValue(form),
          ),
        );
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const updateGroupMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/groups\/([a-z0-9_-]+)$/.exec(url.pathname)
          : null;
      if (updateGroupMatch?.[1] && updateGroupMatch[2]) {
        const form = await readForm(request);
        const draft = await readClusterDraft(store, updateGroupMatch[1]);
        const groupId = updateGroupMatch[2];
        if (!draft.navigationGroups.some((group) => group.id === groupId)) {
          throw new TypeError("El grupo no existe.");
        }
        await store.save(
          clusterDraftSchema.parse({
            ...draft,
            status: "editing",
            navigationGroups: draft.navigationGroups.map((group) =>
              group.id === groupId
                ? {
                    ...group,
                    label: requiredValue(form, "label", "La etiqueta"),
                    axis: primaryAxisValue(form),
                  }
                : group,
            ),
          }),
        );
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const groupActionMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/groups\/([a-z0-9_-]+)\/(up|down|remove)$/.exec(url.pathname)
          : null;
      if (groupActionMatch?.[1] && groupActionMatch[2] && groupActionMatch[3]) {
        const draft = await readClusterDraft(store, groupActionMatch[1]);
        const updated =
          groupActionMatch[3] === "remove"
            ? removeNavigationGroup(draft, groupActionMatch[2])
            : moveNavigationGroup(
                draft,
                groupActionMatch[2],
                groupActionMatch[3] === "up" ? -1 : 1,
              );
        await store.save(updated);
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const addGuideMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/groups\/([a-z0-9_-]+)\/guides$/.exec(url.pathname)
          : null;
      if (addGuideMatch?.[1] && addGuideMatch[2]) {
        const form = await readForm(request);
        const draft = await readClusterDraft(store, addGuideMatch[1]);
        await store.save(
          addGuideToGroup(
            draft,
            addGuideMatch[2],
            requiredValue(form, "guideId", "La guía"),
            readPublicContent(),
          ),
        );
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const guideActionMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/groups\/([a-z0-9_-]+)\/guides\/([a-z0-9_-]+)\/(up|down|remove)$/.exec(
              url.pathname,
            )
          : null;
      if (
        guideActionMatch?.[1] &&
        guideActionMatch[2] &&
        guideActionMatch[3] &&
        guideActionMatch[4]
      ) {
        const draft = await readClusterDraft(store, guideActionMatch[1]);
        const updated =
          guideActionMatch[4] === "remove"
            ? removeGuideFromGroup(draft, guideActionMatch[2], guideActionMatch[3])
            : moveGuideInGroup(
                draft,
                guideActionMatch[2],
                guideActionMatch[3],
                guideActionMatch[4] === "up" ? -1 : 1,
              );
        await store.save(updated);
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const saveGuideArchitectureMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/guide\/architecture$/.exec(url.pathname)
          : null;
      if (saveGuideArchitectureMatch?.[1]) {
        const draft = await readGuideDraft(store, saveGuideArchitectureMatch[1]);
        await store.save(guideArchitectureFromForm(draft, await readForm(request)));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const saveGuideCopyMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/guide\/copy$/.exec(url.pathname) : null;
      if (saveGuideCopyMatch?.[1]) {
        const draft = await readGuideDraft(store, saveGuideCopyMatch[1]);
        await store.save(guideCopyFromForm(draft, await readForm(request)));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const saveQuestionnaireMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/questionnaire$/.exec(url.pathname) : null;
      if (saveQuestionnaireMatch?.[1]) {
        const draft = await readGuideDraft(store, saveQuestionnaireMatch[1]);
        await store.save(questionnaireFromForm(draft, await readForm(request)));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const outlinePromptMatch =
        method === "GET" ? /^\/drafts\/([a-z0-9_-]+)\/outline-prompt$/.exec(url.pathname) : null;
      if (outlinePromptMatch?.[1]) {
        send(
          response,
          200,
          outlinePromptPage(await readGuideDraft(store, outlinePromptMatch[1]), provider),
        );
        return;
      }
      const finalPromptMatch =
        method === "GET" ? /^\/drafts\/([a-z0-9_-]+)\/final-prompt$/.exec(url.pathname) : null;
      if (finalPromptMatch?.[1]) {
        send(
          response,
          200,
          finalPromptPage(await readGuideDraft(store, finalPromptMatch[1]), provider),
        );
        return;
      }
      const generateOutlineMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/outline\/generate$/.exec(url.pathname)
          : null;
      if (generateOutlineMatch?.[1]) {
        const form = await readForm(request);
        if (form.get("promptVersion") !== "outline-v1") {
          throw new TypeError("Revisá el prompt vigente antes de ejecutar la generación.");
        }
        const draft = await readGuideDraft(store, generateOutlineMatch[1]);
        const generated = await generateGuideOutline(draft, readPublicContent(), provider);
        await store.save(generated);
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const generateFinalMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/final\/generate$/.exec(url.pathname) : null;
      if (generateFinalMatch?.[1]) {
        const form = await readForm(request);
        if (form.get("promptVersion") !== FINAL_PROMPT_VERSION) {
          throw new TypeError("Revisá el prompt final vigente antes de generar.");
        }
        const draft = await readGuideDraft(store, generateFinalMatch[1]);
        await store.save(await generateFinalGuide(draft, readPublicContent(), provider));
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const recommendationPromptMatch =
        method === "GET"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/prompt$/.exec(url.pathname)
          : null;
      if (recommendationPromptMatch?.[1] && recommendationPromptMatch[2]) {
        send(
          response,
          200,
          recommendationPromptPage(
            await readGuideDraft(store, recommendationPromptMatch[1]),
            recommendationPromptMatch[2],
            provider,
          ),
        );
        return;
      }
      const regenerateRecommendationMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/regenerate$/.exec(
              url.pathname,
            )
          : null;
      if (regenerateRecommendationMatch?.[1] && regenerateRecommendationMatch[2]) {
        const form = await readForm(request);
        if (form.get("promptVersion") !== RECOMMENDATION_PROMPT_VERSION) {
          throw new TypeError("Revisá el prompt de recomendación vigente antes de generar.");
        }
        const draft = await readGuideDraft(store, regenerateRecommendationMatch[1]);
        await store.save(
          await regenerateRecommendation(
            draft,
            regenerateRecommendationMatch[2],
            readPublicContent(),
            provider,
          ),
        );
        redirect(response, guideDraftSlotPath(draft.id, regenerateRecommendationMatch[2]));
        return;
      }
      const saveRecommendationCopyMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/copy$/.exec(url.pathname)
          : null;
      if (saveRecommendationCopyMatch?.[1] && saveRecommendationCopyMatch[2]) {
        const draft = await readGuideDraft(store, saveRecommendationCopyMatch[1]);
        await store.save(
          recommendationCopyFromForm(
            draft,
            saveRecommendationCopyMatch[2],
            await readForm(request),
          ),
        );
        redirect(response, guideDraftSlotPath(draft.id, saveRecommendationCopyMatch[2]));
        return;
      }
      const addRecommendationMatch =
        method === "POST" ? /^\/drafts\/([a-z0-9_-]+)\/recommendations$/.exec(url.pathname) : null;
      if (addRecommendationMatch?.[1]) {
        const form = await readForm(request);
        const draft = await readGuideDraft(store, addRecommendationMatch[1]);
        await store.save(
          addManualRecommendation(
            draft,
            requiredValue(form, "slotLabel", "El nombre del slot"),
            optionalValue(form, "slotIntent"),
            listValue(form, "searchTerms"),
          ),
        );
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      const catalogResolutionMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/catalog$/.exec(url.pathname)
          : null;
      if (catalogResolutionMatch?.[1] && catalogResolutionMatch[2]) {
        const form = await readForm(request);
        const draft = await readGuideDraft(store, catalogResolutionMatch[1]);
        const sourcingRequest = await ensureDraftSlotSourcingRequest(
          draft,
          catalogResolutionMatch[2],
          sourcingStore,
          briefStore.list().find(({ guideDraftId }) => guideDraftId === draft.id),
        );
        if (sourcingRequest.status !== "open" && sourcingRequest.status !== "partially-fulfilled") {
          throw new TypeError("La solicitud I.2 no está abierta para una nueva selección.");
        }
        const fulfillmentStatus = requiredValue(
          form,
          "fulfillmentStatus",
          "El estado de cumplimiento",
        );
        if (fulfillmentStatus !== "partially-fulfilled" && fulfillmentStatus !== "fulfilled") {
          throw new TypeError("El estado de cumplimiento no es válido.");
        }
        const productId = requiredValue(form, "productId", "El Product canónico");
        const saved = await sourcingStore.save(
          selectCanonicalProductForRequest(
            sourcingRequest,
            productId,
            catalog.read().products,
            fulfillmentStatus,
          ),
        );
        redirect(
          response,
          `/product-sourcing/${encodeURIComponent(saved.id)}?productId=${encodeURIComponent(productId)}`,
        );
        return;
      }
      const manualUrlResolutionMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/resolve-url$/.exec(
              url.pathname,
            )
          : null;
      if (manualUrlResolutionMatch?.[1] && manualUrlResolutionMatch[2]) {
        const form = await readForm(request);
        const pastedUrl = optionalValue(form, "url");
        const productUrl = optionalValue(form, "productUrl");
        const affiliateUrl = optionalValue(form, "affiliateUrl");
        const trackingId = optionalValue(form, "trackingId");
        const resolution = inspectManualProductUrl(
          {
            ...(pastedUrl ? { url: pastedUrl } : {}),
            ...(productUrl ? { productUrl } : {}),
            ...(affiliateUrl ? { affiliateUrl } : {}),
            ...(trackingId ? { trackingId } : {}),
          },
          catalog.root,
        );
        if (resolution.errors.length) {
          send(
            response,
            400,
            manualUrlResolutionPage(
              manualUrlResolutionMatch[1],
              manualUrlResolutionMatch[2],
              resolution,
            ),
          );
          return;
        }
        const draft = await readGuideDraft(store, manualUrlResolutionMatch[1]);
        const sourcingRequest = await ensureDraftSlotSourcingRequest(
          draft,
          manualUrlResolutionMatch[2],
          sourcingStore,
          briefStore.list().find(({ guideDraftId }) => guideDraftId === draft.id),
        );
        if (sourcingRequest.status !== "open" && sourcingRequest.status !== "partially-fulfilled") {
          throw new TypeError("La solicitud I.2 no está abierta para un nuevo candidato.");
        }
        const candidateInput = manualUrlCandidateInput(resolution);
        const existing = sourcingRequest.sourceCandidates.find(
          (candidate) =>
            (candidate.status === "needs-review" || candidate.status === "approved-for-intake") &&
            (candidate.sourceUrl === candidateInput.sourceUrl ||
              Boolean(candidate.externalId && candidate.externalId === candidateInput.externalId)),
        );
        const saved = existing
          ? sourcingRequest
          : await sourcingStore.save(addProductSourceCandidates(sourcingRequest, [candidateInput]));
        const candidate = existing ?? saved.sourceCandidates.at(-1)!;
        redirect(
          response,
          `/products/intake?returnTo=${encodeURIComponent(`/product-sourcing/${encodeURIComponent(saved.id)}`)}&requestId=${encodeURIComponent(saved.id)}&candidateId=${encodeURIComponent(candidate.id)}`,
        );
        return;
      }
      const selectProductMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/product$/.exec(url.pathname)
          : null;
      if (selectProductMatch?.[1] && selectProductMatch[2]) {
        const form = await readForm(request);
        const draft = await readGuideDraft(store, selectProductMatch[1]);
        await store.save(
          selectRecommendationProduct(
            draft,
            selectProductMatch[2],
            requiredValue(form, "productId", "El producto"),
            catalog.read(),
            form.get("allowDuplicate") === "yes",
          ),
        );
        redirect(response, guideDraftSlotPath(draft.id, selectProductMatch[2]));
        return;
      }
      const clearProductMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/product\/clear$/.exec(
              url.pathname,
            )
          : null;
      if (clearProductMatch?.[1] && clearProductMatch[2]) {
        const draft = await readGuideDraft(store, clearProductMatch[1]);
        await store.save(clearRecommendationProduct(draft, clearProductMatch[2]));
        redirect(response, guideDraftSlotPath(draft.id, clearProductMatch[2]));
        return;
      }
      const recommendationActionMatch =
        method === "POST"
          ? /^\/drafts\/([a-z0-9_-]+)\/recommendations\/([a-z0-9_-]+)\/(up|down|remove)$/.exec(
              url.pathname,
            )
          : null;
      if (
        recommendationActionMatch?.[1] &&
        recommendationActionMatch[2] &&
        recommendationActionMatch[3]
      ) {
        const draft = await readGuideDraft(store, recommendationActionMatch[1]);
        const updated =
          recommendationActionMatch[3] === "remove"
            ? removeRecommendation(draft, recommendationActionMatch[2])
            : moveRecommendation(
                draft,
                recommendationActionMatch[2],
                recommendationActionMatch[3] === "up" ? -1 : 1,
              );
        await store.save(updated);
        redirect(response, `/drafts/${draft.id}`);
        return;
      }
      if (method === "GET" && url.pathname === "/products") {
        send(response, 200, productListPage(catalog, url));
        return;
      }
      if (method === "GET" && url.pathname === "/product-intelligence") {
        const listed = await store.list();
        send(
          response,
          200,
          productIntelligencePage(
            catalog.root,
            listed.drafts.filter((draft): draft is GuideDraft => draft.draftType === "gift-guide"),
            listed.errors,
          ),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/product-sourcing") {
        send(response, 200, productSourcingListPage(sourcingStore, discoverySource));
        return;
      }
      if (method === "POST" && url.pathname === "/product-sourcing") {
        const input = productSourcingRequestFromForm(await readForm(request));
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede vincular un borrador inválido: ${listed.errors.join("; ")}`,
          );
        }
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        assertProductSourcingOrigin(input.origin, {
          candidates: candidateStore.list(),
          briefs: briefStore.list(),
          drafts: guideDrafts,
        });
        const created = await sourcingStore.save(createProductSourcingRequest(input));
        redirect(response, `/product-sourcing/${encodeURIComponent(created.id)}`);
        return;
      }
      if (method === "POST" && url.pathname === "/product-sourcing/discovery/plan") {
        const form = await readForm(request);
        const requestIds = [...new Set(form.getAll("requestId").map((id) => id.trim()))].filter(
          Boolean,
        );
        if (!requestIds.length) throw new TypeError("Seleccioná al menos una solicitud activa.");
        const selected = requestIds.map((id) => sourcingStore.get(id));
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede planificar contra borradores inválidos: ${listed.errors.join("; ")}`,
          );
        }
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        const planned = await generateProductSearchPlans(
          selected,
          provider,
          guideDrafts,
          briefStore.list(),
        );
        for (const sourcingRequest of planned) await sourcingStore.save(sourcingRequest);
        redirect(response, `/product-sourcing/${encodeURIComponent(planned[0]!.id)}`);
        return;
      }
      const productSourcingMatch =
        method === "GET" ? /^\/product-sourcing\/(request_[a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (productSourcingMatch?.[1]) {
        send(
          response,
          200,
          productSourcingDetailPage(
            sourcingStore.get(productSourcingMatch[1]),
            url,
            catalog,
            sourceStore,
            discoverySource,
          ),
        );
        return;
      }
      const productDiscoveryMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/discover$/.exec(url.pathname)
          : null;
      if (productDiscoveryMatch?.[1]) {
        if (!discoverySource) {
          throw new TypeError(
            "El descubrimiento externo está desactivado; usá catálogo, URL manual o idea-only.",
          );
        }
        const form = await readForm(request);
        const round = Number(requiredValue(form, "round", "La ronda"));
        if (round !== 1 && round !== 2) throw new TypeError("La ronda no es válida.");
        const sourcingRequest = sourcingStore.get(productDiscoveryMatch[1]);
        const sourcingOrigin = sourcingRequest.origin;
        const slotResolved =
          sourcingOrigin.kind === "recommendation-slot"
            ? Boolean(
                (await readGuideDraft(store, sourcingOrigin.guideDraftId)).recommendations.find(
                  ({ id }) => id === sourcingOrigin.recommendationSlotId,
                )?.productId,
              )
            : false;
        const saved = await sourcingStore.save(
          await runProductDiscovery(sourcingRequest, discoverySource, {
            products: catalog.read().products,
            allRequests: sourcingStore.list(),
            slotResolved,
            forceExternal: form.get("forceExternal") === "yes",
            round,
          }),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const productSourcingStatusMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/status$/.exec(url.pathname)
          : null;
      if (productSourcingStatusMatch?.[1]) {
        const form = await readForm(request);
        const status = requiredValue(form, "status", "El estado");
        if (!(PRODUCT_SOURCING_REQUEST_STATUSES as readonly string[]).includes(status)) {
          throw new TypeError("El estado de sourcing no es válido.");
        }
        const saved = await sourcingStore.save(
          transitionProductSourcingRequest(
            sourcingStore.get(productSourcingStatusMatch[1]),
            status as ProductSourcingRequestStatus,
          ),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const productSourcingSelectionMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/products$/.exec(url.pathname)
          : null;
      if (productSourcingSelectionMatch?.[1]) {
        const form = await readForm(request);
        const fulfillmentStatus = requiredValue(
          form,
          "fulfillmentStatus",
          "El estado de cumplimiento",
        );
        if (fulfillmentStatus !== "partially-fulfilled" && fulfillmentStatus !== "fulfilled") {
          throw new TypeError("El estado de cumplimiento no es válido.");
        }
        const saved = await sourcingStore.save(
          selectCanonicalProductForRequest(
            sourcingStore.get(productSourcingSelectionMatch[1]),
            requiredValue(form, "productId", "El Product canónico"),
            catalog.read().products,
            fulfillmentStatus,
          ),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const sourceCandidateCreateMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/source-candidates$/.exec(url.pathname)
          : null;
      if (sourceCandidateCreateMatch?.[1]) {
        const form = await readForm(request);
        const sourceKind = requiredValue(form, "sourceKind", "El origen del candidato");
        if (sourceKind !== "manual" && sourceKind !== "amazon-creators-api") {
          throw new TypeError("El origen del candidato no es válido.");
        }
        const marketplace = optionalValue(form, "marketplace");
        const externalId = optionalValue(form, "externalId");
        const sourceUrl = optionalValue(form, "sourceUrl");
        const saved = await sourcingStore.save(
          addProductSourceCandidates(sourcingStore.get(sourceCandidateCreateMatch[1]), [
            {
              sourceKind,
              provider: requiredValue(form, "provider", "El proveedor"),
              ...(marketplace ? { marketplace } : {}),
              ...(externalId ? { externalId } : {}),
              ...(sourceUrl ? { sourceUrl } : {}),
              name: requiredValue(form, "name", "El nombre observado"),
              sourceFacts: listValue(form, "sourceFacts", "\n") ?? [],
            },
          ]),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const sourceCandidateReviewMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/source-candidates\/review$/.exec(
              url.pathname,
            )
          : null;
      if (sourceCandidateReviewMatch?.[1]) {
        const form = await readForm(request);
        const sourcingRequest = sourcingStore.get(sourceCandidateReviewMatch[1]);
        const decisions = sourcingRequest.sourceCandidates.flatMap((candidate) => {
          const decision = form.get(candidate.id);
          return decision === "approved-for-intake" || decision === "rejected"
            ? [
                {
                  candidateId: candidate.id,
                  decision: decision as "approved-for-intake" | "rejected",
                },
              ]
            : [];
        });
        const saved = await sourcingStore.save(
          reviewProductSourceCandidates(sourcingRequest, decisions),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const sourceCandidateLinkMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/source-candidates\/(source_candidate_[a-z0-9_-]+)\/link$/.exec(
              url.pathname,
            )
          : null;
      if (sourceCandidateLinkMatch?.[1] && sourceCandidateLinkMatch[2]) {
        const form = await readForm(request);
        const products = catalog.read().products;
        const source = sourceStore.get(
          requiredValue(form, "productSourceId", "El ProductSourceRecord"),
          products,
        );
        const saved = await sourcingStore.save(
          linkProductSourceCandidate(
            sourcingStore.get(sourceCandidateLinkMatch[1]),
            sourceCandidateLinkMatch[2],
            source.productId,
            source.id,
            products,
            sourceStore.list(products),
          ),
        );
        redirect(response, `/product-sourcing/${encodeURIComponent(saved.id)}`);
        return;
      }
      const productSourcingAssignMatch =
        method === "POST"
          ? /^\/product-sourcing\/(request_[a-z0-9_-]+)\/assign$/.exec(url.pathname)
          : null;
      if (productSourcingAssignMatch?.[1]) {
        const form = await readForm(request);
        const sourcingRequest = sourcingStore.get(productSourcingAssignMatch[1]);
        if (sourcingRequest.origin.kind !== "recommendation-slot") {
          throw new TypeError("La solicitud no pertenece a un slot de GuideDraft.");
        }
        const draft = await readGuideDraft(store, sourcingRequest.origin.guideDraftId);
        await store.save(
          assignSourcedProductToDraftSlot(
            sourcingRequest,
            requiredValue(form, "productId", "El Product canónico"),
            draft,
            catalog.read(),
            form.get("allowDuplicate") === "yes",
          ),
        );
        redirect(response, productSourcingReturnPath(sourcingRequest));
        return;
      }
      if (method === "GET" && url.pathname === "/opportunities") {
        const content = readPublicContent(catalog.root);
        const listed = await store.list();
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        send(
          response,
          200,
          opportunityListPage(
            candidateStore,
            content,
            analyzeProductCoverage(content, guideDrafts, readProductGapReports(catalog.root)),
            provider,
            briefStore.list(),
          ),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/opportunities/generate") {
        const form = await readForm(request);
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede generar contra borradores inválidos: ${listed.errors.join("; ")}`,
          );
        }
        const content = readPublicContent(catalog.root);
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        await generateDivergentOpportunities(opportunityGenerationRequestFromForm(form), {
          content,
          drafts: listed.drafts,
          existingCandidates: candidateStore.list(),
          approvedBriefs: currentApprovedBriefs(),
          productCoverage: analyzeProductCoverage(
            content,
            guideDrafts,
            readProductGapReports(catalog.root),
          ),
          provider,
          candidateStore,
          repositoryRoot: catalog.root,
        });
        redirect(response, "/opportunities");
        return;
      }
      const opportunityRegenerationMatch =
        method === "POST"
          ? /^\/opportunities\/(candidate_[a-z0-9_-]+)\/regenerate$/.exec(url.pathname)
          : null;
      if (opportunityRegenerationMatch?.[1]) {
        const form = await readForm(request);
        const sourceCandidate = candidateStore.get(opportunityRegenerationMatch[1]);
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede generar contra borradores inválidos: ${listed.errors.join("; ")}`,
          );
        }
        const content = readPublicContent(catalog.root);
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        await generateDivergentOpportunities(
          opportunityGenerationRequestFromForm(form, sourceCandidate),
          {
            content,
            drafts: listed.drafts,
            existingCandidates: candidateStore.list(),
            approvedBriefs: currentApprovedBriefs(),
            productCoverage: analyzeProductCoverage(
              content,
              guideDrafts,
              readProductGapReports(catalog.root),
            ),
            provider,
            candidateStore,
            repositoryRoot: catalog.root,
          },
        );
        redirect(response, "/opportunities");
        return;
      }
      if (method === "POST" && url.pathname === "/opportunities/evaluate") {
        const form = await readForm(request);
        if (form.get("promptVersion") !== OPPORTUNITY_EVALUATION_PROMPT_VERSION) {
          throw new TypeError("Revisá el prompt convergente vigente antes de evaluar.");
        }
        const candidateIds = form
          .getAll("candidateId")
          .filter((value): value is string => typeof value === "string" && Boolean(value));
        if (!candidateIds.length) throw new TypeError("Seleccioná al menos un candidato.");
        const importedValues = [
          "signalId",
          "signalSource",
          "signalFrom",
          "signalTo",
          "signalSummary",
        ].map((name) => optionalValue(form, name));
        const importedSignals = importedValues.some(Boolean)
          ? [
              {
                id: requiredValue(form, "signalId", "El ID de señal"),
                source: requiredValue(form, "signalSource", "La fuente de señal"),
                dateRange: {
                  from: requiredValue(form, "signalFrom", "La fecha inicial"),
                  to: requiredValue(form, "signalTo", "La fecha final"),
                },
                summary: requiredValue(form, "signalSummary", "El resumen de señal"),
              },
            ]
          : [];
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede evaluar contra borradores inválidos: ${listed.errors.join("; ")}`,
          );
        }
        const content = readPublicContent(catalog.root);
        const guideDrafts = listed.drafts.filter(
          (draft): draft is GuideDraft => draft.draftType === "gift-guide",
        );
        await evaluateConvergentOpportunities(
          { candidateIds, importedSignals },
          {
            content,
            drafts: listed.drafts,
            existingCandidates: candidateStore.list(),
            productCoverage: analyzeProductCoverage(
              content,
              guideDrafts,
              readProductGapReports(catalog.root),
            ),
            approvedBriefs: currentApprovedBriefs(),
            provider,
            candidateStore,
            evaluationStore,
          },
        );
        redirect(response, `/opportunities/${encodeURIComponent(candidateIds[0]!)}`);
        return;
      }
      const editorialBriefMatch =
        method === "GET"
          ? /^\/opportunities\/briefs\/(brief_[a-z0-9_-]+)$/.exec(url.pathname)
          : null;
      if (editorialBriefMatch?.[1]) {
        send(
          response,
          200,
          briefPage(briefStore.get(editorialBriefMatch[1]), sourcingStore.list()),
        );
        return;
      }
      const saveEditorialBriefMatch =
        method === "POST"
          ? /^\/opportunities\/briefs\/(brief_[a-z0-9_-]+)$/.exec(url.pathname)
          : null;
      if (saveEditorialBriefMatch?.[1]) {
        const brief = briefStore.get(saveEditorialBriefMatch[1]);
        await briefStore.save(
          updateEditorialBrief(brief, editorialBriefEditsFromForm(await readForm(request))),
        );
        redirect(response, `/opportunities/briefs/${encodeURIComponent(brief.id)}`);
        return;
      }
      const approveEditorialBriefMatch =
        method === "POST"
          ? /^\/opportunities\/briefs\/(brief_[a-z0-9_-]+)\/approve$/.exec(url.pathname)
          : null;
      if (approveEditorialBriefMatch?.[1]) {
        const brief = briefStore.get(approveEditorialBriefMatch[1]);
        await briefStore.save(approveEditorialBrief(brief));
        redirect(response, `/opportunities/briefs/${encodeURIComponent(brief.id)}`);
        return;
      }
      const convertEditorialBriefMatch =
        method === "POST"
          ? /^\/opportunities\/briefs\/(brief_[a-z0-9_-]+)\/convert$/.exec(url.pathname)
          : null;
      if (convertEditorialBriefMatch?.[1]) {
        const converted = await convertApprovedBriefToGuideDraft(
          briefStore.get(convertEditorialBriefMatch[1]),
          candidateStore,
          briefStore,
          store,
          readPublicContent(catalog.root),
        );
        redirect(response, `/drafts/${encodeURIComponent(converted.draft.id)}`);
        return;
      }
      const opportunityMatch =
        method === "GET" ? /^\/opportunities\/(candidate_[a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (opportunityMatch?.[1]) {
        const listed = await store.list();
        if (listed.errors.length) {
          throw new TypeError(
            `No se puede comparar contra borradores inválidos: ${listed.errors.join("; ")}`,
          );
        }
        const candidate = candidateStore.get(opportunityMatch[1]);
        send(
          response,
          200,
          opportunityDetailPage(
            candidate,
            compareArticleCandidate(
              candidate,
              readPublicContent(catalog.root),
              listed.drafts,
              candidateStore.list(),
              currentApprovedBriefs(),
            ),
            evaluationStore.latestForCandidate(candidate.id),
          ),
        );
        return;
      }
      const opportunityStatusMatch =
        method === "POST"
          ? /^\/opportunities\/(candidate_[a-z0-9_-]+)\/status$/.exec(url.pathname)
          : null;
      if (opportunityStatusMatch?.[1]) {
        const form = await readForm(request);
        const status = requiredValue(form, "status", "El estado");
        if (!(CANDIDATE_STATUSES as readonly string[]).includes(status)) {
          throw new TypeError("El estado de la oportunidad no es válido.");
        }
        const candidate = candidateStore.get(opportunityStatusMatch[1]);
        await candidateStore.save(transitionArticleCandidate(candidate, status as CandidateStatus));
        redirect(response, `/opportunities/${encodeURIComponent(candidate.id)}`);
        return;
      }
      const opportunityDecisionMatch =
        method === "POST"
          ? /^\/opportunities\/(candidate_[a-z0-9_-]+)\/decision$/.exec(url.pathname)
          : null;
      if (opportunityDecisionMatch?.[1]) {
        const form = await readForm(request);
        const action = requiredValue(form, "action", "La decisión");
        if (!(CANDIDATE_DECISIONS as readonly string[]).includes(action)) {
          throw new TypeError("La decisión no es válida.");
        }
        const targetContentId = optionalValue(form, "targetContentId");
        const candidate = candidateStore.get(opportunityDecisionMatch[1]);
        const reason = requiredValue(form, "reason", "La razón");
        if (action === "create-article") {
          const approved = await approveCandidateForBrief(
            candidate,
            reason,
            candidateStore,
            briefStore,
          );
          redirect(response, `/opportunities/briefs/${encodeURIComponent(approved.brief.id)}`);
          return;
        }
        await candidateStore.save(
          applyCandidateDecision(candidate, {
            action: action as (typeof CANDIDATE_DECISIONS)[number],
            reason,
            ...(targetContentId ? { targetContentId } : {}),
          }),
        );
        redirect(response, `/opportunities/${encodeURIComponent(candidate.id)}`);
        return;
      }
      if (method === "GET" && url.pathname === "/affiliate-programs") {
        send(response, 200, affiliateProgramStatusPage(catalog.root));
        return;
      }
      if (method === "GET" && url.pathname === "/affiliate-operations") {
        send(response, 200, affiliateValidationPage(catalog.root));
        return;
      }
      if (method === "GET" && url.pathname === "/products/intake") {
        const requestId = optionalValue(url.searchParams, "requestId");
        const candidateId = optionalValue(url.searchParams, "candidateId");
        const review =
          requestId && candidateId
            ? (() => {
                const request = sourcingStore.get(requestId);
                return {
                  requestId: request.id,
                  candidateId,
                  candidate: requestCandidate(request, candidateId),
                } satisfies ManualProductCandidateReview;
              })()
            : undefined;
        send(
          response,
          200,
          manualProductIntakePage(
            undefined,
            safeReturnTo(url.searchParams.get("returnTo")),
            review,
          ),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/products/new") {
        send(
          response,
          200,
          productFormPage(undefined, safeReturnTo(url.searchParams.get("returnTo"))),
        );
        return;
      }
      const editProductMatch =
        method === "GET" ? /^\/products\/([a-z0-9_-]+)\/edit$/.exec(url.pathname) : null;
      if (editProductMatch?.[1]) {
        const product = catalog.get(editProductMatch[1]);
        const products = catalog.read().products;
        const sources = sourceStore.forProduct(product.id, products);
        const sourceId = url.searchParams.get("sourceId");
        const selectedSource = sourceId ? sourceStore.get(sourceId, products) : undefined;
        if (selectedSource && selectedSource.productId !== product.id) {
          throw new TypeError("La fuente no pertenece a este producto.");
        }
        if (selectedSource?.sourceKind === "manual-amazon") {
          throw new TypeError("Las fuentes Amazon se actualizan desde el intake Amazon US.");
        }
        send(
          response,
          200,
          productFormPage(product, undefined, sources, selectedSource, catalog.root),
        );
        return;
      }
      const saveProductSourceMatch =
        method === "POST" ? /^\/products\/([a-z0-9_-]+)\/sources$/.exec(url.pathname) : null;
      if (saveProductSourceMatch?.[1]) {
        const product = catalog.get(saveProductSourceMatch[1]);
        await sourceStore.save(
          productSourceFromForm(await readForm(request), product.id),
          catalog.read().products,
        );
        redirect(response, `/products/${encodeURIComponent(product.id)}/edit?saved=source`);
        return;
      }
      const saveAmazonAffiliateMatch =
        method === "POST"
          ? /^\/products\/([a-z0-9_-]+)\/amazon-affiliate$/.exec(url.pathname)
          : null;
      if (saveAmazonAffiliateMatch?.[1]) {
        const product = catalog.get(saveAmazonAffiliateMatch[1]);
        const form = await readForm(request);
        const input = {
          productUrl: requiredValue(form, "productUrl", "La URL de producto Amazon"),
          affiliateUrl: requiredValue(form, "affiliateUrl", "La URL afiliada Amazon"),
          trackingId: requiredValue(form, "trackingId", "El tracking ID"),
        };
        const products = catalog.read().products;
        const sources = sourceStore.forProduct(product.id, products);
        const validation = validateAmazonAffiliateIntake(
          input,
          readAmazonUsAffiliateProgram(catalog.root),
          sources,
        );
        if (validation.errors.length || form.get("confirm") !== "yes") {
          send(
            response,
            validation.errors.length ? 400 : 200,
            productFormPage(product, undefined, sources, undefined, catalog.root, validation),
          );
          return;
        }
        const source = createAmazonProductSourceRecord(product.id, input, validation);
        await catalog.save({
          ...product,
          productUrl: validation.normalizedProductUrl!,
          affiliateUrl: validation.normalizedAffiliateUrl!,
        });
        await sourceStore.save(source, catalog.read().products);
        redirect(response, `/products/${encodeURIComponent(product.id)}/edit?saved=amazon`);
        return;
      }
      if (method === "POST" && url.pathname === "/products/intake") {
        const form = await readForm(request);
        const input = manualProductIntakeFromForm(form);
        const preview = prepareManualProductIntake(input, catalog.root);
        const requestId = optionalValue(form, "requestId");
        const candidateId = optionalValue(form, "candidateId");
        const review =
          requestId && candidateId
            ? (() => {
                const request = sourcingStore.get(requestId);
                return {
                  requestId: request.id,
                  candidateId,
                  candidate: requestCandidate(request, candidateId),
                  request,
                };
              })()
            : undefined;
        if (review && form.get("confirm") === "yes" && !preview.errors.length) {
          try {
            requireCandidateReviewConfirmations(form, review.candidate);
          } catch (error) {
            preview.errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (preview.errors.length || form.get("confirm") !== "yes") {
          send(
            response,
            preview.errors.length ? 400 : 200,
            manualProductIntakePage(preview, safeReturnTo(form.get("returnTo")), review),
          );
          return;
        }
        const committed = await commitManualProductIntake(preview, catalog.root);
        if (review) {
          let updated = review.request;
          if (review.candidate.status === "needs-review") {
            updated = reviewProductSourceCandidates(updated, [
              { candidateId: review.candidateId, decision: "approved-for-intake" },
            ]);
          }
          updated = linkProductSourceCandidate(
            updated,
            review.candidateId,
            committed.product.id,
            committed.source.id,
            catalog.read().products,
            sourceStore.list(catalog.read().products),
          );
          await sourcingStore.save(updated);
        }
        const returnTo = safeReturnTo(form.get("returnTo"));
        redirect(
          response,
          returnTo?.startsWith("/product-sourcing/")
            ? `${returnTo}?productId=${encodeURIComponent(committed.product.id)}`
            : (returnTo ?? "/products?saved=intake"),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/products") {
        const form = await readForm(request);
        await catalog.save(productFromForm(form));
        redirect(response, safeReturnTo(form.get("returnTo")) ?? "/products?saved=1");
        return;
      }
      const saveProductMatch =
        method === "POST" ? /^\/products\/([a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (saveProductMatch?.[1]) {
        catalog.get(saveProductMatch[1]);
        await catalog.save(productFromForm(await readForm(request), saveProductMatch[1]));
        redirect(response, "/products?saved=1");
        return;
      }
      const toggleProductMatch =
        method === "POST" ? /^\/products\/([a-z0-9_-]+)\/toggle$/.exec(url.pathname) : null;
      if (toggleProductMatch?.[1]) {
        const product = catalog.get(toggleProductMatch[1]);
        await catalog.save({
          ...product,
          status: product.status === "active" ? "inactive" : "active",
        });
        redirect(response, "/products?saved=1");
        return;
      }
      if (method === "POST" && url.pathname === "/drafts/cluster") {
        const draft = await createCluster(store, await readForm(request));
        redirect(response, `/drafts/${encodeURIComponent(draft.id)}`);
        return;
      }
      if (method === "POST" && url.pathname === "/drafts/guide") {
        const draft = await createGuide(store, await readForm(request));
        redirect(response, `/drafts/${encodeURIComponent(draft.id)}`);
        return;
      }
      const match = method === "GET" ? /^\/drafts\/([a-z0-9_-]+)$/.exec(url.pathname) : null;
      if (match?.[1]) {
        const draft = await store.read(match[1]);
        send(
          response,
          200,
          draft.draftType === "cluster-hub"
            ? clusterEditorPage(draft)
            : guideEditorPage(draft, url, catalog, sourcingStore, briefStore),
        );
        return;
      }

      send(response, 404, page("No encontrado", "<h1>No encontramos esa pantalla</h1>"));
    } catch (error) {
      if (error instanceof ProviderError) {
        console.error(`AI provider error: ${error.debugSummary()}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      send(
        response,
        error instanceof TypeError || error instanceof RangeError ? 400 : 500,
        page(
          "Error",
          `<h1>No se pudo completar la operación</h1><p class="error">${escapeHtml(message)}</p><p><a href="/">Volver a borradores</a></p>`,
        ),
      );
    }
  });
}

function configuredPort(value = process.env.STUDIO_PORT): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("STUDIO_PORT debe ser un puerto entre 1 y 65535.");
  }
  return port;
}

export function startStudio(): void {
  const port = configuredPort();
  const provider = createGuideGenerationProvider();
  createStudioServer(new DraftStore(), new ProductCatalog(), provider).listen(
    port,
    STUDIO_HOST,
    () => {
      console.log(`Editorial Studio: http://${STUDIO_HOST}:${port}`);
      console.log(
        `AI provider: ${provider.providerId}${provider.modelId ? ` (${provider.modelId})` : ""}`,
      );
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStudio();
