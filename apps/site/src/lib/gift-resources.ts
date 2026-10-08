import type { GiftGuide, GuideRecommendation } from "@the-good-present/content-schema";

export const sourceLabel = (sources?: string[]) =>
  sources?.map((source) => (source === "serpapi" ? "SerpAPI" : "Amazon Agent")).join(" · ");

export function informationalLinks(heading: string) {
  const topics = [
    {
      match: /charging dock|charger|power bank/i,
      label: "USB Power Delivery · USB-IF",
      url: "https://www.usb.org/usb-charger-pd",
    },
    {
      match: /earbud|headphone|bluetooth/i,
      label: "Bluetooth audio compatibility · Bluetooth SIG",
      url: "https://www.bluetooth.com/media/le-audio/le-audio-faqs/",
    },
    {
      match: /jewel|pendant|bracelet/i,
      label: "Jewelry care and storage · GIA",
      url: "https://www.gia.edu/gia-news-research-tips-caring-jewelry",
    },
    {
      match: /blanket|robe|pillowcase|scarf|socks|throw/i,
      label: "Understanding fabric care · American Cleaning Institute",
      url: "https://www.cleaninginstitute.org/cleaning-tips/clothes/fabric-care",
    },
    {
      match: /baking dish|stoneware/i,
      label: "Stoneware care · Le Creuset",
      url: "https://www.lecreuset.co.uk/en_GB/how-to-care-for-and-use-stoneware/cap0180.html",
    },
  ];
  return topics.filter(({ match }) => match.test(heading)).slice(0, 2);
}

export function relatedIdeas(guide: GiftGuide, idea: GuideRecommendation, guides: GiftGuide[]) {
  const topics = [
    {
      match: /pillow|sleep mask|eye pillow|blackout|earplug|robe|slipper|heat.*wrap|heating pad/i,
      slugs: ["night-shift", "gifts-for-new-nurses", "practical"],
      label: "For more ways to make time off feel restful, explore these gift ideas",
    },
    {
      match: /coffee|tea|kettle|tumbler|travel mug/i,
      slugs: ["thank-you-gifts-for-nurse-preceptors-and-mentors", "night-shift"],
      label:
        "If a quiet coffee or tea break sounds like their kind of treat, explore more ideas here",
    },
    {
      match: /cook|baking|bakeware|saucepan|food|meal|lunch|spice|oil and vinegar/i,
      slugs: ["practical", "gifts-for-female-nurses", "practical-gifts-for-nurses"],
      label:
        "For someone who enjoys cooking or packing a good lunch, there are more useful kitchen gifts here",
    },
    {
      match: /watercolor|painting|puzzle|card game/i,
      slugs: ["christmas", "graduation", "night-shift"],
      label: "Looking for something to enjoy on a day off? Browse more gift ideas here",
    },
    {
      match: /book light|e-reader|laptop|planner|notebook|desk mat/i,
      slugs: ["gifts-for-nursing-students"],
      label: "For more gifts for a study space, explore these ideas for nursing students",
    },
    {
      match: /backpack|tote|power bank|charging|crossbody|travel document/i,
      slugs: ["gifts-for-nursing-students", "practical-gifts-for-nurses", "gifts-for-male-nurses"],
      label: "For more useful gifts to take along on a busy day, explore these ideas",
    },
    {
      match: /engraved|personalized|monogram|photo|pendant|necklace|bracelet|memento/i,
      slugs: ["personalized-gifts-for-nurses", "graduation"],
      label: "If you want the gift to carry a personal detail, explore more keepsake ideas here",
    },
  ];
  const topic = topics.find(({ match }) => match.test(idea.heading ?? ""));
  const other = topic?.slugs
    .map((slug) =>
      guides.find(
        (candidate) =>
          candidate.slug === slug &&
          candidate.clusterId === guide.clusterId &&
          candidate.id !== guide.id,
      ),
    )
    .find(Boolean);
  return other && topic ? [{ guide: other, label: topic.label }] : [];
}
