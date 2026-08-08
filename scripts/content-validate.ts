import { assertValidPublicContent } from "@the-good-present/content-schema";

import { readPublicContentSources } from "./content-files.ts";

try {
  const content = assertValidPublicContent(readPublicContentSources());
  console.log(
    `Validated ${content.products.length} products, ${content.clusters.length} clusters, and ${content.guides.length} guides.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
