import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://thegoodpresent.com",
  output: "static",
  integrations: [sitemap({ filter: (page) => !page.endsWith("/404.html") })],
});
