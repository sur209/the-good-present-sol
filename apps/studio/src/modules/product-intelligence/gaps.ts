import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { REPOSITORY_ROOT } from "../../repository.ts";

export const PRODUCT_GAPS_DIRECTORY = "editorial-data/product-gaps";

const safeId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Must use a safe lowercase ID.");
const nonEmptyText = z.string().trim().min(1);

const productGapSlotSchema = z.strictObject({
  id: safeId,
  label: nonEmptyText,
  category: nonEmptyText,
  status: z.enum(["needs-review", "unassigned"]),
  productId: safeId.optional(),
  reason: nonEmptyText,
});

export const productGapReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: safeId,
  recordType: z.literal("product-gap-report"),
  guideId: safeId,
  clusterId: safeId,
  route: nonEmptyText,
  checkedAt: z.iso.date(),
  status: z.literal("blocked"),
  candidateProductIds: z.array(safeId),
  catalogSnapshot: z.strictObject({
    activeCandidateProductIds: z.array(safeId),
    verifiedCandidateProductIds: z.array(safeId),
    productSourceRecordCount: z.number().int().nonnegative(),
  }),
  slots: z.array(productGapSlotSchema).min(1),
  gaps: z.array(nonEmptyText).min(1),
  blockers: z.array(nonEmptyText).min(1),
  nextActions: z.array(nonEmptyText).min(1),
});

export type ProductGapReport = z.infer<typeof productGapReportSchema>;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => `${path.length ? path.join(".") : "$record"}: ${message}`)
    .join("; ");
}

export function readProductGapReports(repositoryRoot = REPOSITORY_ROOT): ProductGapReport[] {
  const directory = resolve(repositoryRoot, PRODUCT_GAPS_DIRECTORY);
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
      const id = entry.name.slice(0, -5);
      try {
        const parsed = productGapReportSchema.safeParse(
          JSON.parse(readFileSync(resolve(directory, entry.name), "utf8")),
        );
        if (!parsed.success) throw new TypeError(validationMessage(parsed.error));
        if (parsed.data.id !== id) throw new TypeError(`id must match filename stem "${id}".`);
        return parsed.data;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Invalid product gap report "${file}": ${reason}`, { cause: error });
      }
    });
}
