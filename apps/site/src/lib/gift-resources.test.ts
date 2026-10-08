import assert from "node:assert/strict";
import test from "node:test";
import { informationalLinks, relatedIdeas, sourceLabel } from "./gift-resources.ts";
import type { GiftGuide, GuideRecommendation } from "@the-good-present/content-schema";

test("public source labels use only the requested names", () => {
  assert.equal(sourceLabel(["serpapi", "amazon-agent"]), "SerpAPI · Amazon Agent");
  assert.equal(sourceLabel(undefined), undefined);
});
test("resources are relevant, not a generic link attached to every gift", () => {
  assert.equal(
    informationalLinks("A Jewelry Organizer")[0]?.label,
    "Jewelry care and storage · GIA",
  );
  assert.equal(informationalLinks("A Cookbook Stand").length, 0);
});
test("internal links invite exploration by interest, not repeated product identity", () => {
  const idea = { heading: "Cooling pillowcase set", position: 1 } as GuideRecommendation;
  const current = { id: "one", clusterId: "nurses", recommendations: [idea] } as GiftGuide;
  const other = {
    id: "two",
    clusterId: "nurses",
    slug: "night-shift",
    recommendations: [],
  } as unknown as GiftGuide;
  const links = relatedIdeas(current, idea, [current, other]);
  assert.equal(links[0]?.guide, other);
  assert.match(links[0]?.label ?? "", /restful/);
  assert.equal(relatedIdeas(other, idea, [other]).length, 0);
  assert.equal(
    relatedIdeas(current, { heading: "Badge reel" } as GuideRecommendation, [current, other])
      .length,
    0,
  );
});
