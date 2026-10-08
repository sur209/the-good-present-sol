import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Run after npm run build. Check the emitted pages, not only their templates.
const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const jsonFiles = (directory) =>
  readdirSync(resolve(root, directory))
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(read(directory + "/" + file)));
const clusters = new Map(jsonFiles("content/clusters").map((cluster) => [cluster.id, cluster]));
const guides = jsonFiles("content/guides").filter((guide) => guide.status === "published");
const home = read("apps/site/dist/index.html");
assert.ok(home.includes("Thoughtful gifts."));
assert.ok(!home.includes('aria-label="Explore"'));
assert.ok(!existsSync(resolve(root, "apps/site/dist/magazine")));
let options = 0;
for (const guide of guides) {
  const path = "/" + clusters.get(guide.clusterId).slug + "/" + guide.slug + "/";
  const html = read("apps/site/dist" + path + "index.html");
  assert.ok(home.includes('href="' + path + '"'), path + ": homepage link");
  assert.ok(html.includes('href="https://thegoodpresent.com' + path + '"'), path + ": canonical");
  assert.ok(html.includes("application/ld+json"), path + ": structured data");
  assert.ok(!/noindex|LOCAL DESIGN PREVIEW/.test(html), path + ": indexable");
  for (const idea of guide.recommendations) {
    assert.ok(html.includes('id="pick-' + idea.position + '"'), path + ": anchor");
    for (const option of idea.shoppingOptions ?? []) {
      for (const source of option.sources ?? []) {
        assert.ok(
          html.includes(source === "serpapi" ? "SerpAPI" : "Amazon Agent"),
          path + ": discovery label",
        );
      }
      assert.ok(
        html.includes(option.affiliateUrl.replaceAll("&", "&amp;")),
        path + ": affiliate link",
      );
      options++;
    }
  }
  assert.ok(
    html.includes("https://consumer.ftc.gov/articles/online-shopping"),
    path + ": informative link",
  );
}
assert.equal(read("apps/site/dist/CNAME").trim(), "thegoodpresent.com");
console.log(
  "Magazine smoke check: " + guides.length + " guides, " + options + " preserved product options.",
);
