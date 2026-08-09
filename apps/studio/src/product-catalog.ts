import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  PUBLIC_CONTENT_DIRECTORIES,
  productSchema,
  safeHttpUrlSchema,
  type GiftGuide,
  type Product,
} from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../scripts/content-files.ts";
import {
  REPOSITORY_ROOT,
  assertPublicContentCandidate,
  atomicWriteJson,
  readPublicContent,
  replaceSourceRecord,
} from "./repository.ts";

export type ProductStatusFilter = Product["status"] | "all";

export function createProductId(): string {
  return `product_${randomUUID()}`;
}

export function validateProductUrl(value: string | undefined): boolean {
  return !value || safeHttpUrlSchema.safeParse(value).success;
}

export function matchProducts(
  products: Product[],
  query = "",
  status: ProductStatusFilter = "all",
): Product[] {
  const terms = query.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  return products
    .filter((product) => status === "all" || product.status === status)
    .filter((product) => {
      const text = [
        product.name,
        product.brand,
        product.merchant,
        ...(product.categories ?? []),
        ...(product.interests ?? []),
        ...(product.recipients ?? []),
        ...(product.occasions ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("en-US");
      return terms.every((term) => text.includes(term));
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface ProductSlotQuery {
  slotLabel: string;
  slotIntent?: string | undefined;
  searchTerms?: string[] | undefined;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function productSlotMatchScore(product: Product, slot: ProductSlotQuery): number {
  const queryTokens = tokens(
    [slot.slotLabel, slot.slotIntent, ...(slot.searchTerms ?? [])].filter(Boolean).join(" "),
  );
  const productTokens = tokens(
    [
      product.name,
      product.brand,
      product.merchant,
      product.shortDescription,
      ...(product.categories ?? []),
      ...(product.interests ?? []),
      ...(product.recipients ?? []),
      ...(product.occasions ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return [...queryTokens].filter((token) => productTokens.has(token)).length;
}

export function suggestProductsForSlot(
  products: Product[],
  slot: ProductSlotQuery,
  limit = 5,
): Product[] {
  // ponytail: a linear scan is the right ceiling for a local catalog; add an index only after it grows.
  return products
    .filter((product) => product.status === "active")
    .map((product) => ({ product, score: productSlotMatchScore(product, slot) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.product.name.localeCompare(right.product.name),
    )
    .slice(0, limit)
    .map(({ product }) => product);
}

export function productUsage(guides: GiftGuide[], productId: string): GiftGuide[] {
  return guides.filter((guide) =>
    guide.recommendations.some((recommendation) => recommendation.productId === productId),
  );
}

export class ProductCatalog {
  private readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  get root(): string {
    return this.repositoryRoot;
  }

  read() {
    return readPublicContent(this.repositoryRoot);
  }

  get(id: string): Product {
    const product = this.read().products.find((item) => item.id === id);
    if (!product) throw new TypeError(`No existe el producto "${id}".`);
    return product;
  }

  async save(input: Product): Promise<Product> {
    const product = productSchema.parse(input);
    const sources = readPublicContentSources(this.repositoryRoot);
    const file = `${PUBLIC_CONTENT_DIRECTORIES.products}/${product.id}.json`;
    replaceSourceRecord(sources.products, file, product);
    assertPublicContentCandidate(sources, "El producto dejaría inválido el contenido publicado.");

    await atomicWriteJson(resolve(this.repositoryRoot, file), product);
    return product;
  }
}
