import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { atomicWriteJson, REPOSITORY_ROOT } from "../../repository.ts";

export const EDITORIAL_FEEDBACK_DIRECTORY = "editorial-data/editorial-feedback";
export const EDITORIAL_FEEDBACK_EVENT_TYPES = [
  "catalog-product-selected",
  "candidate-sent-to-review",
  "candidate-approved-for-intake",
  "candidate-rejected",
  "search-again-requested",
  "search-plan-edited",
  "automatic-discovery-invoked",
  "candidate-replaced",
  "manual-url-supplied",
  "manual-url-supplied-after-automatic-discovery-insufficient",
  "canonical-product-created",
  "canonical-product-reused",
  "product-assigned",
  "product-removed",
  "product-replaced",
  "recommendation-left-idea-only",
  "idea-only-recommendation-resolved",
  "recommendation-published",
  "product-marked-benchmark",
  "benchmark-retired",
] as const;
export const EDITORIAL_FEEDBACK_REASONS = [
  "wrong-product-class",
  "too-generic",
  "insufficient-specificity",
  "poor-recipient-fit",
  "poor-context-fit",
  "low-gift-desirability",
  "low-giftability",
  "redundant-with-guide",
  "weak-evidence",
  "compatibility-risk",
  "maintenance-concern",
  "budget-mismatch",
  "commercial-mismatch",
  "provider-results-poor",
  "manual-choice-better",
  "other",
] as const;
export const EDITORIAL_FEEDBACK_DIAGNOSTIC_AREAS = [
  "provider-quality",
  "search-query-planning",
  "product-class-profile",
  "fit-ranking",
  "catalog-coverage",
  "collection-diversity",
] as const;
export const EDITORIAL_FEEDBACK_CANDIDATE_KINDS = [
  "manual",
  "amazon-creators-api",
  "serpapi",
  "dataforseo",
] as const;

const nonEmptyText = z.string().trim().min(1);
const safeId = nonEmptyText.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const guideId = safeId.regex(/^guide_/);
const requestId = safeId.regex(/^request_/);
const candidateId = safeId.regex(/^source_candidate_/);
const productId = safeId.regex(/^product_/);
const benchmarkId = safeId.regex(/^benchmark_/);
const eventId = safeId.regex(/^feedback_event_/);
const timestamp = z.iso.datetime({ offset: true });
const profileReferenceSchema = z.strictObject({
  classId: safeId,
  version: z.number().int().positive(),
});

export const editorialFeedbackEventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("editorial-feedback-event"),
    id: eventId,
    eventType: z.enum(EDITORIAL_FEEDBACK_EVENT_TYPES),
    occurredAt: timestamp,
    guideId: guideId.optional(),
    recommendationId: safeId.optional(),
    requestId: requestId.optional(),
    candidateId: candidateId.optional(),
    previousCandidateId: candidateId.optional(),
    canonicalProductId: productId.optional(),
    previousCanonicalProductId: productId.optional(),
    provider: nonEmptyText.optional(),
    candidateSourceKind: z.enum(EDITORIAL_FEEDBACK_CANDIDATE_KINDS).optional(),
    productClassProfile: profileReferenceSchema.optional(),
    rankingPolicyVersion: nonEmptyText.optional(),
    benchmarkId: benchmarkId.optional(),
    reason: z.enum(EDITORIAL_FEEDBACK_REASONS).optional(),
    rationale: nonEmptyText.optional(),
    diagnosticAreas: z.array(z.enum(EDITORIAL_FEEDBACK_DIAGNOSTIC_AREAS)).min(1).optional(),
    discoveryRound: z.number().int().min(1).max(2).optional(),
    providerInvocationCount: z.number().int().positive().optional(),
    publicationResolution: z.enum(["product-backed", "idea-only"]).optional(),
  })
  .superRefine((event, validation) => {
    if (event.recommendationId && !event.guideId) {
      validation.addIssue({
        code: "custom",
        path: ["guideId"],
        message: "A recommendation reference requires its Guide ID.",
      });
    }
    if (event.candidateId && !event.requestId) {
      validation.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "A candidate reference requires its I.2 sourcing request ID.",
      });
    }
    if (event.previousCandidateId && !event.candidateId) {
      validation.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: "A replaced candidate requires the current candidate ID.",
      });
    }
    if (event.previousCanonicalProductId && !event.canonicalProductId) {
      validation.addIssue({
        code: "custom",
        path: ["canonicalProductId"],
        message: "A replaced Product requires the current canonical Product ID.",
      });
    }

    const candidateEvent = [
      "candidate-sent-to-review",
      "candidate-approved-for-intake",
      "candidate-rejected",
    ].includes(event.eventType);
    if (candidateEvent && (!event.requestId || !event.candidateId || !event.provider)) {
      validation.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: "Candidate review events require request, candidate, and provider references.",
      });
    }
    if (candidateEvent && !event.candidateSourceKind) {
      validation.addIssue({
        code: "custom",
        path: ["candidateSourceKind"],
        message: "Candidate review events require the existing candidate source kind.",
      });
    }

    const discoveryEvent = event.eventType === "automatic-discovery-invoked";
    if (discoveryEvent && (!event.requestId || !event.provider || !event.discoveryRound)) {
      validation.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "Discovery events require request, provider, and round references.",
      });
    }
    if (discoveryEvent && !event.providerInvocationCount) {
      validation.addIssue({
        code: "custom",
        path: ["providerInvocationCount"],
        message: "A discovery event requires at least one paid/provider invocation.",
      });
    }
    if (event.eventType === "search-again-requested" && !event.requestId) {
      validation.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "A search-again event requires its I.2 sourcing request ID.",
      });
    }
    if (event.eventType === "recommendation-published" && !event.publicationResolution) {
      validation.addIssue({
        code: "custom",
        path: ["publicationResolution"],
        message: "A publication event requires its Product-backed or idea-only resolution.",
      });
    }
    if (
      event.eventType === "product-marked-benchmark" &&
      (!event.benchmarkId || !event.canonicalProductId)
    ) {
      validation.addIssue({
        code: "custom",
        path: ["benchmarkId"],
        message: "A benchmark event requires the existing benchmark and Product IDs.",
      });
    }
    if (event.eventType === "benchmark-retired" && !event.benchmarkId) {
      validation.addIssue({
        code: "custom",
        path: ["benchmarkId"],
        message: "A retired benchmark event requires its existing benchmark ID.",
      });
    }
    if (event.eventType === "candidate-replaced" && !event.previousCandidateId) {
      validation.addIssue({
        code: "custom",
        path: ["previousCandidateId"],
        message: "A replaced candidate event requires the previous candidate ID.",
      });
    }
    if (event.eventType === "product-replaced" && !event.previousCanonicalProductId) {
      validation.addIssue({
        code: "custom",
        path: ["previousCanonicalProductId"],
        message: "A replaced Product event requires the previous canonical Product ID.",
      });
    }
    if (event.eventType === "product-removed" && !event.previousCanonicalProductId) {
      validation.addIssue({
        code: "custom",
        path: ["previousCanonicalProductId"],
        message: "A removed Product event requires the previous canonical Product ID.",
      });
    }
  });

export type EditorialFeedbackEvent = z.infer<typeof editorialFeedbackEventSchema>;
export type EditorialFeedbackEventType = EditorialFeedbackEvent["eventType"];
export type EditorialFeedbackReason = (typeof EDITORIAL_FEEDBACK_REASONS)[number];
export type EditorialFeedbackDiagnosticArea = (typeof EDITORIAL_FEEDBACK_DIAGNOSTIC_AREAS)[number];
export type EditorialFeedbackCandidateKind = (typeof EDITORIAL_FEEDBACK_CANDIDATE_KINDS)[number];
export type EditorialFeedbackEventInput = Omit<
  EditorialFeedbackEvent,
  "schemaVersion" | "recordType" | "id" | "occurredAt"
>;

export const EDITORIAL_FEEDBACK_POLICY = {
  onlineLearning: false,
  automaticRankingMutation: false,
  automaticProductClassProfileMutation: false,
  automaticBenchmarkCreation: false,
  automaticPersonalization: false,
} as const;

export function createEditorialFeedbackEvent(
  input: EditorialFeedbackEventInput,
  now = new Date(),
  id = `feedback_event_${randomUUID()}`,
): EditorialFeedbackEvent {
  return editorialFeedbackEventSchema.parse({
    schemaVersion: 1,
    recordType: "editorial-feedback-event",
    id,
    ...input,
    occurredAt: now.toISOString(),
  });
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function editorialFeedbackEventPath(repositoryRoot: string, id: string): string {
  eventId.parse(id);
  return resolve(repositoryRoot, EDITORIAL_FEEDBACK_DIRECTORY, `${id}.json`);
}

export function readEditorialFeedbackEvents(
  repositoryRoot = REPOSITORY_ROOT,
): EditorialFeedbackEvent[] {
  const directory = resolve(repositoryRoot, EDITORIAL_FEEDBACK_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("feedback_event_") && entry.name.endsWith(".json"),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const file = relative(repositoryRoot, resolve(directory, entry.name)).replaceAll("\\", "/");
      const parsed = editorialFeedbackEventSchema.safeParse(
        JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
      );
      if (!parsed.success) {
        throw new TypeError(
          `Invalid editorial feedback event "${file}": ${validationMessage(parsed.error)}`,
        );
      }
      if (`${parsed.data.id}.json` !== entry.name) {
        throw new TypeError(`Invalid editorial feedback event "${file}": id must match filename.`);
      }
      return parsed.data;
    })
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
    );
}

export interface EditorialFeedbackRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface EditorialFeedbackProviderAcceptance extends EditorialFeedbackRate {
  accepted: number;
  rejected: number;
}

export interface EditorialFeedbackSummary {
  eventCount: number;
  catalogResolutionRate: EditorialFeedbackRate;
  automaticCandidateAcceptanceRate: EditorialFeedbackRate;
  manualUrlRate: EditorialFeedbackRate;
  ideaOnlyPublicationRate: EditorialFeedbackRate;
  laterProductResolutionRate: EditorialFeedbackRate;
  searchAgainRate: EditorialFeedbackRate;
  rejectionReasons: Record<EditorialFeedbackReason, number>;
  productClassManualInterventionRate: Record<string, EditorialFeedbackRate>;
  providerAcceptanceRate: Record<string, EditorialFeedbackProviderAcceptance>;
  dataForSeoPaidProviderInvocationCount: number;
  benchmarkCreationRate: EditorialFeedbackRate;
  benchmarkAssociatedLaterAcceptanceRate: EditorialFeedbackRate;
  diagnosticAreaCounts: Record<EditorialFeedbackDiagnosticArea, number>;
}

function rate(numerator: number, denominator: number): EditorialFeedbackRate {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function emptyReasonCounts(): Record<EditorialFeedbackReason, number> {
  return Object.fromEntries(EDITORIAL_FEEDBACK_REASONS.map((reason) => [reason, 0])) as Record<
    EditorialFeedbackReason,
    number
  >;
}

function emptyDiagnosticCounts(): Record<EditorialFeedbackDiagnosticArea, number> {
  return Object.fromEntries(EDITORIAL_FEEDBACK_DIAGNOSTIC_AREAS.map((area) => [area, 0])) as Record<
    EditorialFeedbackDiagnosticArea,
    number
  >;
}

function resolutionOutcome(event: EditorialFeedbackEvent): boolean {
  return [
    "catalog-product-selected",
    "candidate-approved-for-intake",
    "manual-url-supplied",
    "manual-url-supplied-after-automatic-discovery-insufficient",
    "recommendation-left-idea-only",
  ].includes(event.eventType);
}

function classDecision(event: EditorialFeedbackEvent): boolean {
  return [
    "automatic-discovery-invoked",
    "catalog-product-selected",
    "candidate-approved-for-intake",
    "candidate-rejected",
    "manual-url-supplied",
    "manual-url-supplied-after-automatic-discovery-insufficient",
    "search-plan-edited",
  ].includes(event.eventType);
}

function manualIntervention(event: EditorialFeedbackEvent): boolean {
  return [
    "manual-url-supplied",
    "manual-url-supplied-after-automatic-discovery-insufficient",
    "search-plan-edited",
  ].includes(event.eventType);
}

export function summarizeEditorialFeedback(
  events: readonly EditorialFeedbackEvent[],
): EditorialFeedbackSummary {
  const resolutionEvents = events.filter(resolutionOutcome);
  const automaticReviews = events.filter(
    ({ eventType, candidateSourceKind }) =>
      (eventType === "candidate-approved-for-intake" || eventType === "candidate-rejected") &&
      candidateSourceKind !== "manual",
  );
  const automaticAccepted = automaticReviews.filter(
    ({ eventType }) => eventType === "candidate-approved-for-intake",
  ).length;
  const manualUrls = resolutionEvents.filter(
    ({ eventType }) =>
      eventType === "manual-url-supplied" ||
      eventType === "manual-url-supplied-after-automatic-discovery-insufficient",
  ).length;
  const publicationEvents = events.filter(
    ({ eventType }) => eventType === "recommendation-published",
  );
  const ideaOnlyPublications = publicationEvents.filter(
    ({ publicationResolution }) => publicationResolution === "idea-only",
  ).length;
  const firstDiscoveryRuns = events.filter(
    ({ eventType, discoveryRound }) =>
      eventType === "automatic-discovery-invoked" && discoveryRound === 1,
  ).length;
  const searchAgain = events.filter(
    ({ eventType }) => eventType === "search-again-requested",
  ).length;
  const rejectionReasons = emptyReasonCounts();
  for (const event of events) {
    if (event.eventType === "candidate-rejected" && event.reason)
      rejectionReasons[event.reason] += 1;
  }

  const productClassTotals = new Map<string, { numerator: number; denominator: number }>();
  for (const event of events) {
    if (!event.productClassProfile || !classDecision(event)) continue;
    const key = event.productClassProfile.classId;
    const current = productClassTotals.get(key) ?? { numerator: 0, denominator: 0 };
    current.denominator += 1;
    if (manualIntervention(event)) current.numerator += 1;
    productClassTotals.set(key, current);
  }
  const productClassManualInterventionRate = Object.fromEntries(
    [...productClassTotals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([classId, totals]) => [classId, rate(totals.numerator, totals.denominator)]),
  );

  const providers = new Map<string, { accepted: number; rejected: number }>();
  for (const event of events) {
    if (
      (event.eventType !== "candidate-approved-for-intake" &&
        event.eventType !== "candidate-rejected") ||
      !event.provider
    ) {
      continue;
    }
    const current = providers.get(event.provider) ?? { accepted: 0, rejected: 0 };
    if (event.eventType === "candidate-approved-for-intake") current.accepted += 1;
    else current.rejected += 1;
    providers.set(event.provider, current);
  }
  const providerAcceptanceRate = Object.fromEntries(
    [...providers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, counts]) => [
        provider,
        {
          ...counts,
          ...rate(counts.accepted, counts.accepted + counts.rejected),
        },
      ]),
  );

  const dataForSeoPaidProviderInvocationCount = events
    .filter(
      ({ eventType, candidateSourceKind, provider }) =>
        eventType === "automatic-discovery-invoked" &&
        (candidateSourceKind === "dataforseo" ||
          provider?.toLocaleLowerCase("en-US") === "dataforseo"),
    )
    .reduce((total, event) => total + (event.providerInvocationCount ?? 0), 0);
  const benchmarkEvents = events.filter(
    ({ eventType }) => eventType === "product-marked-benchmark",
  );
  const productAssignments = events.filter(
    ({ eventType }) => eventType === "product-assigned",
  ).length;
  const benchmarkReviews = events.filter(
    ({ eventType, benchmarkId }) =>
      benchmarkId &&
      (eventType === "candidate-approved-for-intake" || eventType === "candidate-rejected"),
  );
  const benchmarkAccepted = benchmarkReviews.filter(
    ({ eventType }) => eventType === "candidate-approved-for-intake",
  ).length;
  const diagnosticAreaCounts = emptyDiagnosticCounts();
  for (const event of events) {
    for (const area of event.diagnosticAreas ?? []) diagnosticAreaCounts[area] += 1;
  }

  return {
    eventCount: events.length,
    catalogResolutionRate: rate(
      resolutionEvents.filter(({ eventType }) => eventType === "catalog-product-selected").length,
      resolutionEvents.length,
    ),
    automaticCandidateAcceptanceRate: rate(automaticAccepted, automaticReviews.length),
    manualUrlRate: rate(manualUrls, resolutionEvents.length),
    ideaOnlyPublicationRate: rate(ideaOnlyPublications, publicationEvents.length),
    laterProductResolutionRate: rate(
      events.filter(({ eventType }) => eventType === "idea-only-recommendation-resolved").length,
      events.filter(({ eventType }) => eventType === "recommendation-left-idea-only").length,
    ),
    searchAgainRate: rate(searchAgain, firstDiscoveryRuns),
    rejectionReasons,
    productClassManualInterventionRate,
    providerAcceptanceRate,
    dataForSeoPaidProviderInvocationCount,
    benchmarkCreationRate: rate(benchmarkEvents.length, productAssignments),
    benchmarkAssociatedLaterAcceptanceRate: rate(benchmarkAccepted, benchmarkReviews.length),
    diagnosticAreaCounts,
  };
}

export class EditorialFeedbackStore {
  readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  list(): EditorialFeedbackEvent[] {
    return readEditorialFeedbackEvents(this.repositoryRoot);
  }

  async save(input: EditorialFeedbackEvent): Promise<EditorialFeedbackEvent> {
    const event = editorialFeedbackEventSchema.parse(input);
    const path = editorialFeedbackEventPath(this.repositoryRoot, event.id);
    if (existsSync(path)) {
      throw new Error(`Editorial feedback event already exists: ${event.id}`);
    }
    await atomicWriteJson(path, event);
    return event;
  }

  async record(
    input: EditorialFeedbackEventInput,
    now = new Date(),
  ): Promise<EditorialFeedbackEvent> {
    return this.save(createEditorialFeedbackEvent(input, now));
  }
}
