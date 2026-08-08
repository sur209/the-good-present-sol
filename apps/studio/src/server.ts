import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  PRIMARY_AXES,
  assertValidPublicContent,
  type PrimaryAxis,
} from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../scripts/content-files.ts";
import { DraftStore, REPOSITORY_ROOT } from "./draft-store.ts";
import {
  createClusterDraft,
  createGuideDraft,
  type ClusterDraft,
  type EditorialDraft,
  type GuideDraft,
} from "./drafts.ts";

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
    nav { display: flex; gap: 1rem; }
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
  </style>
</head>
<body>
  <header>
    <a href="/">The Good Present · Studio</a>
    <nav aria-label="Principal"><a href="/">Borradores</a><a href="/drafts/new">Crear</a></nav>
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
  const content = assertValidPublicContent(readPublicContentSources(REPOSITORY_ROOT));
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

export function createStudioServer(store = new DraftStore()) {
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
