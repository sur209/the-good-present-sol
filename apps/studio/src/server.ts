import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  PRIMARY_AXES,
  PUBLIC_SCHEMA_VERSION,
  guidePath,
  type PrimaryAxis,
  type Product,
} from "@the-good-present/content-schema";

import { DraftStore } from "./draft-store.ts";
import {
  createClusterDraft,
  createGuideDraft,
  type ClusterDraft,
  type EditorialDraft,
  type GuideDraft,
} from "./drafts.ts";
import {
  ProductCatalog,
  createProductId,
  matchProducts,
  productUsage,
  type ProductStatusFilter,
} from "./product-catalog.ts";
import { readPublicContent } from "./repository.ts";

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
  </style>
</head>
<body>
  <header>
    <a href="/">The Good Present · Studio</a>
    <nav aria-label="Principal"><a href="/">Borradores</a><a href="/drafts/new">Crear</a><a href="/products">Productos</a></nav>
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

function value(value: string | undefined): string {
  return escapeHtml(value ?? "");
}

function listText(items: string[] | undefined, separator = ", "): string {
  return value(items?.join(separator));
}

function productFormPage(product?: Product): string {
  const editing = Boolean(product);
  const action = editing ? `/products/${encodeURIComponent(product!.id)}` : "/products";
  const submitLabel = editing ? "Guardar producto" : "Crear producto";
  return page(
    editing ? `Editar ${product!.name}` : "Nuevo producto",
    `<p><a href="/products">← Catálogo</a></p>
     <h1>${editing ? "Editar producto" : "Nuevo producto"}</h1>
     <p class="notice">${editing ? `El ID estable <code>${escapeHtml(product!.id)}</code> y el nombre del archivo no cambian.` : "El Studio asignará un ID estable. Los productos se pueden reutilizar en varias guías."}</p>
     <form method="post" action="${action}" class="card">
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
     </form>`,
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
     </div>`,
  );
}

function draftPage(draft: EditorialDraft): string {
  const details = [
    ["ID estable", draft.id],
    ["Tipo", draft.draftType === "cluster-hub" ? "Hub de cluster" : "Guía de regalos"],
    ["Estado", draft.status],
    ["Idioma público", draft.language],
    ["Slug", draft.slug ?? "Sin definir"],
    ["Creado", formatDate(draft.createdAt)],
    ["Actualizado", formatDate(draft.updatedAt)],
  ];
  return page(
    draftName(draft),
    `<p><a href="/">← Borradores</a></p>
     <h1>${escapeHtml(draftName(draft))}</h1>
     <p class="notice">Este ID es la identidad canónica y no es un campo editable.</p>
     <dl>${details.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
     <p class="muted">La edición completa se habilita en las próximas fases.</p>`,
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

export function createStudioServer(store = new DraftStore(), catalog = new ProductCatalog()) {
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
      if (method === "GET" && url.pathname === "/products") {
        send(response, 200, productListPage(catalog, url));
        return;
      }
      if (method === "GET" && url.pathname === "/products/new") {
        send(response, 200, productFormPage());
        return;
      }
      const editProductMatch =
        method === "GET" ? /^\/products\/([a-z0-9_-]+)\/edit$/.exec(url.pathname) : null;
      if (editProductMatch?.[1]) {
        send(response, 200, productFormPage(catalog.get(editProductMatch[1])));
        return;
      }
      if (method === "POST" && url.pathname === "/products") {
        await catalog.save(productFromForm(await readForm(request)));
        redirect(response, "/products?saved=1");
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
        send(response, 200, draftPage(await store.read(match[1])));
        return;
      }

      send(response, 404, page("No encontrado", "<h1>No encontramos esa pantalla</h1>"));
    } catch (error) {
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
  createStudioServer().listen(port, STUDIO_HOST, () => {
    console.log(`Editorial Studio: http://${STUDIO_HOST}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStudio();
