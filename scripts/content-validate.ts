import { ContentValidationError, assertValidPublicContent } from "@the-good-present/content-schema";

import { readPublicContentSources } from "./content-files.js";

try {
  const content = assertValidPublicContent(readPublicContentSources());
  console.log(
    `Validated ${content.products.length} products, ${content.clusters.length} clusters, and ${content.guides.length} guides.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = error instanceof ContentValidationError ? 1 : 2;
}
