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
const nurseHub = read("apps/site/dist/nurse-gifts/index.html");
assert.ok(nurseHub.includes('class="hub-product-collage"'));
assert.ok(!nurseHub.includes("Useful context before product picks."));
assert.ok(!nurseHub.includes('id="choose-path"'));
const photoHeadings = [
  "A Cooling Pillowcase Set for Daytime Sleep",
  "A Coffee Tasting Set",
  "Insulated Lunch Bag for Long Shifts",
  "A Soft Lounge Robe",
  "Automatic wristwatch",
  "A Ceramic Keepsake Jewelry Box",
  "A Large Ceramic Baking Dish",
  "A Glass Plant Propagation Station",
];
for (const heading of photoHeadings) {
  const idea = guides
    .flatMap((guide) => guide.recommendations)
    .find((idea) => idea.heading === heading);
  const image = idea?.shoppingOptions?.find((option) => option.imageUrl)?.imageUrl;
  assert.ok(image && nurseHub.includes(image), heading + ": real product cover");
}
assert.ok(home.includes("Thoughtful gifts."));
assert.ok(!home.includes('aria-label="Explore"'));
assert.ok(!existsSync(resolve(root, "apps/site/dist/magazine")));
let options = 0;
for (const guide of guides) {
  const path = "/" + clusters.get(guide.clusterId).slug + "/" + guide.slug + "/";
  const html = read("apps/site/dist" + path + "index.html");
  if (clusters.get(guide.clusterId).slug === "nurse-gifts") {
    assert.ok(nurseHub.includes('href="' + path + '"'), path + ": hub access preserved");
  }
  assert.ok(home.includes('href="' + path + '"'), path + ": homepage link");
  assert.ok(html.includes('href="https://thegoodpresent.com' + path + '"'), path + ": canonical");
  assert.ok(html.includes("application/ld+json"), path + ": structured data");
  assert.ok(!/noindex|LOCAL DESIGN PREVIEW/.test(html), path + ": indexable");
  assert.ok(!html.includes("See this gift in "), path + ": contextual internal links");
  for (const idea of guide.recommendations) {
    assert.ok(html.includes('id="pick-' + idea.position + '"'), path + ": anchor");
    const productIds = (idea.shoppingOptions ?? []).map(
      ({ affiliateUrl }) => affiliateUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1],
    );
    assert.ok(productIds.length <= 10, path + ": at most ten products per idea");
    assert.equal(new Set(productIds).size, productIds.length, path + ": unique products per idea");
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
