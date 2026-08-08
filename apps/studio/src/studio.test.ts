import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import { DraftStore, assertSafeDraftId } from "./draft-store.ts";
import {
  DEFAULT_GIFT_COUNT,
  MAX_GIFT_COUNT,
  MIN_GIFT_COUNT,
  clusterDraftSchema,
  createClusterDraft,
  createGuideDraft,
  editorialDraftSchema,
  guideDraftSchema,
} from "./drafts.ts";
import {
  ProductCatalog,
  matchProducts,
  productUsage,
  validateProductUrl,
} from "./product-catalog.ts";
import { REPOSITORY_ROOT } from "./repository.ts";
import { STUDIO_HOST, createStudioServer } from "./server.ts";

test("discrimina borradores estrictos de hub y guía", () => {
  const cluster = createClusterDraft("cluster_test", new Date("2026-08-08T00:00:00.000Z"));
  const guide = createGuideDraft("guide_test", new Date("2026-08-08T00:00:00.000Z"));

  assert.equal(editorialDraftSchema.parse(cluster).draftType, "cluster-hub");
  assert.equal(editorialDraftSchema.parse(guide).draftType, "gift-guide");
  assert.equal(clusterDraftSchema.safeParse({ ...cluster, recommendations: [] }).success, false);
  assert.equal(guideDraftSchema.safeParse({ ...guide, navigationGroups: [] }).success, false);
});

test("crea borradores incompletos válidos con identidad estable", () => {
  const cluster = createClusterDraft("cluster_test");
  const guide = createGuideDraft("guide_test");

  assert.equal(cluster.id, "cluster_test");
  assert.equal(cluster.status, "editing");
  assert.equal(guide.id, "guide_test");
  assert.equal(guide.questionnaire.giftCount, DEFAULT_GIFT_COUNT);
  assert.equal(guide.status, "questionnaire");
});

test("limita la cantidad de regalos entre 3 y 20", () => {
  const guide = createGuideDraft("guide_test");
  assert.equal(
    guideDraftSchema.safeParse({
      ...guide,
      questionnaire: { giftCount: MIN_GIFT_COUNT - 1 },
    }).success,
    false,
  );
  assert.equal(
    guideDraftSchema.safeParse({
      ...guide,
      questionnaire: { giftCount: MAX_GIFT_COUNT + 1 },
    }).success,
    false,
  );
});

test("guarda, relee y reemplaza borradores con escritura atómica", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-drafts-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DraftStore(directory);
  const created = await store.save(
    createGuideDraft("guide_atomic", new Date("2026-08-08T00:00:00.000Z")),
    new Date("2026-08-08T01:00:00.000Z"),
  );
  const updated = await store.save(
    { ...created, title: "A useful guide" },
    new Date("2026-08-08T02:00:00.000Z"),
  );

  assert.equal((await store.read(created.id)).title, "A useful guide");
  assert.equal(updated.updatedAt, "2026-08-08T02:00:00.000Z");
  assert.deepEqual((await store.list()).errors, []);
  assert.deepEqual(await readdir(directory), ["guide_atomic.json"]);
  assert.equal(
    JSON.parse(await readFile(join(directory, "guide_atomic.json"), "utf8")).id,
    created.id,
  );
});

test("rechaza nombres inseguros y el Studio sólo enlaza loopback", () => {
  assert.throws(() => assertSafeDraftId("../outside"), /no válido/);
  assert.throws(() => assertSafeDraftId("Guide Uppercase"), /no válido/);
  assert.equal(STUDIO_HOST, "127.0.0.1");
});

test("sirve la lista y crea un borrador por HTTP sólo en loopback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "good-present-http-"));
  const server = createStudioServer(new DraftStore(directory));
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, STUDIO_HOST);
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const homeResponse = await fetch(origin);
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Borradores editoriales/);

  const createResponse = await fetch(`${origin}/drafts/cluster`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Nurses", slug: "nurses" }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  assert.match(createResponse.headers.get("location") ?? "", /^\/drafts\/cluster_/);
  assert.equal((await readdir(directory)).length, 1);
});

test("busca productos por texto y etiquetas, filtra estado y muestra uso", () => {
  const content = new ProductCatalog().read();
  const matches = matchProducts(content.products, "drinkware nurses", "active");
  assert.ok(matches.some((product) => product.id === "product_insulated-tumbler"));
  assert.ok(
    productUsage(content.guides, "product_insulated-tumbler").some(
      (guide) => guide.id === "guide_nurse-practical",
    ),
  );
  assert.equal(matchProducts(content.products, "", "inactive").length, 0);
});

test("acepta sólo URLs HTTP(S) absolutas", () => {
  assert.equal(validateProductUrl(undefined), true);
  assert.equal(validateProductUrl("https://example.com/product"), true);
  assert.equal(validateProductUrl("http://example.com/product"), true);
  assert.equal(validateProductUrl("ftp://example.com/product"), false);
  assert.equal(validateProductUrl("/relative"), false);
});

test("escribe productos por ID y bloquea desactivar uno publicado", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-catalog-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const catalog = new ProductCatalog(repository);
  const product = await catalog.save({
    schemaVersion: 1,
    id: "product_test-catalog",
    name: "Test catalog item",
    merchant: "Test merchant",
    productUrl: "https://example.com/test-catalog",
    shortDescription: "A deterministic test product.",
    categories: ["test"],
    status: "inactive",
    lastCheckedAt: "2026-08-08",
  });

  const file = join(repository, "content", "products", `${product.id}.json`);
  assert.equal(JSON.parse(await readFile(file, "utf8")).id, product.id);
  assert.equal(catalog.get(product.id).status, "inactive");
  assert.deepEqual(
    (await readdir(join(repository, "content", "products"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );

  const usedId = catalog.read().guides[0]!.recommendations[0]!.productId;
  const usedProduct = catalog.get(usedId);
  await assert.rejects(
    catalog.save({ ...usedProduct, status: "inactive" }),
    /dejaría inválido el contenido publicado/,
  );
});

test("expone búsqueda y alta manual de productos por HTTP", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "good-present-product-http-"));
  await cp(join(REPOSITORY_ROOT, "content"), join(repository, "content"), { recursive: true });
  const server = createStudioServer(
    new DraftStore(join(repository, "drafts")),
    new ProductCatalog(repository),
  );
  server.listen(0, STUDIO_HOST);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(repository, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${STUDIO_HOST}:${address.port}`;

  const listResponse = await fetch(`${origin}/products?q=tumbler&status=active`);
  assert.equal(listResponse.status, 200);
  assert.match(await listResponse.text(), /Leak-Resistant Insulated Tumbler/);
  const productDirectory = join(repository, "content", "products");
  const beforeCount = (await readdir(productDirectory)).length;

  const createResponse = await fetch(`${origin}/products`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Manual product",
      merchant: "Manual merchant",
      shortDescription: "Created from the native product form.",
      productUrl: "https://example.com/manual-product",
      status: "inactive",
      lastCheckedAt: "2026-08-08",
    }),
    redirect: "manual",
  });
  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get("location"), "/products?saved=1");
  assert.equal((await readdir(productDirectory)).length, beforeCount + 1);
});
