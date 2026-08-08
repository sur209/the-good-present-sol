import { randomUUID } from "node:crypto";

import {
  clusterPath,
  type ClusterHub,
  type PrimaryAxis,
  type ValidatedPublicContent,
} from "@the-good-present/content-schema";

import { clusterDraftSchema, type ClusterDraft } from "./drafts.ts";

export interface ClusterDraftValidation {
  errors: string[];
  warnings: string[];
  route?: string;
}

export function reopenClusterDraft(cluster: ClusterHub, now = new Date()): ClusterDraft {
  const timestamp = now.toISOString();
  return clusterDraftSchema.parse({
    schemaVersion: 1,
    id: cluster.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    draftType: "cluster-hub",
    status: "editing",
    slug: cluster.slug,
    language: cluster.language,
    title: cluster.title,
    excerpt: cluster.excerpt,
    introduction: cluster.introduction,
    seoTitle: cluster.seoTitle,
    seoDescription: cluster.seoDescription,
    navigationGroups: structuredClone(cluster.navigationGroups),
  });
}

export function addNavigationGroup(
  draft: ClusterDraft,
  label: string,
  axis: PrimaryAxis,
  id = `group_${randomUUID()}`,
): ClusterDraft {
  return clusterDraftSchema.parse({
    ...draft,
    status: "editing",
    navigationGroups: [...draft.navigationGroups, { id, label, axis, guideIds: [] }],
  });
}

function groupIndex(draft: ClusterDraft, groupId: string): number {
  const index = draft.navigationGroups.findIndex((group) => group.id === groupId);
  if (index === -1) throw new TypeError(`No existe el grupo "${groupId}".`);
  return index;
}

export function removeNavigationGroup(draft: ClusterDraft, groupId: string): ClusterDraft {
  groupIndex(draft, groupId);
  return {
    ...draft,
    status: "editing",
    navigationGroups: draft.navigationGroups.filter((group) => group.id !== groupId),
  };
}

export function moveNavigationGroup(
  draft: ClusterDraft,
  groupId: string,
  direction: -1 | 1,
): ClusterDraft {
  const index = groupIndex(draft, groupId);
  const target = index + direction;
  if (target < 0 || target >= draft.navigationGroups.length) return draft;
  const groups = [...draft.navigationGroups];
  [groups[index], groups[target]] = [groups[target]!, groups[index]!];
  return { ...draft, status: "editing", navigationGroups: groups };
}

export function addGuideToGroup(
  draft: ClusterDraft,
  groupId: string,
  guideId: string,
  content: ValidatedPublicContent,
): ClusterDraft {
  const index = groupIndex(draft, groupId);
  const guide = content.guides.find((item) => item.id === guideId);
  if (!guide || guide.clusterId !== draft.id) {
    throw new TypeError("Sólo se pueden agregar guías publicadas que pertenezcan a este cluster.");
  }
  const group = draft.navigationGroups[index]!;
  if (group.guideIds.includes(guideId)) {
    throw new TypeError("La guía ya está incluida en este grupo.");
  }
  const groups = [...draft.navigationGroups];
  groups[index] = { ...group, guideIds: [...group.guideIds, guideId] };
  return { ...draft, status: "editing", navigationGroups: groups };
}

export function removeGuideFromGroup(
  draft: ClusterDraft,
  groupId: string,
  guideId: string,
): ClusterDraft {
  const index = groupIndex(draft, groupId);
  const group = draft.navigationGroups[index]!;
  if (!group.guideIds.includes(guideId)) throw new TypeError("La guía no está en este grupo.");
  const groups = [...draft.navigationGroups];
  groups[index] = { ...group, guideIds: group.guideIds.filter((id) => id !== guideId) };
  return { ...draft, status: "editing", navigationGroups: groups };
}

export function moveGuideInGroup(
  draft: ClusterDraft,
  groupId: string,
  guideId: string,
  direction: -1 | 1,
): ClusterDraft {
  const index = groupIndex(draft, groupId);
  const group = draft.navigationGroups[index]!;
  const guideIndex = group.guideIds.indexOf(guideId);
  if (guideIndex === -1) throw new TypeError("La guía no está en este grupo.");
  const target = guideIndex + direction;
  if (target < 0 || target >= group.guideIds.length) return draft;
  const guideIds = [...group.guideIds];
  [guideIds[guideIndex], guideIds[target]] = [guideIds[target]!, guideIds[guideIndex]!];
  const groups = [...draft.navigationGroups];
  groups[index] = { ...group, guideIds };
  return { ...draft, status: "editing", navigationGroups: groups };
}

export function validateClusterDraft(
  draft: ClusterDraft,
  content: ValidatedPublicContent,
): ClusterDraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [field, label] of [
    ["slug", "Slug"],
    ["title", "Título"],
    ["excerpt", "Extracto"],
    ["introduction", "Introducción"],
    ["seoTitle", "Título SEO"],
    ["seoDescription", "Descripción SEO"],
  ] as const) {
    if (!draft[field]) errors.push(`${label} es obligatorio.`);
  }

  let route: string | undefined;
  if (draft.slug) {
    try {
      route = clusterPath(draft.slug);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const conflicting = content.clusters.find(
      (cluster) => cluster.id !== draft.id && cluster.slug === draft.slug,
    );
    if (conflicting) errors.push(`El slug ya pertenece al cluster "${conflicting.title}".`);
  }

  const groupIds = new Set<string>();
  let populatedGroups = 0;
  for (const group of draft.navigationGroups) {
    if (groupIds.has(group.id)) errors.push(`El ID de grupo "${group.id}" está duplicado.`);
    groupIds.add(group.id);
    if (group.guideIds.length === 0) {
      warnings.push(`El grupo "${group.label}" está vacío y no se publicará.`);
      continue;
    }
    populatedGroups += 1;
    const guideIds = new Set<string>();
    for (const guideId of group.guideIds) {
      if (guideIds.has(guideId)) {
        errors.push(`La guía "${guideId}" está duplicada en el grupo "${group.label}".`);
      }
      guideIds.add(guideId);
      const guide = content.guides.find((item) => item.id === guideId);
      if (!guide) errors.push(`La guía "${guideId}" no está publicada.`);
      else if (guide.clusterId !== draft.id) {
        errors.push(`La guía "${guideId}" no pertenece a este cluster.`);
      }
    }
  }
  if (populatedGroups === 0) errors.push("Debe existir al menos un grupo con una guía publicada.");

  return { errors, warnings, ...(route ? { route } : {}) };
}
