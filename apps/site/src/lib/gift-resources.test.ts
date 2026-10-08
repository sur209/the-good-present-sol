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
test("related ideas link to the correct position in another guide", () => {
  const idea = { heading: "Coffee tasting set", position: 1 } as GuideRecommendation;
  const current = { id: "one", recommendations: [idea] } as GiftGuide;
  const other = { id: "two", recommendations: [{ ...idea, position: 4 }] } as GiftGuide;
  assert.deepEqual(relatedIdeas(current, idea, [current, other]), [{ guide: other, position: 4 }]);
});
