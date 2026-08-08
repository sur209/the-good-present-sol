import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_PATHS, canonicalUrl, clusterPath, guidePath, isValidSlug } from "./routes.js";

test("builds the only supported public route shapes", () => {
  assert.equal(clusterPath("nurse-gifts"), "/nurse-gifts/");
  assert.equal(guidePath("nurse-gifts", "under-25"), "/nurse-gifts/under-25/");
  assert.equal(
    canonicalUrl("https://thegoodpresent.com", guidePath("nurse-gifts", "practical")),
    "https://thegoodpresent.com/nurse-gifts/practical/",
  );
  assert.equal(PUBLIC_PATHS.giftGuides, "/gift-guides/");
});

test("rejects unsafe segments, reserved clusters, and non-root paths", () => {
  assert.equal(isValidSlug("night-shift"), true);
  assert.equal(isValidSlug("night/shift"), false);
  assert.throws(() => clusterPath("about"), /reserved public path/);
  assert.throws(() => guidePath("nurse-gifts", "../about"), /lowercase URL-safe slug/);
  assert.throws(() => canonicalUrl("https://thegoodpresent.com", "nurse-gifts"), /root-relative/);
  assert.throws(() => canonicalUrl("javascript:alert(1)", "/"), /http or https/);
});
