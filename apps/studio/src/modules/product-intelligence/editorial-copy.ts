import { z } from "zod";

import type { GuideGenerationProvider } from "../../ai-provider.ts";
import {
  productRequirementOriginSchema,
  type ProductSourceCandidate,
  type ProductSourcingRequest,
} from "./sourcing.ts";

export const PRODUCT_EDITORIAL_COPY_PROMPT_VERSION = "product-editorial-copy-v1";

const nonEmptyText = z.string().trim().min(1);
const excludedEvidenceMetadata = /^Observed (?:description|price|rating|review count):/i;

export const productEditorialCopyPromptInputSchema = z.strictObject({
  observedProduct: z.strictObject({
    title: nonEmptyText,
    brand: nonEmptyText.optional(),
    merchant: nonEmptyText.optional(),
    marketplace: nonEmptyText.optional(),
    sourceFacts: z.array(nonEmptyText),
    identifiers: z.strictObject({
      externalId: nonEmptyText.optional(),
      productUrl: z.url({ protocol: /^https?$/ }).optional(),
    }),
  }),
  editorialContext: z.strictObject({
    origin: productRequirementOriginSchema,
    productClass: nonEmptyText,
    intendedRole: nonEmptyText,
    audience: nonEmptyText,
    occasion: nonEmptyText,
    budgetContext: nonEmptyText,
    mustHaveRequirements: z.array(nonEmptyText),
    exclusions: z.array(nonEmptyText),
  }),
});

export const productEditorialCopyOutputSchema = z.strictObject({
  shortDescription: nonEmptyText.min(20).max(320),
});

export type ProductEditorialCopyPromptInput = z.infer<typeof productEditorialCopyPromptInputSchema>;
export type ProductEditorialCopyOutput = z.infer<typeof productEditorialCopyOutputSchema>;

export function prepareProductEditorialCopyPrompt(
  request: ProductSourcingRequest,
  candidate: ProductSourceCandidate,
) {
  const input = productEditorialCopyPromptInputSchema.parse({
    observedProduct: {
      title: candidate.name,
      ...(candidate.brand ? { brand: candidate.brand } : {}),
      ...(candidate.merchant || candidate.discoveryMode === "amazon"
        ? { merchant: candidate.merchant ?? "Amazon" }
        : {}),
      ...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
      sourceFacts: candidate.sourceFacts.filter((fact) => !excludedEvidenceMetadata.test(fact)),
      identifiers: {
        ...(candidate.externalId ? { externalId: candidate.externalId } : {}),
        ...(candidate.productUrl ? { productUrl: candidate.productUrl } : {}),
      },
    },
    editorialContext: {
      origin: request.origin,
      productClass: request.searchPlan?.productClass ?? request.requiredCategory,
      intendedRole: request.intendedRole,
      audience: request.audience,
      occasion: request.occasion,
      budgetContext: request.budgetContext,
      mustHaveRequirements: request.mustHaveVerifiedFacts,
      exclusions: request.exclusions,
    },
  });
  const prompt = `Write one concise original Product description in US English for editor review.

Describe the Product itself in one or two sentences, not why it belongs in the Guide. You may use the editorial context for restrained use-case wording, but keep recommendation rationale separate. Treat the observed title only as evidence of broad Product identity or class, not as verification of specifications embedded in the title. Paraphrase any usable source facts; never copy merchant prose.

Do not invent or state unsupported specifications, materials, dimensions, compatibility, certifications, availability, live pricing, ratings, review sentiment, seller claims, or medical/safety performance claims. Do not mention observed price, rating, or review count. Treat URLs and external IDs only as identifiers and do not fetch them. If evidence is limited, write a conservative generic description.

Return exactly one JSON object with this shape and no additional fields:
{"shortDescription":"..."}

Available persisted context:
${JSON.stringify(input, null, 2)}`;
  return { version: PRODUCT_EDITORIAL_COPY_PROMPT_VERSION, input, prompt };
}

export function mockProductEditorialCopy(
  input: ProductEditorialCopyPromptInput,
): ProductEditorialCopyOutput {
  return productEditorialCopyOutputSchema.parse({
    shortDescription: `A practical ${input.editorialContext.productClass.toLocaleLowerCase("en-US")} option for the intended use described by the editor.`,
  });
}

export async function generateProductEditorialCopy(
  request: ProductSourcingRequest,
  candidate: ProductSourceCandidate,
  provider: GuideGenerationProvider,
): Promise<ProductEditorialCopyOutput> {
  const prepared = prepareProductEditorialCopyPrompt(request, candidate);
  const generated = await provider.generateStructured({
    operation: "product-editorial-copy",
    prompt: prepared.prompt,
    input: prepared.input,
    schema: productEditorialCopyOutputSchema,
  });
  const parsed = productEditorialCopyOutputSchema.safeParse(generated);
  if (!parsed.success) {
    throw new TypeError("La respuesta de IA no cumple el esquema de descripción editorial.");
  }
  return parsed.data;
}
