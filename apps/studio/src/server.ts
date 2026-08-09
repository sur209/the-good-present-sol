import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  PRIMARY_AXES,
  PUBLIC_SCHEMA_VERSION,
  clusterPath,
  guidePath,
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
  </style>
</head>
<body>
  <header>
    <a href="/">The Good Present · Studio</a>
    <nav aria-label="Principal"><a href="/">Borradores</a><a href="/drafts/new">Crear</a><a href="/products">Productos</a><a href="/affiliate-programs">Programas afiliados</a></nav>
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

const sourceKindLabels: Record<(typeof PRODUCT_SOURCE_KINDS)[number], string> = {
  manual: "Manual",
  "manual-amazon": "Manual · Amazon",
  "csv-import": "Importación CSV",
  "amazon-creators-api": "Amazon Creators API",
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
  return value && /^\/drafts\/[a-z0-9_-]+$/.test(value) ? value : undefined;
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
    `<div class="actions"><div><h1>Catálogo de productos</h1><p>Buscá por nombre, marca, comercio, categoría, interés, destinatario u ocasión.</p></div><a class="button" href="/products/new">Agregar producto</a></div>
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
): string {
  return `<form method="post" action="/drafts/${draft.id}/recommendations/${recommendationId}/product" class="card">
    <input type="hidden" name="productId" value="${product.id}">
    <strong>${escapeHtml(product.name)}</strong>
    <span class="muted">${escapeHtml(product.merchant)}</span>
    <p>${escapeHtml(product.shortDescription)}</p>
    ${duplicate ? '<label><input type="checkbox" name="allowDuplicate" value="yes" required> Confirmo que quiero repetir este producto en la guía.</label>' : ""}
    <button type="submit">${replacing ? "Reemplazar con este producto" : "Seleccionar"}</button>
  </form>`;
}

function recommendationSelectionSection(draft: GuideDraft, url: URL): string {
  const content = readPublicContent();
  const productsById = new Map(content.products.map((product) => [product.id, product]));
  const searchSlot = url.searchParams.get("slot");
  const productQuery = url.searchParams.get("productQ") ?? "";
  const duplicates = duplicateProductIds(draft);
  const duplicateWarning = duplicates.length
    ? `<div class="error"><strong>Productos repetidos confirmados:</strong> ${duplicates.map((id) => escapeHtml(productsById.get(id)?.name ?? id)).join(", ")}</div>`
    : "";
  const recommendations = [...draft.recommendations]
    .sort((left, right) => left.position - right.position)
    .map((recommendation, index) => {
      const selected = recommendation.productId
        ? productsById.get(recommendation.productId)
        : undefined;
      const isDuplicate = (productId: string) =>
        draft.recommendations.some(
          (item) => item.id !== recommendation.id && item.productId === productId,
        );
      const suggestions = suggestProductsForSlot(content.products, recommendation, 3)
        .filter((product) => product.id !== recommendation.productId)
        .map((product) =>
          productChoiceForm(
            draft,
            recommendation.id,
            product,
            isDuplicate(product.id),
            Boolean(selected),
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
                ),
              )
              .join("")
          : "";
      const replacementWarning =
        recommendation.editorialStatus === "needs-review"
          ? '<p class="error"><strong>Revisión obligatoria:</strong> el texto existente puede describir el producto anterior. Podés conservarlo temporalmente, pero la publicación queda bloqueada hasta editarlo o regenerar sólo esta recomendación.</p>'
          : "";
      return `<article class="card">
        <div class="actions"><h3>${recommendation.position}. ${escapeHtml(recommendation.slotLabel)}</h3><span class="status">${escapeHtml(recommendation.editorialStatus)}</span></div>
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
          ${selected ? `<p><strong>${escapeHtml(selected.name)}</strong> · ${escapeHtml(selected.merchant)}${selected.status === "inactive" ? ' · <span class="error">Inactivo</span>' : ""}</p><p>${escapeHtml(selected.shortDescription)}</p>` : '<p class="notice">Podés dejar este slot sin asignar mientras trabajás.</p>'}
          ${replacementWarning}
          ${selected ? `<form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/product/clear"><button type="submit">Quitar selección</button></form>` : ""}
        </section>
        ${
          selected
            ? `<form method="post" action="/drafts/${draft.id}/recommendations/${recommendation.id}/copy" class="card">
          <h4>Editar esta recomendación</h4>
          <label>Encabezado<input name="heading" value="${value(recommendation.heading)}"></label>
          <label>Descripción editorial<textarea name="editorialDescription" rows="4">${value(recommendation.editorialDescription)}</textarea></label>
          <label>Por qué encaja<textarea name="whyItFits" rows="3">${value(recommendation.whyItFits)}</textarea></label>
          <label>Ideal para<input name="bestFor" value="${value(recommendation.bestFor)}"></label>
          <label>Consideraciones<textarea name="considerations" rows="3">${value(recommendation.considerations)}</textarea></label>
          <label><input type="checkbox" name="markReady" value="yes"> Revisé el producto actual y quiero marcar esta recomendación como lista.</label>
          <div class="actions"><button type="submit">Guardar recomendación</button><a href="/drafts/${draft.id}/recommendations/${recommendation.id}/prompt">Ver prompt y regenerar sólo esta recomendación</a></div>
        </form>`
            : ""
        }
        <details open>
          <summary>${selected ? "Reemplazar producto" : "Sugerencias del catálogo"}</summary>
          <div class="grid">${suggestions || '<p class="muted">No hay coincidencias sugeridas.</p>'}</div>
        </details>
        <form method="get" action="/drafts/${draft.id}" class="card">
          <input type="hidden" name="slot" value="${recommendation.id}">
          <label>Buscar en todo el catálogo<input type="search" name="productQ" value="${searchSlot === recommendation.id ? escapeHtml(productQuery) : ""}"></label>
          <button type="submit">Buscar</button>
        </form>
        ${searchSlot === recommendation.id ? `<section><h4>Resultados del catálogo</h4><div class="grid">${results || '<p class="notice">No hay productos activos que coincidan.</p>'}</div></section>` : ""}
        <p><a href="/products/new?returnTo=${encodeURIComponent(`/drafts/${draft.id}`)}">Crear un producto nuevo y volver a este borrador</a></p>
      </article>`;
    })
    .join("");
  return `<section>
    <h2>Selección de productos</h2>
    <p>Actualizar un producto cambia el catálogo compartido y todas sus guías. Reemplazarlo aquí cambia sólo este slot y conserva su ID, posición y propósito.</p>
    ${duplicateWarning}
    <div class="grid">${recommendations || '<p class="notice">No hay slots. Generá un esquema o agregá uno manualmente.</p>'}</div>
    <form method="post" action="/drafts/${draft.id}/recommendations" class="card">
      <h3>Agregar slot manual</h3>
      <label>Nombre del slot<input name="slotLabel" required></label>
      <label>Propósito (opcional)<textarea name="slotIntent" rows="2"></textarea></label>
      <label>Términos de búsqueda, separados por coma<input name="searchTerms"></label>
      <button type="submit">Agregar slot</button>
    </form>
  </section>`;
}

function guideEditorPage(draft: GuideDraft, url: URL): string {
  const content = readPublicContent();
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
    : '<p class="notice">Todavía no hay un esquema. Guardá la arquitectura y el cuestionario antes de generar.</p>';
  const metadata = draft.generationMetadata
    ? `<p class="muted">Última generación: ${escapeHtml(draft.generationMetadata.providerId ?? "proveedor desconocido")} · ${escapeHtml(draft.generationMetadata.modelId ?? "modelo no informado")} · ${escapeHtml(draft.generationMetadata.promptVersion)} · ${escapeHtml(formatDate(draft.generationMetadata.generatedAt))}</p>`
    : "";
  return page(
    draftName(draft),
    `<p><a href="/">← Borradores</a></p>
     <div class="actions"><div><h1>${escapeHtml(draftName(draft))}</h1><p><code>${escapeHtml(draft.id)}</code> · ${escapeHtml(draft.status)}</p></div><a class="button" href="/drafts/${draft.id}/outline-prompt">Esquema</a><a class="button" href="/drafts/${draft.id}/final-prompt">Generación final</a><a class="button" href="/drafts/${draft.id}/preview">Vista previa</a><a class="button" href="/drafts/${draft.id}/validate">Validar</a></div>
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
     ${metadata}${outline}${recommendationSelectionSection(draft, url)}`,
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
    `<p><a href="/drafts/${draft.id}">← Editar guía</a></p>
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
        ${product ? `<p><strong>${escapeHtml(product.name)}</strong> · ${escapeHtml(product.merchant)}${product.priceLabel ? ` · ${escapeHtml(product.priceLabel)}` : ""}</p><p>${escapeHtml(product.shortDescription)}</p>` : '<p class="error">Producto sin resolver.</p>'}
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
) {
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
        redirect(response, `/drafts/${draft.id}`);
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
        redirect(response, `/drafts/${draft.id}`);
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
            readPublicContent(),
            form.get("allowDuplicate") === "yes",
          ),
        );
        redirect(response, `/drafts/${draft.id}`);
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
        redirect(response, `/drafts/${draft.id}`);
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
      if (method === "GET" && url.pathname === "/affiliate-programs") {
        send(response, 200, affiliateProgramStatusPage(catalog.root));
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
            : guideEditorPage(draft, url),
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
