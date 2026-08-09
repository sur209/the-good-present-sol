import {
  guidePath,
  type PrimaryAxis,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import type { EditorialDraft } from "../../drafts.ts";
import type { ArticleCandidate, CandidateDecision } from "./candidates.ts";

export const OPPORTUNITY_SIGNAL_KINDS = [
  "normalized-title",
  "slug-tokens",
  "primary-axis",
  "primary-intent",
  "taxonomies",
  "problem-solved",
  "proposed-sections",
  "product-categories",
] as const;

export type OpportunitySignalKind = (typeof OPPORTUNITY_SIGNAL_KINDS)[number];
export type OpportunityOverlapLevel = "low" | "medium" | "high";
export type OpportunityComparisonTargetKind =
  | "published-cluster"
  | "published-guide"
  | "cluster-draft"
  | "guide-draft"
  | "editorial-brief"
  | "candidate-history";

export interface ApprovedEditorialBriefComparisonRecord {
  id: string;
  clusterId: string;
  status: "approved";
  proposedTitle: string;
  proposedSlug: string;
  primaryAxis: PrimaryAxis;
  primaryIntent: string;
  taxonomies: ArticleCandidate["secondaryTaxonomies"];
  problemSolved: string;
  proposedSections: ArticleCandidate["proposedSections"];
  productCategories: string[];
}

export interface OpportunityComparisonSignal {
  kind: OpportunitySignalKind;
  level: OpportunityOverlapLevel;
  reason: string;
  sharedValues: string[];
}

export interface OpportunityComparison {
  targetId: string;
  targetKind: OpportunityComparisonTargetKind;
  title: string;
  status?: string;
  decision?: CandidateDecision;
  evidenceChange?: {
    changed: boolean;
    addedSourceSignalIds: string[];
    removedSourceSignalIds: string[];
    sharedSourceSignalIds: string[];
  };
  signals: OpportunityComparisonSignal[];
}

export interface OpportunityComparisonReport {
  publicContractViolations: string[];
  nearestEditorialState: OpportunityComparison[];
  priorDecisionHistory: OpportunityComparison[];
}

interface ComparableOpportunity {
  id: string;
  kind: OpportunityComparisonTargetKind;
  title: string;
  status?: string;
  slug?: string;
  primaryAxis?: PrimaryAxis;
  otherAxes?: PrimaryAxis[];
  primaryIntent?: string;
  taxonomies: string[];
  problemSolved?: string;
  sections: string[];
  productCategories: string[];
  decision?: CandidateDecision;
  sourceSignalIds?: string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "gift",
  "gifts",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "with",
]);

export function normalizeComparisonText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function meaningfulTokens(value: string): string[] {
  return normalizeComparisonText(value)
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function shared(left: readonly string[], right: readonly string[]): string[] {
  const rightValues = new Set(right);
  return unique(left.filter((value) => rightValues.has(value)));
}

function overlapLevel(ratio: number): OpportunityOverlapLevel {
  if (ratio >= 2 / 3) return "high";
  if (ratio >= 1 / 3) return "medium";
  return "low";
}

function textSignal(
  kind: OpportunitySignalKind,
  label: string,
  candidateValue: string,
  targetValue?: string,
): OpportunityComparisonSignal {
  if (!targetValue) {
    return {
      kind,
      level: "low",
      reason: `${label}: the target record has no comparable value.`,
      sharedValues: [],
    };
  }

  const candidateNormalized = normalizeComparisonText(candidateValue);
  const targetNormalized = normalizeComparisonText(targetValue);
  if (candidateNormalized && candidateNormalized === targetNormalized) {
    return {
      kind,
      level: "high",
      reason: `${label}: exact normalized match "${candidateNormalized}".`,
      sharedValues: [candidateNormalized],
    };
  }

  const candidateTokens = unique(meaningfulTokens(candidateValue));
  const targetTokens = unique(meaningfulTokens(targetValue));
  const sharedTokens = shared(candidateTokens, targetTokens);
  const denominator = Math.min(candidateTokens.length, targetTokens.length);
  const ratio = denominator ? sharedTokens.length / denominator : 0;
  return {
    kind,
    level: overlapLevel(ratio),
    reason: `${label}: ${sharedTokens.length} shared meaningful token(s) out of the smaller ${denominator}-token set (${Math.round(ratio * 100)}%): ${sharedTokens.join(", ") || "none"}.`,
    sharedValues: sharedTokens,
  };
}

function listSignal(
  kind: OpportunitySignalKind,
  label: string,
  candidateValues: readonly string[],
  targetValues: readonly string[],
): OpportunityComparisonSignal {
  if (!targetValues.length) {
    return {
      kind,
      level: "low",
      reason: `${label}: the target record has no comparable values.`,
      sharedValues: [],
    };
  }

  const candidatePhrases = unique(candidateValues.map(normalizeComparisonText));
  const targetPhrases = unique(targetValues.map(normalizeComparisonText));
  const sharedPhrases = shared(candidatePhrases, targetPhrases);
  const candidateTokens = unique(candidateValues.flatMap(meaningfulTokens));
  const targetTokens = unique(targetValues.flatMap(meaningfulTokens));
  const sharedTokens = shared(candidateTokens, targetTokens);
  const phraseDenominator = Math.min(candidatePhrases.length, targetPhrases.length);
  const tokenDenominator = Math.min(candidateTokens.length, targetTokens.length);
  const phraseRatio = phraseDenominator ? sharedPhrases.length / phraseDenominator : 0;
  const tokenRatio = tokenDenominator ? sharedTokens.length / tokenDenominator : 0;
  const ratio = Math.max(phraseRatio, tokenRatio);
  return {
    kind,
    level: overlapLevel(ratio),
    reason: `${label}: ${sharedPhrases.length} exact normalized value(s) and ${sharedTokens.length} shared meaningful token(s); strongest containment is ${Math.round(ratio * 100)}%. Shared: ${unique([...sharedPhrases, ...sharedTokens]).join(", ") || "none"}.`,
    sharedValues: unique([...sharedPhrases, ...sharedTokens]),
  };
}

function axisSignal(
  candidateAxis: PrimaryAxis,
  target: ComparableOpportunity,
): OpportunityComparisonSignal {
  if (target.primaryAxis === candidateAxis) {
    return {
      kind: "primary-axis",
      level: "high",
      reason: `Primary axis matches exactly: "${candidateAxis}".`,
      sharedValues: [candidateAxis],
    };
  }
  if (target.otherAxes?.includes(candidateAxis)) {
    return {
      kind: "primary-axis",
      level: "medium",
      reason: `The candidate primary axis "${candidateAxis}" appears in the target hub navigation, which has no single primary axis.`,
      sharedValues: [candidateAxis],
    };
  }
  return {
    kind: "primary-axis",
    level: "low",
    reason: target.primaryAxis
      ? `Primary axes differ: candidate "${candidateAxis}", target "${target.primaryAxis}".`
      : `The target record has no comparable primary axis; candidate axis is "${candidateAxis}".`,
    sharedValues: [],
  };
}

function flattenTaxonomies(
  taxonomies: ArticleCandidate["secondaryTaxonomies"] | undefined,
): string[] {
  return Object.values(taxonomies ?? {}).flatMap((values) => values ?? []);
}

function compareTarget(
  candidate: ArticleCandidate,
  target: ComparableOpportunity,
): OpportunityComparison {
  const candidateSections = candidate.proposedSections.map(
    ({ heading, purpose }) => `${heading} ${purpose}`,
  );
  const signals = [
    textSignal("normalized-title", "Normalized title", candidate.proposedTitle, target.title),
    textSignal(
      "slug-tokens",
      "Proposed slug tokens",
      candidate.proposedSlug.replaceAll("-", " "),
      target.slug?.replaceAll("-", " "),
    ),
    axisSignal(candidate.primaryAxis, target),
    textSignal("primary-intent", "Primary intent", candidate.primaryIntent, target.primaryIntent),
    listSignal(
      "taxonomies",
      "Taxonomies",
      flattenTaxonomies(candidate.secondaryTaxonomies),
      target.taxonomies,
    ),
    textSignal("problem-solved", "Problem solved", candidate.problemSolved, target.problemSolved),
    listSignal("proposed-sections", "Proposed sections", candidateSections, target.sections),
    listSignal(
      "product-categories",
      "Product categories",
      candidate.distinctiveProductCategories,
      target.productCategories,
    ),
  ];
  const currentSourceSignalIds = unique(candidate.sourceSignalIds ?? []);
  const targetSourceSignalIds = unique(target.sourceSignalIds ?? []);
  const evidenceChange =
    target.kind === "candidate-history"
      ? {
          addedSourceSignalIds: currentSourceSignalIds.filter(
            (id) => !targetSourceSignalIds.includes(id),
          ),
          removedSourceSignalIds: targetSourceSignalIds.filter(
            (id) => !currentSourceSignalIds.includes(id),
          ),
          sharedSourceSignalIds: shared(currentSourceSignalIds, targetSourceSignalIds),
        }
      : undefined;
  return {
    targetId: target.id,
    targetKind: target.kind,
    title: target.title,
    ...(target.status ? { status: target.status } : {}),
    ...(target.decision ? { decision: target.decision } : {}),
    ...(evidenceChange
      ? {
          evidenceChange: {
            ...evidenceChange,
            changed:
              evidenceChange.addedSourceSignalIds.length > 0 ||
              evidenceChange.removedSourceSignalIds.length > 0,
          },
        }
      : {}),
    signals,
  };
}

function productCategories(
  productIds: readonly (string | undefined)[],
  content: ValidatedPublicContent,
): string[] {
  const products = new Map(content.products.map((product) => [product.id, product]));
  return unique(productIds.flatMap((id) => (id ? (products.get(id)?.categories ?? []) : [])));
}

function publicTargets(content: ValidatedPublicContent): ComparableOpportunity[] {
  const guidesByCluster = new Map(
    content.clusters.map((cluster) => [
      cluster.id,
      content.guides.filter((guide) => guide.clusterId === cluster.id),
    ]),
  );
  return [
    ...content.clusters.map((cluster): ComparableOpportunity => {
      const guides = guidesByCluster.get(cluster.id) ?? [];
      return {
        id: cluster.id,
        kind: "published-cluster",
        title: cluster.title,
        status: cluster.status,
        slug: cluster.slug,
        otherAxes: unique(cluster.navigationGroups.map((group) => group.axis)) as PrimaryAxis[],
        taxonomies: guides.flatMap((guide) => flattenTaxonomies(guide.taxonomies)),
        sections: cluster.navigationGroups.map((group) => group.label),
        productCategories: productCategories(
          guides.flatMap((guide) => guide.recommendations.map(({ productId }) => productId)),
          content,
        ),
      };
    }),
    ...content.guides.map((guide): ComparableOpportunity => ({
      id: guide.id,
      kind: "published-guide",
      title: guide.title,
      status: guide.status,
      slug: guide.slug,
      primaryAxis: guide.primaryAxis,
      primaryIntent: guide.primaryIntent,
      taxonomies: flattenTaxonomies(guide.taxonomies),
      sections: guide.recommendations.map(
        ({ heading, whyItFits }) => `${heading ?? ""} ${whyItFits}`,
      ),
      productCategories: productCategories(
        guide.recommendations.map(({ productId }) => productId),
        content,
      ),
    })),
  ];
}

function draftTargets(
  drafts: readonly EditorialDraft[],
  content: ValidatedPublicContent,
): ComparableOpportunity[] {
  return drafts.map((draft): ComparableOpportunity => {
    if (draft.draftType === "cluster-hub") {
      return {
        id: draft.id,
        kind: "cluster-draft",
        title: draft.title ?? "Untitled cluster draft",
        status: draft.status,
        ...(draft.slug ? { slug: draft.slug } : {}),
        otherAxes: unique(draft.navigationGroups.map((group) => group.axis)) as PrimaryAxis[],
        taxonomies: [],
        sections: draft.navigationGroups.map((group) => group.label),
        productCategories: [],
      };
    }
    const sections =
      draft.outline?.slots.map(({ label, intent }) => `${label} ${intent}`) ??
      draft.recommendations.map(
        ({ slotLabel, slotIntent, heading }) => `${slotLabel} ${slotIntent ?? ""} ${heading ?? ""}`,
      );
    return {
      id: draft.id,
      kind: "guide-draft",
      title: draft.title ?? draft.outline?.provisionalTitle ?? "Untitled guide draft",
      status: draft.status,
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.primaryAxis ? { primaryAxis: draft.primaryAxis } : {}),
      ...(draft.primaryIntent ? { primaryIntent: draft.primaryIntent } : {}),
      taxonomies: flattenTaxonomies(draft.taxonomies),
      sections,
      productCategories: productCategories(
        draft.recommendations.map(({ productId }) => productId),
        content,
      ),
    };
  });
}

function briefTargets(
  briefs: readonly ApprovedEditorialBriefComparisonRecord[],
): ComparableOpportunity[] {
  return briefs.map((brief) => ({
    id: brief.id,
    kind: "editorial-brief",
    title: brief.proposedTitle,
    status: brief.status,
    slug: brief.proposedSlug,
    primaryAxis: brief.primaryAxis,
    primaryIntent: brief.primaryIntent,
    taxonomies: flattenTaxonomies(brief.taxonomies),
    problemSolved: brief.problemSolved,
    sections: brief.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
    productCategories: brief.productCategories,
  }));
}

function historyTargets(candidates: readonly ArticleCandidate[]): ComparableOpportunity[] {
  const historicalActions: readonly CandidateDecision["action"][] = [
    "reject",
    "merge",
    "hold",
    "add-as-section",
  ];
  return candidates
    .filter((candidate): candidate is ArticleCandidate & { decision: CandidateDecision } =>
      Boolean(candidate.decision && historicalActions.includes(candidate.decision.action)),
    )
    .map((candidate) => ({
      id: candidate.id,
      kind: "candidate-history",
      title: candidate.proposedTitle,
      status: candidate.status,
      slug: candidate.proposedSlug,
      primaryAxis: candidate.primaryAxis,
      primaryIntent: candidate.primaryIntent,
      taxonomies: flattenTaxonomies(candidate.secondaryTaxonomies),
      problemSolved: candidate.problemSolved,
      sections: candidate.proposedSections.map(({ heading, purpose }) => `${heading} ${purpose}`),
      productCategories: candidate.distinctiveProductCategories,
      decision: candidate.decision,
      ...(candidate.sourceSignalIds ? { sourceSignalIds: candidate.sourceSignalIds } : {}),
    }));
}

function sortNearest(comparisons: OpportunityComparison[]): OpportunityComparison[] {
  return comparisons.sort((left, right) => {
    for (const level of ["high", "medium"] as const) {
      const difference =
        right.signals.filter((signal) => signal.level === level).length -
        left.signals.filter((signal) => signal.level === level).length;
      if (difference) return difference;
    }
    return `${left.targetKind}:${left.targetId}`.localeCompare(
      `${right.targetKind}:${right.targetId}`,
    );
  });
}

function publicContractViolations(
  candidate: ArticleCandidate,
  content: ValidatedPublicContent,
): string[] {
  const cluster = content.clusters.find(({ id }) => id === candidate.clusterId);
  if (!cluster) return [`The canonical cluster "${candidate.clusterId}" does not exist.`];
  const violations: string[] = [];
  try {
    guidePath(cluster.slug, candidate.proposedSlug);
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }
  const collision = content.guides.find(
    (guide) => guide.clusterId === candidate.clusterId && guide.slug === candidate.proposedSlug,
  );
  if (collision) {
    violations.push(
      `The proposed slug already belongs to published guide "${collision.id}" in cluster "${candidate.clusterId}".`,
    );
  }
  return violations;
}

export function compareArticleCandidate(
  candidate: ArticleCandidate,
  content: ValidatedPublicContent,
  drafts: readonly EditorialDraft[],
  candidates: readonly ArticleCandidate[],
  approvedBriefs: readonly ApprovedEditorialBriefComparisonRecord[] = [],
): OpportunityComparisonReport {
  // ponytail: local full scans favor transparent evidence; add indexes only if detail rendering is measured as slow.
  const nearestEditorialState = sortNearest(
    [
      ...publicTargets(content),
      ...draftTargets(drafts, content),
      ...briefTargets(approvedBriefs),
    ].map((target) => compareTarget(candidate, target)),
  );
  const priorDecisionHistory = sortNearest(
    historyTargets(candidates)
      .filter(({ id }) => id !== candidate.id)
      .map((target) => compareTarget(candidate, target)),
  );
  return {
    publicContractViolations: publicContractViolations(candidate, content),
    nearestEditorialState,
    priorDecisionHistory,
  };
}
