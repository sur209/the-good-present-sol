import { z } from "zod";

import { finalPromptInputSchema, type FinalPromptInput } from "./final-prompt.ts";
import { outlinePromptInputSchema } from "./outline-prompt.ts";
import { recommendationPromptInputSchema } from "./recommendation-prompt.ts";
import { ideaRecommendationPromptInputSchema } from "./idea-prompt.ts";
import {
  mockOpportunityGeneration,
  opportunityGenerationPromptInputSchema,
} from "./modules/content-opportunity-lab/generation.ts";
import {
  mockOpportunityEvaluation,
  opportunityEvaluationPromptInputSchema,
} from "./modules/content-opportunity-lab/evaluation.ts";
import {
  mockProductSearchPlanning,
  productSearchPlanningPromptInputSchema,
} from "./modules/product-sources/discovery.ts";
import {
  mockProductFitEvaluation,
  productFitPromptInputSchema,
} from "./modules/product-intelligence/fit.ts";
import {
  mockProductEditorialCopy,
  productEditorialCopyPromptInputSchema,
} from "./modules/product-intelligence/editorial-copy.ts";

export interface ProviderCallMetadata {
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StructuredGenerationRequest<T> {
  operation:
    | "outline"
    | "final-guide"
    | "single-recommendation"
    | "idea-recommendation"
    | "opportunity-candidates"
    | "opportunity-evaluations"
    | "product-search-plans"
    | "product-fit-evaluations"
    | "product-editorial-copy";
  prompt: string;
  input: unknown;
  schema: z.ZodType<T>;
}

export interface GuideGenerationProvider {
  readonly providerId: string;
  readonly modelId?: string;
  readonly lastCallMetadata?: ProviderCallMetadata | undefined;
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}

const AI_VENDOR_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
} as const;

type AiVendor = keyof typeof AI_VENDOR_BASE_URLS;
type ProviderErrorCode =
  | "authentication"
  | "empty-response"
  | "invalid-json"
  | "invalid-response"
  | "invalid-schema"
  | "network"
  | "rate-limit"
  | "refusal"
  | "status"
  | "timeout"
  | "truncated";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly requestId?: string;
  readonly status?: number;

  constructor(
    message: string,
    code: ProviderErrorCode,
    options: { cause?: unknown; requestId?: string; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.status !== undefined) this.status = options.status;
  }

  debugSummary(): string {
    const details = [`code=${this.code}`];
    if (this.status !== undefined) details.push(`status=${this.status}`);
    if (this.requestId) details.push(`requestId=${this.requestId}`);
    if (this.cause instanceof Error) {
      details.push(`cause=${this.cause.name}`);
      if (this.cause instanceof z.ZodError) {
        const issues = this.cause.issues.slice(0, 8).map((issue) => {
          const path = issue.path.length ? issue.path.join(".") : "$";
          const message =
            issue.code === "unrecognized_keys" ? "Unrecognized field(s)" : issue.message;
          return `${path}: ${message.slice(0, 160)}`;
        });
        if (this.cause.issues.length > issues.length) {
          issues.push(`+${this.cause.issues.length - issues.length} more`);
        }
        details.push(`issues=${issues.join("; ")}`);
      }
    }
    return details.join(" ");
  }
}

type AiConfiguration =
  | { provider: "mock" }
  | {
      provider: "openai-compatible";
      vendor: AiVendor;
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };

function configuredBaseUrl(value: string | undefined, vendor: AiVendor): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || AI_VENDOR_BASE_URLS[vendor]);
  } catch {
    throw new TypeError("AI_BASE_URL debe ser una URL HTTP(S) absoluta.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("AI_BASE_URL debe ser una URL HTTP(S) base, sin credenciales ni query.");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveAiConfiguration(
  environment: Record<string, string | undefined> = process.env,
): AiConfiguration {
  const provider = environment.AI_PROVIDER?.trim() || "mock";
  if (provider === "mock") return { provider };
  if (provider !== "openai-compatible") {
    throw new TypeError('AI_PROVIDER debe ser "mock" u "openai-compatible".');
  }
  const vendor = environment.AI_VENDOR?.trim() || "openai";
  if (vendor !== "openai" && vendor !== "deepseek") {
    throw new TypeError('AI_VENDOR debe ser "openai" o "deepseek".');
  }
  const apiKey = environment.AI_API_KEY?.trim();
  if (!apiKey) throw new TypeError("AI_API_KEY es obligatoria para el proveedor real.");
  const model = environment.AI_MODEL?.trim();
  if (!model) throw new TypeError("AI_MODEL es obligatorio para el proveedor real.");
  const timeoutMs = Number(environment.AI_TIMEOUT_MS?.trim() || "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("AI_TIMEOUT_MS debe ser un entero positivo.");
  }
  return {
    provider,
    vendor,
    baseUrl: configuredBaseUrl(environment.AI_BASE_URL, vendor),
    apiKey,
    model,
    timeoutMs,
  };
}

const chatCompletionSchema = z
  .object({
    choices: z.array(
      z
        .object({
          finish_reason: z.string().nullable().optional(),
          message: z
            .object({
              content: z.unknown().optional(),
              refusal: z.unknown().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseExactStructuredContent<T>(content: string, schema: z.ZodType<T>): T {
  const exact = content.trim();
  if (!exact) {
    throw new ProviderError("El proveedor devolvió contenido vacío.", "empty-response");
  }
  if (exact.includes("```")) {
    throw new ProviderError("El proveedor devolvió Markdown en vez de JSON puro.", "invalid-json");
  }
  let value: unknown;
  try {
    value = JSON.parse(exact);
  } catch (cause) {
    throw new ProviderError("El proveedor devolvió JSON inválido o truncado.", "invalid-json", {
      cause,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderError("El proveedor debe devolver un único objeto JSON.", "invalid-json");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderError(
      "La respuesta del proveedor no cumple el esquema editorial esperado.",
      "invalid-schema",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function statusError(response: Response): ProviderError {
  const options = {
    status: response.status,
    ...(response.headers.get("x-request-id")
      ? { requestId: response.headers.get("x-request-id")! }
      : {}),
    cause: new Error(`HTTP ${response.status}`),
  };
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      "El proveedor rechazó las credenciales configuradas.",
      "authentication",
      options,
    );
  }
  if (response.status === 429) {
    return new ProviderError(
      "El proveedor alcanzó su límite de solicitudes. Probá de nuevo más tarde.",
      "rate-limit",
      options,
    );
  }
  return new ProviderError(
    response.status >= 500
      ? "El proveedor no está disponible en este momento. Probá de nuevo más tarde."
      : "El proveedor rechazó la solicitud de generación.",
    "status",
    options,
  );
}

type CompatibleConfiguration = Extract<AiConfiguration, { provider: "openai-compatible" }>;

class OpenAiCompatibleGuideGenerationProvider implements GuideGenerationProvider {
  readonly providerId: string;
  readonly modelId: string;
  lastCallMetadata: ProviderCallMetadata | undefined;
  private readonly configuration: CompatibleConfiguration;
  private readonly fetchImplementation: typeof fetch;

  constructor(configuration: CompatibleConfiguration, fetchImplementation: typeof fetch = fetch) {
    this.configuration = configuration;
    this.fetchImplementation = fetchImplementation;
    this.providerId = `openai-compatible:${configuration.vendor}`;
    this.modelId = configuration.model;
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.lastCallMetadata = undefined;
    const signal = AbortSignal.timeout(this.configuration.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.configuration.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.configuration.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.configuration.model,
          messages: [
            {
              role: "system",
              content:
                "Return exactly one JSON object matching the requested shape. Return JSON only, with no prose or Markdown fences.",
            },
            { role: "user", content: request.prompt },
          ],
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) {
        throw new ProviderError(
          "El proveedor tardó demasiado en responder. Probá de nuevo.",
          "timeout",
          { cause },
        );
      }
      throw new ProviderError(
        "No se pudo conectar con el proveedor de IA. Revisá la conexión y la URL base.",
        "network",
        { cause },
      );
    }
    if (!response.ok) throw statusError(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ProviderError(
        "El proveedor devolvió una respuesta HTTP que no es JSON.",
        "invalid-response",
        { cause },
      );
    }
    const envelope = chatCompletionSchema.safeParse(payload);
    if (!envelope.success) {
      throw new ProviderError(
        "La respuesta del proveedor tuvo un formato inesperado.",
        "invalid-response",
        { cause: envelope.error },
      );
    }
    if (envelope.data.choices.length === 0) {
      throw new ProviderError("El proveedor no devolvió ninguna opción.", "empty-response");
    }
    const choice = envelope.data.choices[0]!;
    if (
      (typeof choice.message.refusal === "string" && choice.message.refusal.trim()) ||
      choice.finish_reason === "content_filter"
    ) {
      throw new ProviderError(
        "El proveedor rechazó la generación por una restricción de seguridad.",
        "refusal",
      );
    }
    if (choice.finish_reason === "length") {
      throw new ProviderError("La respuesta del proveedor quedó truncada.", "truncated");
    }
    if (typeof choice.message.content !== "string") {
      throw new ProviderError("El proveedor devolvió contenido vacío.", "empty-response");
    }
    const usage = envelope.data.usage;
    const requestId = response.headers.get("x-request-id") ?? undefined;
    this.lastCallMetadata = {
      ...(requestId ? { requestId } : {}),
      ...(usage?.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
      ...(usage?.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
      ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    };
    return parseExactStructuredContent(choice.message.content, request.schema);
  }
}

export function createGuideGenerationProvider(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
): GuideGenerationProvider {
  const configuration = resolveAiConfiguration(environment);
  return configuration.provider === "mock"
    ? new MockGuideGenerationProvider()
    : new OpenAiCompatibleGuideGenerationProvider(configuration, fetchImplementation);
}

export class MockGuideGenerationProvider implements GuideGenerationProvider {
  readonly providerId = "mock";
  readonly modelId = "mock-editorial-v1";

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    if (request.operation === "product-editorial-copy") {
      return request.schema.parse(
        mockProductEditorialCopy(productEditorialCopyPromptInputSchema.parse(request.input)),
      );
    }
    if (request.operation === "product-fit-evaluations") {
      return request.schema.parse(
        mockProductFitEvaluation(productFitPromptInputSchema.parse(request.input)),
      );
    }
    if (request.operation === "product-search-plans") {
      return request.schema.parse(
        mockProductSearchPlanning(productSearchPlanningPromptInputSchema.parse(request.input)),
      );
    }
    if (request.operation === "opportunity-evaluations") {
      return request.schema.parse(
        mockOpportunityEvaluation(opportunityEvaluationPromptInputSchema.parse(request.input)),
      );
    }
    if (request.operation === "opportunity-candidates") {
      return request.schema.parse(
        mockOpportunityGeneration(opportunityGenerationPromptInputSchema.parse(request.input)),
      );
    }
    if (request.operation === "outline") {
      const input = outlinePromptInputSchema.parse(request.input);
      const audience =
        input.questionnaire.recipient ??
        input.taxonomies?.recipients?.[0] ??
        "the intended recipient";
      const budgetHint = input.budgetContext?.label ?? input.questionnaire.budget;
      return request.schema.parse({
        provisionalTitle: `${input.cluster.title}: ${input.primaryIntent}`,
        audienceSummary: `A focused guide for someone choosing a gift for ${audience}.`,
        editorialAngle: `Use ${input.primaryAxis} as the primary lens while keeping every slot aligned with the stated intent.`,
        recommendationCount: input.requestedRecommendationCount,
        slots: Array.from({ length: input.requestedRecommendationCount }, (_, index) => ({
          id: input.slotIds[index]!,
          label: `${input.primaryAxis} gift slot ${index + 1}`,
          intent: `A distinct, practical option that supports: ${input.primaryIntent}`,
          searchTerms: [
            `${input.cluster.title} ${input.primaryAxis} gift ${index + 1}`,
            `${audience} thoughtful gift`,
          ],
          ...(budgetHint ? { budgetHint } : {}),
        })),
      });
    }
    if (request.operation === "final-guide") {
      const input = finalPromptInputSchema.parse(request.input);
      const title =
        input.guide.existingCopy.title ??
        input.guide.approvedOutline.provisionalTitle ??
        `${input.cluster.title} Gift Guide`;
      return request.schema.parse({
        title,
        excerpt:
          input.guide.existingCopy.excerpt ??
          `A focused selection for readers who want to ${input.guide.primaryIntent.toLocaleLowerCase("en-US")}`,
        introduction:
          input.guide.existingCopy.introduction ??
          `This guide uses ${input.guide.primaryAxis} as its primary lens and evaluates each selected product against one distinct editorial purpose.`,
        conclusion:
          input.guide.existingCopy.conclusion ??
          "Choose the option that best reflects the recipient's routines, preferences, and the moment you want to mark.",
        seoTitle: input.guide.existingCopy.seoTitle ?? `${title} | The Good Present`,
        seoDescription:
          input.guide.existingCopy.seoDescription ??
          `Explore a focused ${input.cluster.title.toLocaleLowerCase("en-US")} guide with carefully selected products and original editorial context.`,
        recommendations: input.recommendations.map(mockRecommendation),
      });
    }
    if (request.operation === "single-recommendation") {
      const input = recommendationPromptInputSchema.parse(request.input);
      return request.schema.parse(mockRecommendation(input.recommendation));
    }
    if (request.operation === "idea-recommendation") {
      const { recommendation } = ideaRecommendationPromptInputSchema.parse(request.input);
      const attributes = recommendation.whatToLookFor.slice(0, 3);
      return request.schema.parse({
        id: recommendation.id,
        position: recommendation.position,
        heading: `A thoughtful ${recommendation.productClass.toLocaleLowerCase("en-US")} idea`,
        editorialDescription: `Choose a version that fits the recipient's routine and the purpose of this gift slot.`,
        whyItFits:
          recommendation.slotIntent ??
          `It gives the recipient something useful while keeping the choice personal.`,
        selectionGuidance: attributes.length
          ? `Compare ${attributes.join(", ")} and favor the option that best suits everyday use.`
          : "Compare ease of use, care, and suitability for the recipient's routine.",
        ...(recommendation.exclusions.length
          ? { considerations: `Avoid ${recommendation.exclusions.join(" and ")}.` }
          : {}),
      });
    }
    throw new TypeError(`Mock operation not implemented: ${request.operation}`);
  }
}

function mockRecommendation(recommendation: FinalPromptInput["recommendations"][number]) {
  return {
    id: recommendation.recommendationId,
    productId: recommendation.product.id,
    position: recommendation.position,
    heading: recommendation.product.name,
    editorialDescription: `${recommendation.product.name} from ${recommendation.product.merchant} offers this verified catalog context: ${recommendation.product.shortDescription}`,
    whyItFits:
      recommendation.slotIntent ??
      `It fills the “${recommendation.slotLabel}” role in this guide without changing the slot's purpose.`,
    bestFor: recommendation.slotLabel,
    ...(recommendation.product.verifiedFacts?.length
      ? { considerations: `Verified details: ${recommendation.product.verifiedFacts.join("; ")}.` }
      : {}),
  };
}
