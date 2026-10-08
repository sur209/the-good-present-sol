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
  const asins = new Set(
    idea.shoppingOptions?.map(
      ({ affiliateUrl }) => new URL(affiliateUrl).pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1],
    ),
  );
  return guides
    .filter((other) => other.id !== guide.id)
    .flatMap((other) => {
      const match = other.recommendations.find(
        (candidate) =>
          (Boolean(idea.heading) &&
            candidate.heading?.toLowerCase() === idea.heading?.toLowerCase()) ||
          candidate.shoppingOptions?.some(({ affiliateUrl }) =>
            asins.has(new URL(affiliateUrl).pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1]),
          ),
      );
      return match ? [{ guide: other, position: match.position }] : [];
    })
    .slice(0, 2);
}
