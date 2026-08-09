import { z } from "zod";

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
