import { assertValidPublicContent } from "@the-good-present/content-schema";
import { defineConfig } from "astro/config";

import { readPublicContentSources } from "../../scripts/content-files.js";

assertValidPublicContent(readPublicContentSources());

export default defineConfig({
  output: "static",
});
