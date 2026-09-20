import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

export interface ProviderCallMetadata {
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StructuredGenerationRequest<T> {
  operation:
    | "outline"
    | "guide-metadata"
    | "final-guide"
    | "single-recommendation"
    | "recommendation-field-repair"
    | "idea-recommendation"
    | "idea-recommendation-batch"
    | "idea-recommendation-batch-repair"
    | "editorial-review"
    | "editorial-review-repair"
    | "opportunity-candidates"
    | "opportunity-evaluations"
    | "product-search-plans"
    | "product-fit-evaluations"
    | "product-editorial-copy";
  prompt: string;
  input: unknown;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  mockResponse?: () => unknown;
  onCallMetadata?: (metadata: ProviderCallMetadata) => void;
}

export interface GuideGenerationProvider {
  readonly providerId: string;
  readonly modelId?: string;
  readonly editorialReviewTimeoutMs?: number;
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
  | "configuration"
  | "empty-response"
  | "invalid-json"
  | "invalid-response"
  | "invalid-schema"
  | "network"
  | "process"
  | "rate-limit"
  | "refusal"
  | "status"
  | "timeout"
  | "truncated";

export interface SafeSchemaIssue {
  path: string;
  expected: string;
  received: string;
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function receivedShape(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return value.length ? `string(length=${value.length})` : "empty";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

function expectedConstraint(issue: z.core.$ZodIssue): string {
  const details = issue as unknown as Record<string, unknown>;
  if (issue.code === "invalid_type") return String(details.expected ?? "valid-type");
  if (issue.code === "too_small") {
    return `${String(details.origin ?? "value")}-min-${String(details.minimum ?? "required")}`;
  }
  if (issue.code === "too_big") {
    return `${String(details.origin ?? "value")}-max-${String(details.maximum ?? "allowed")}`;
  }
  if (issue.code === "unrecognized_keys") return "no-unexpected-fields";
  return issue.code;
}

export function safeSchemaIssues(error: z.ZodError, value?: unknown): SafeSchemaIssue[] {
  return error.issues.slice(0, 8).map((issue) => {
    const details = issue as unknown as Record<string, unknown>;
    const path = issue.path.length ? issue.path.map(String).join(".") : "$";
    return {
      path,
      expected: expectedConstraint(issue),
      received:
        issue.code === "unrecognized_keys"
          ? `unexpected-fields(count=${Array.isArray(details.keys) ? details.keys.length : 1})`
          : receivedShape(valueAtPath(value, issue.path)),
    };
  });
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly requestId?: string;
  readonly status?: number;
  readonly schemaIssues?: SafeSchemaIssue[];

  constructor(
    message: string,
    code: ProviderErrorCode,
    options: {
      cause?: unknown;
      requestId?: string;
      schemaIssues?: SafeSchemaIssue[];
      status?: number;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.schemaIssues?.length) this.schemaIssues = options.schemaIssues;
    if (options.status !== undefined) this.status = options.status;
  }

  debugSummary(): string {
    const details = [`code=${this.code}`];
    if (this.status !== undefined) details.push(`status=${this.status}`);
    if (this.requestId) details.push(`requestId=${this.requestId}`);
    if (this.cause instanceof Error) {
      details.push(`cause=${this.cause.name}`);
    }
    if (this.schemaIssues?.length) {
      details.push(
        `issues=${this.schemaIssues
          .map(
            ({ path, expected, received }) => `${path}: expected=${expected} received=${received}`,
          )
          .join("; ")}`,
      );
    }
    return details.join(" ");
  }
}

type AiConfiguration =
  | { provider: "mock" }
  | {
      provider: "codex-cli";
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      editorialReviewTimeoutMs: number;
    }
  | {
      provider: "openai-compatible";
      vendor: AiVendor;
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      editorialReviewTimeoutMs: number;
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
  const provider = environment.AI_PROVIDER?.trim() || "codex-cli";
  if (provider === "mock") return { provider };
  if (provider === "codex-cli") {
    return {
      provider,
      model: environment.AI_MODEL?.trim() || "gpt-5.6-luna",
      reasoningEffort: environment.AI_REASONING_EFFORT?.trim() || "max",
      timeoutMs: configuredTimeout(environment.AI_TIMEOUT_MS, 300_000),
      editorialReviewTimeoutMs: configuredTimeout(
        environment.AI_EDITORIAL_REVIEW_TIMEOUT_MS,
        600_000,
      ),
    };
  }
  if (provider !== "openai-compatible") {
    throw new TypeError('AI_PROVIDER debe ser "codex-cli", "mock" u "openai-compatible".');
  }
  const vendor = environment.AI_VENDOR?.trim() || "openai";
  if (vendor !== "openai" && vendor !== "deepseek") {
    throw new TypeError('AI_VENDOR debe ser "openai" o "deepseek".');
  }
  const apiKey = environment.AI_API_KEY?.trim();
  if (!apiKey) throw new TypeError("AI_API_KEY es obligatoria para el proveedor real.");
  const model = environment.AI_MODEL?.trim();
  if (!model) throw new TypeError("AI_MODEL es obligatorio para el proveedor real.");
  return {
    provider,
    vendor,
    baseUrl: configuredBaseUrl(environment.AI_BASE_URL, vendor),
    apiKey,
    model,
    timeoutMs: configuredTimeout(environment.AI_TIMEOUT_MS, 60_000),
    editorialReviewTimeoutMs: configuredTimeout(
      environment.AI_EDITORIAL_REVIEW_TIMEOUT_MS,
      600_000,
    ),
  };
}

function configuredTimeout(value: string | undefined, defaultValue: number): number {
  const timeoutMs = Number(value?.trim() || defaultValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("AI_TIMEOUT_MS debe ser un entero positivo.");
  }
  return timeoutMs;
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
      { cause: parsed.error, schemaIssues: safeSchemaIssues(parsed.error, value) },
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
type CodexConfiguration = Extract<AiConfiguration, { provider: "codex-cli" }>;

interface CodexChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  kill(): boolean;
}

export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
    windowsVerbatimArguments?: true;
    windowsHide: true;
  },
) => CodexChildProcess;

function environmentValue(
  source: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function codexEnvironment(
  source: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined && !/(?:api[_-]?key|token|password|secret|credential|auth)/i.test(key),
    ),
  );
  if (
    platform === "win32" &&
    !Object.entries(environment).some(
      ([key, value]) => key.toLowerCase() === "codex_home" && value?.trim(),
    )
  ) {
    const userProfile = Object.entries(environment).find(
      ([key, value]) => key.toLowerCase() === "userprofile" && value?.trim(),
    )?.[1];
    if (userProfile) environment.CODEX_HOME = join(userProfile, ".codex");
  }
  return environment;
}

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCommandArgument(argument: string): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/g, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
  return escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function resolveCodexLaunch(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): { command: string; args: readonly string[]; windowsVerbatimArguments?: true } {
  if (platform !== "win32") return { command: "codex", args };

  let launcher: string | undefined;
  for (const entry of environmentValue(environment, "PATH")?.split(";") ?? []) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const candidate = join(directory, "codex.cmd");
    try {
      if (statSync(candidate).isFile()) {
        launcher = candidate;
        break;
      }
    } catch {
      // Keep searching PATH.
    }
  }
  if (!launcher) {
    throw new ProviderError(
      "No se encontró Codex CLI para Windows. Instalalo y verificá que `codex.cmd` esté disponible en PATH.",
      "configuration",
    );
  }

  const command = environmentValue(environment, "ComSpec")?.trim() || "cmd.exe";
  const escapedLauncher = launcher.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
  const commandLine = `"${[escapedLauncher, ...args.map(escapeWindowsCommandArgument)].join(" ")}"`;
  return {
    command,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

function codexMetadata(stdout: string): ProviderCallMetadata {
  let requestId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        requestId = event.thread_id;
      }
      if (
        event.type === "turn.completed" &&
        typeof event.usage === "object" &&
        event.usage !== null
      ) {
        usage = event.usage as Record<string, unknown>;
      }
    } catch {
      // Ignore non-event output; the final response comes from --output-last-message.
    }
  }
  const count = (key: string): number | undefined => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const inputTokens = count("input_tokens");
  const outputTokens = count("output_tokens");
  const totalTokens = count("total_tokens");
  return {
    ...(requestId ? { requestId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function codexExitError(stderr: string, code: number | null): ProviderError {
  const cause = new Error(`Codex CLI exited with code ${code ?? "unknown"}`);
  if (/not logged in|login required|authentication|unauthorized|sign in/i.test(stderr)) {
    return new ProviderError(
      "Codex CLI no está autenticado. Ejecutá `codex login` e iniciá sesión con ChatGPT.",
      "authentication",
      { cause },
    );
  }
  if (/model.{0,80}(not found|not available|unsupported|unknown|does not exist)/i.test(stderr)) {
    return new ProviderError(
      "El modelo configurado no está disponible en Codex CLI. Revisá AI_MODEL.",
      "configuration",
      { cause },
    );
  }
  if (/reasoning.{0,80}(invalid|unsupported|unknown|not available)/i.test(stderr)) {
    return new ProviderError(
      "El esfuerzo de razonamiento no es compatible. Revisá AI_REASONING_EFFORT.",
      "configuration",
      { cause },
    );
  }
  return new ProviderError(
    "Codex CLI no pudo completar la generación. Revisá el modelo y la configuración local.",
    "process",
    { cause },
  );
}

export class CodexCliGenerationProvider implements GuideGenerationProvider {
  readonly providerId = "codex-cli";
  readonly modelId: string;
  readonly editorialReviewTimeoutMs: number;
  lastCallMetadata: ProviderCallMetadata | undefined;
  private readonly configuration: CodexConfiguration;
  private readonly spawnImplementation: CodexSpawn;
  private readonly environment: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;

  constructor(
    configuration: CodexConfiguration,
    spawnImplementation: CodexSpawn = spawn as CodexSpawn,
    environment: Record<string, string | undefined> = process.env,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.configuration = configuration;
    this.spawnImplementation = spawnImplementation;
    this.environment = environment;
    this.platform = platform;
    this.modelId = configuration.model;
    this.editorialReviewTimeoutMs = configuration.editorialReviewTimeoutMs;
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.lastCallMetadata = undefined;
    const workingDirectory = await mkdtemp(join(tmpdir(), "the-good-present-codex-"));
    const outputPath = join(workingDirectory, "final.json");
    const args = [
      "exec",
      "--model",
      this.configuration.model,
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--output-last-message",
      outputPath,
      "--strict-config",
      "--config",
      `approval_policy=${JSON.stringify("never")}`,
      "--config",
      `model_reasoning_effort=${JSON.stringify(this.configuration.reasoningEffort)}`,
      "-",
    ];

    try {
      const launch = resolveCodexLaunch(args, this.environment, this.platform);
      const { stdout, stderr, code, timedOut } = await new Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
        timedOut: boolean;
      }>((resolve, reject) => {
        let child: CodexChildProcess;
        try {
          child = this.spawnImplementation(launch.command, launch.args, {
            cwd: workingDirectory,
            env: codexEnvironment(this.environment, this.platform),
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            windowsHide: true,
          });
        } catch (cause) {
          reject(cause);
          return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < 16_384) stderr += chunk;
        });
        child.stdin.on("error", () => undefined);
        child.once("error", reject);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, request.timeoutMs ?? this.configuration.timeoutMs);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code, timedOut });
        });
        child.stdin.end(request.prompt);
      }).catch((cause: unknown) => {
        const error = cause as NodeJS.ErrnoException;
        if (error?.code === "ENOENT") {
          throw new ProviderError(
            this.platform === "win32"
              ? "No se pudo iniciar el procesador de comandos de Windows para Codex CLI. Revisá ComSpec."
              : "No se encontró Codex CLI. Instalalo y verificá que `codex` esté disponible en PATH.",
            "configuration",
            { cause },
          );
        }
        throw new ProviderError("No se pudo iniciar Codex CLI.", "process", { cause });
      });

      if (timedOut) {
        throw new ProviderError(
          "Codex CLI tardó demasiado en responder. Probá de nuevo.",
          "timeout",
        );
      }
      if (code !== 0) throw codexExitError(`${stderr}\n${stdout}`, code);

      this.lastCallMetadata = codexMetadata(stdout);
      request.onCallMetadata?.(this.lastCallMetadata);
      let content = "";
      try {
        content = await readFile(outputPath, "utf8");
      } catch (cause) {
        throw new ProviderError("Codex CLI no devolvió contenido final.", "empty-response", {
          cause,
        });
      }
      return parseExactStructuredContent(content, request.schema);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

class OpenAiCompatibleGuideGenerationProvider implements GuideGenerationProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly editorialReviewTimeoutMs: number;
  lastCallMetadata: ProviderCallMetadata | undefined;
  private readonly configuration: CompatibleConfiguration;
  private readonly fetchImplementation: typeof fetch;

  constructor(configuration: CompatibleConfiguration, fetchImplementation: typeof fetch = fetch) {
    this.configuration = configuration;
    this.fetchImplementation = fetchImplementation;
    this.providerId = `openai-compatible:${configuration.vendor}`;
    this.modelId = configuration.model;
    this.editorialReviewTimeoutMs = configuration.editorialReviewTimeoutMs;
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.lastCallMetadata = undefined;
    const signal = AbortSignal.timeout(request.timeoutMs ?? this.configuration.timeoutMs);
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
    const usage = envelope.data.usage;
    const requestId = response.headers.get("x-request-id") ?? undefined;
    this.lastCallMetadata = {
      ...(requestId ? { requestId } : {}),
      ...(usage?.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
      ...(usage?.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
      ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    };
    request.onCallMetadata?.(this.lastCallMetadata);
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
    return parseExactStructuredContent(choice.message.content, request.schema);
  }
}

export function createGuideGenerationProvider(
  environment: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = fetch,
  spawnImplementation: CodexSpawn = spawn as CodexSpawn,
  platform: NodeJS.Platform = process.platform,
): GuideGenerationProvider {
  const configuration = resolveAiConfiguration(environment);
  if (configuration.provider === "mock") return new MockGuideGenerationProvider();
  if (configuration.provider === "codex-cli") {
    return new CodexCliGenerationProvider(
      configuration,
      spawnImplementation,
      environment,
      platform,
    );
  }
  return new OpenAiCompatibleGuideGenerationProvider(configuration, fetchImplementation);
}

export class MockGuideGenerationProvider implements GuideGenerationProvider {
  readonly providerId = "mock";
  readonly modelId = "mock-editorial-v1";

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    if (!request.mockResponse) {
      throw new TypeError(`Mock operation not implemented: ${request.operation}`);
    }
    return request.schema.parse(request.mockResponse());
  }
}
