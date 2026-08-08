import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  PUBLIC_CONTENT_DIRECTORIES,
  formatValidationIssues,
  productSchema,
  safeHttpUrlSchema,
  validatePublicContent,
  type GiftGuide,
  type Product,
} from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../scripts/content-files.ts";
import { REPOSITORY_ROOT, atomicWriteJson, readPublicContent } from "./repository.ts";

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
    const existingIndex = sources.products.findIndex(
      (source) =>
        typeof source.data === "object" &&
        source.data !== null &&
        "id" in source.data &&
        source.data.id === product.id,
    );
    if (existingIndex === -1) sources.products.push({ file, data: product });
    else sources.products[existingIndex] = { file, data: product };

    const validation = validatePublicContent(sources);
    if (!validation.success) {
      throw new TypeError(
        `El producto dejaría inválido el contenido publicado.\n${formatValidationIssues(validation.issues)}`,
      );
    }

    await atomicWriteJson(resolve(this.repositoryRoot, file), product);
    return product;
  }
}
