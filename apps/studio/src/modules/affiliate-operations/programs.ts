import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { REPOSITORY_ROOT } from "../../repository.ts";

export const AFFILIATE_PROGRAMS_DIRECTORY = "editorial-data/affiliate-programs";

const recordId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Must be a safe lowercase record ID.");
const optionalText = z.string().trim().min(1).optional();
const nonEmptyText = z.string().trim().min(1);

export const affiliateProgramSchema = z.strictObject({
  id: recordId,
  programId: optionalText,
  marketplace: optionalText,
  storeOrAssociateId: optionalText,
  allowedTrackingIds: z.array(nonEmptyText).default([]),
  approvedHosts: z.array(nonEmptyText).default([]),
  disclosureText: optionalText,
  disclosureVersion: optionalText,
  enabled: z.boolean().default(false),
});

export type AffiliateProgram = z.infer<typeof affiliateProgramSchema>;

export interface AffiliateProgramRecord {
  file: string;
  program?: AffiliateProgram;
  error?: string;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function readAffiliateProgramRecords(
  repositoryRoot = REPOSITORY_ROOT,
): AffiliateProgramRecord[] {
  const directory = resolve(repositoryRoot, AFFILIATE_PROGRAMS_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const file = relative(repositoryRoot, resolve(directory, entry.name)).replaceAll("\\", "/");
      try {
        const parsed = affiliateProgramSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        return parsed.success
          ? { file, program: parsed.data }
          : { file, error: validationMessage(parsed.error) };
      } catch (error) {
        return { file, error: error instanceof Error ? error.message : String(error) };
      }
    });
}

export function missingAffiliateProgramConfiguration(program: AffiliateProgram): string[] {
  const missing: string[] = [];
  if (!program.programId) missing.push("program ID");
  if (!program.marketplace) missing.push("marketplace");
  if (!program.storeOrAssociateId) missing.push("store or associate identifier");
  if (program.allowedTrackingIds.length === 0) missing.push("allowed tracking ID");
  if (program.id === "amazon-us" && program.approvedHosts.length === 0) {
    missing.push("approved Amazon host");
  }
  if (!program.disclosureText) missing.push("disclosure text");
  if (!program.disclosureVersion) missing.push("disclosure version");
  return missing;
}
