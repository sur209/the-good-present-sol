import { assertValidPublicContent } from "@the-good-present/content-schema";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { readPublicContentSources } from "../../scripts/content-files.js";

assertValidPublicContent(readPublicContentSources());

export default defineConfig({
  site: "https://thegoodpresent.com",
  output: "static",
  integrations: [sitemap({ filter: (page) => !page.endsWith("/404.html") })],
});
