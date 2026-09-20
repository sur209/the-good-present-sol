import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { z } from "zod";

import { ProviderError, createGuideGenerationProvider, type CodexSpawn } from "./ai-provider.ts";

interface FakeObservation {
  args?: readonly string[];
  command?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  initialFiles?: string[];
  killed: boolean;
  prompt: string;
}

function fakeCodex(options: {
  code?: number;
  output?: string;
  stderr?: string;
  stdout?: string;
  waitForKill?: boolean;
}): { observation: FakeObservation; spawn: CodexSpawn } {
  const observation: FakeObservation = { killed: false, prompt: "" };
  const spawn: CodexSpawn = (command, args, spawnOptions) => {
    observation.command = command;
    observation.args = args;
    observation.cwd = spawnOptions.cwd;
    observation.environment = spawnOptions.env;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      events.emit("close", code);
    };
    const child = Object.assign(events, {
      stdin,
      stdout,
      stderr,
      kill() {
        observation.killed = true;
        close(null);
        return true;
      },
    });

    observation.initialFiles = readdirSync(spawnOptions.cwd);
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      observation.prompt += chunk;
    });
    stdin.once("finish", () => {
      if (options.waitForKill) return;
      void (async () => {
        const outputIndex = args.indexOf("--output-last-message");
        if (options.output !== undefined) {
          await writeFile(args[outputIndex + 1]!, options.output, "utf8");
        }
        if (options.stdout) stdout.write(options.stdout);
        if (options.stderr) stderr.write(options.stderr);
        close(options.code ?? 0);
      })();
    });
    return child;
  };
  return { observation, spawn };
}

const schema = z.strictObject({ answer: z.literal("ready") });
const request = {
  operation: "outline" as const,
  prompt: 'Existing prompt, unchanged. Return {"answer":"ready"}.',
  input: {},
  schema,
};

test("Codex usa argumentos configurados, cwd aislado y el entorno de autenticación normal", async () => {
  const fake = fakeCodex({
    output: '{"answer":"ready"}',
    stdout:
      '{"type":"thread.started","thread_id":"thread-1"}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":7,"output_tokens":4}}\n',
  });
  let callbackMetadata: unknown;
  const provider = createGuideGenerationProvider(
    {
      AI_PROVIDER: "codex-cli",
      AI_MODEL: "configured-model",
      AI_REASONING_EFFORT: "high",
      AI_TIMEOUT_MS: "1000",
      AI_API_KEY: "must-not-be-forwarded",
      DEEPSEEK_API_KEY: "must-not-be-forwarded",
      OPENAI_API_KEY: "must-not-be-forwarded",
      HOME: "C:\\Users\\test",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\test",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
      Path: "C:\\bin",
      USERPROFILE: "C:\\Users\\test",
    },
    fetch,
    fake.spawn,
  );
  const result = await provider.generateStructured({
    ...request,
    onCallMetadata: (metadata) => {
      callbackMetadata = metadata;
    },
  });

  assert.deepEqual(result, { answer: "ready" });
  assert.equal(provider.providerId, "codex-cli");
  assert.equal(provider.modelId, "configured-model");
  assert.equal(fake.observation.command, "codex");
  assert.equal(fake.observation.prompt, request.prompt);
  assert.deepEqual(fake.observation.initialFiles, []);
  assert.ok(fake.observation.cwd?.startsWith(tmpdir()));
  assert.match(relative(process.cwd(), fake.observation.cwd!), /^\.\./);
  assert.equal(fake.observation.environment?.AI_API_KEY, undefined);
  assert.equal(fake.observation.environment?.DEEPSEEK_API_KEY, undefined);
  assert.equal(fake.observation.environment?.OPENAI_API_KEY, undefined);
  assert.equal(fake.observation.environment?.HOME, "C:\\Users\\test");
  assert.equal(fake.observation.environment?.HOMEDRIVE, "C:");
  assert.equal(fake.observation.environment?.HOMEPATH, "\\Users\\test");
  assert.equal(fake.observation.environment?.APPDATA, "C:\\Users\\test\\AppData\\Roaming");
  assert.equal(fake.observation.environment?.LOCALAPPDATA, "C:\\Users\\test\\AppData\\Local");
  assert.equal(fake.observation.environment?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "Codex Desktop");
  if (process.platform === "win32") {
    assert.equal(fake.observation.environment?.CODEX_HOME, "C:\\Users\\test\\.codex");
  }
  assert.equal(fake.observation.environment?.Path, "C:\\bin");
  assert.deepEqual(provider.lastCallMetadata, {
    requestId: "thread-1",
    inputTokens: 12,
    outputTokens: 4,
  });
  assert.deepEqual(callbackMetadata, provider.lastCallMetadata);
  assert.deepEqual(fake.observation.args, [
    "exec",
    "--model",
    "configured-model",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
    "--output-last-message",
    join(fake.observation.cwd!, "final.json"),
    "--strict-config",
    "--config",
    'approval_policy="never"',
    "--config",
    'model_reasoning_effort="high"',
    "-",
  ]);
  await assert.rejects(access(fake.observation.cwd!));
});

test("Codex conserva un CODEX_HOME explícito", async () => {
  const fake = fakeCodex({ output: '{"answer":"ready"}' });
  const provider = createGuideGenerationProvider(
    {
      AI_PROVIDER: "codex-cli",
      AI_TIMEOUT_MS: "1000",
      CODEX_HOME: "D:\\CodexHome",
      USERPROFILE: "C:\\Users\\test",
    },
    fetch,
    fake.spawn,
  );

  await provider.generateStructured(request);

  assert.equal(fake.observation.environment?.CODEX_HOME, "D:\\CodexHome");
  await assert.rejects(access(fake.observation.cwd!));
});

test("Codex valida JSON exacto y el esquema Zod existente", async () => {
  for (const [output, code] of [
    ["not json", "invalid-json"],
    ['{"answer":"wrong"}', "invalid-schema"],
    ["", "empty-response"],
  ] as const) {
    const fake = fakeCodex({ output });
    const provider = createGuideGenerationProvider(
      { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "1000" },
      fetch,
      fake.spawn,
    );
    await assert.rejects(
      provider.generateStructured(request),
      (error) => error instanceof ProviderError && error.code === code,
    );
    await assert.rejects(access(fake.observation.cwd!));
  }
});

test("Codex informa ejecutable ausente, autenticación, modelo y salida no cero", async () => {
  const missing: CodexSpawn = () => {
    throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  };
  const cases: Array<{
    code: "authentication" | "configuration" | "process";
    message: RegExp;
    spawn: CodexSpawn;
  }> = [
    { code: "configuration", message: /No se encontró Codex CLI/, spawn: missing },
    {
      code: "authentication",
      message: /codex login/,
      spawn: fakeCodex({ code: 1, stderr: "Not logged in" }).spawn,
    },
    {
      code: "configuration",
      message: /AI_MODEL/,
      spawn: fakeCodex({ code: 1, stderr: "model is not available" }).spawn,
    },
    {
      code: "process",
      message: /no pudo completar/,
      spawn: fakeCodex({ code: 1, stderr: "unexpected internal failure with secret-data" }).spawn,
    },
  ];

  for (const item of cases) {
    const provider = createGuideGenerationProvider(
      { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "1000" },
      fetch,
      item.spawn,
    );
    await assert.rejects(provider.generateStructured(request), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, item.code);
      assert.match(error.message, item.message);
      assert.doesNotMatch(error.message, /secret-data/);
      return true;
    });
  }
});

test("Codex termina el proceso al vencer AI_TIMEOUT_MS", async () => {
  const fake = fakeCodex({ waitForKill: true });
  const provider = createGuideGenerationProvider(
    { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "5" },
    fetch,
    fake.spawn,
  );
  await assert.rejects(
    provider.generateStructured(request),
    (error) => error instanceof ProviderError && error.code === "timeout",
  );
  assert.equal(fake.observation.killed, true);
  await assert.rejects(access(fake.observation.cwd!));
});
