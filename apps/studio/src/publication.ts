import { resolve } from "node:path";

import {
  PUBLIC_CONTENT_DIRECTORIES,
  clusterHubSchema,
  clusterPath,
  giftGuideSchema,
  guidePath,
  type ClusterHub,
  type GiftGuide,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import { readPublicContentSources } from "../../../scripts/content-files.ts";
import { validateClusterDraft } from "./cluster-editor.ts";
import { DraftStore, StaleDraftError } from "./draft-store.ts";
import type { ClusterDraft, EditorialDraft, GuideDraft } from "./drafts.ts";
import { validateGuideDraft } from "./guide-editor.ts";
import {
  REPOSITORY_ROOT,
  assertPublicContentCandidate,
  atomicWriteJson,
  readPublicContent,
  replaceSourceRecord,
  runRepositoryMutation,
} from "./repository.ts";

export interface PublicationResult {
  action: "created" | "updated";
  file: string;
  id: string;
  route: string;
}

function publicDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function clusterDraftToPublic(
  draft: ClusterDraft,
  content: ValidatedPublicContent,
  now = new Date(),
): ClusterHub {
  const validation = validateClusterDraft(draft, content);
  if (validation.errors.length) throw new TypeError(validation.errors.join("\n"));
  const existing = content.clusters.find((cluster) => cluster.id === draft.id);
  const date = publicDate(now);
  return clusterHubSchema.parse({
    schemaVersion: 1,
    id: draft.id,
    pageType: "cluster-hub",
    slug: draft.slug,
    language: "en-US",
    title: draft.title,
    excerpt: draft.excerpt,
    introduction: draft.introduction,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    navigationGroups: draft.navigationGroups
      .filter((group) => group.guideIds.length > 0)
      .map((group) => ({ ...group, guideIds: [...group.guideIds] })),
    status: "published",
    publishedAt: existing?.publishedAt ?? date,
    updatedAt: date,
  });
}

export function guideDraftToPublic(
  draft: GuideDraft,
  content: ValidatedPublicContent,
  now = new Date(),
): GiftGuide {
  const validation = validateGuideDraft(draft, content);
  if (validation.errors.length) throw new TypeError(validation.errors.join("\n"));
  const existing = content.guides.find((guide) => guide.id === draft.id);
  const date = publicDate(now);
  return giftGuideSchema.parse({
    schemaVersion: 1,
    id: draft.id,
    pageType: "gift-guide",
    clusterId: draft.clusterId,
    slug: draft.slug,
    language: "en-US",
    title: draft.title,
    excerpt: draft.excerpt,
    introduction: draft.introduction,
    ...(draft.conclusion ? { conclusion: draft.conclusion } : {}),
    primaryAxis: draft.primaryAxis,
    primaryIntent: draft.primaryIntent,
    ...(draft.taxonomies ? { taxonomies: draft.taxonomies } : {}),
    ...(draft.budgetContext ? { budgetContext: draft.budgetContext } : {}),
    ...(draft.relatedGuideIds.length ? { relatedGuideIds: [...draft.relatedGuideIds] } : {}),
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    status: "published",
    publishedAt: existing?.publishedAt ?? date,
    updatedAt: date,
    recommendations: [...draft.recommendations]
      .sort((left, right) => left.position - right.position)
      .map((recommendation) => ({
        id: recommendation.id,
        ...(recommendation.productId
          ? { productId: recommendation.productId }
          : {
              productResolution: "unresolved" as const,
              heading: recommendation.heading ?? recommendation.slotLabel,
            }),
        ...(recommendation.directAffiliateUrl
          ? { directAffiliateUrl: recommendation.directAffiliateUrl }
          : {}),
        position: recommendation.position,
        ...(recommendation.productId && recommendation.heading
          ? { heading: recommendation.heading }
          : {}),
        editorialDescription: recommendation.editorialDescription,
        whyItFits: recommendation.whyItFits,
        ...(recommendation.bestFor ? { bestFor: recommendation.bestFor } : {}),
        ...(!recommendation.productId && recommendation.selectionGuidance
          ? { selectionGuidance: recommendation.selectionGuidance }
          : {}),
        ...(recommendation.considerations ? { considerations: recommendation.considerations } : {}),
        editorialStatus: "ready",
      })),
  });
}

export class Publisher {
  private readonly repositoryRoot: string;

  constructor(repositoryRoot = REPOSITORY_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  read(): ValidatedPublicContent {
    return readPublicContent(this.repositoryRoot);
  }

  async publish(
    draft: EditorialDraft,
    now = new Date(),
    draftStore?: DraftStore,
  ): Promise<PublicationResult> {
    return draft.draftType === "cluster-hub"
      ? this.publishCluster(draft, now, draftStore)
      : this.publishGuide(draft, now, draftStore);
  }

  async publishCluster(
    draft: ClusterDraft,
    now = new Date(),
    draftStore?: DraftStore,
  ): Promise<PublicationResult> {
    return runRepositoryMutation(this.repositoryRoot, async () => {
      await this.assertCurrentDraft(draft, draftStore);
      const content = this.read();
      const existing = content.clusters.some((cluster) => cluster.id === draft.id);
      const record = clusterDraftToPublic(draft, content, now);
      const file = `${PUBLIC_CONTENT_DIRECTORIES.clusters}/${record.id}.json`;
      const sources = readPublicContentSources(this.repositoryRoot);
      replaceSourceRecord(sources.clusters, file, record);
      assertPublicContentCandidate(
        sources,
        "La publicación dejaría inválido el contenido canónico.",
      );
      await atomicWriteJson(resolve(this.repositoryRoot, file), record);
      return {
        action: existing ? "updated" : "created",
        file,
        id: record.id,
        route: clusterPath(record.slug),
      };
    });
  }

  async publishGuide(
    draft: GuideDraft,
    now = new Date(),
    draftStore?: DraftStore,
  ): Promise<PublicationResult> {
    return runRepositoryMutation(this.repositoryRoot, async () => {
      await this.assertCurrentDraft(draft, draftStore);
      const content = this.read();
      const existing = content.guides.some((guide) => guide.id === draft.id);
      const record = guideDraftToPublic(draft, content, now);
      const cluster = content.clusters.find((item) => item.id === record.clusterId)!;
      const file = `${PUBLIC_CONTENT_DIRECTORIES.guides}/${record.id}.json`;
      const sources = readPublicContentSources(this.repositoryRoot);
      replaceSourceRecord(sources.guides, file, record);
      assertPublicContentCandidate(
        sources,
        "La publicación dejaría inválido el contenido canónico.",
      );
      await atomicWriteJson(resolve(this.repositoryRoot, file), record);
      return {
        action: existing ? "updated" : "created",
        file,
        id: record.id,
        route: guidePath(cluster.slug, record.slug),
      };
    });
  }

  private async assertCurrentDraft(
    draft: EditorialDraft,
    store: DraftStore | undefined,
  ): Promise<void> {
    if (!store) return;
    if (store.repositoryRoot !== resolve(this.repositoryRoot)) {
      throw new TypeError("El borrador y la publicación deben usar el mismo repositorio.");
    }
    store.assertExpectedRevision(draft.revision);
    if ((await store.read(draft.id)).revision !== draft.revision) throw new StaleDraftError();
  }
}
