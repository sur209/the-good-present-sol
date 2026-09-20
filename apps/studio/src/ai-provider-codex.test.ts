import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  shell?: false;
  windowsVerbatimArguments?: true;
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
    observation.shell = spawnOptions.shell;
    if (spawnOptions.windowsVerbatimArguments) observation.windowsVerbatimArguments = true;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      events.emit("exit", code, null);
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
      void (async () => {
        if (options.output !== undefined) {
          await writeFile(join(spawnOptions.cwd, "final.json"), options.output, "utf8");
        }
        if (options.stdout) stdout.write(options.stdout);
        if (options.stderr) stderr.write(options.stderr);
        if (options.waitForKill) return;
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

test("Codex no Windows usa el ejecutable directo, los argumentos configurados y cwd aislado", async () => {
  const eventOutput =
    '{"type":"thread.started","thread_id":"thread-1"}\n' +
    '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":7,"output_tokens":4}}\n';
  const fake = fakeCodex({
    output: '{"answer":"ready"}',
    stdout: eventOutput,
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
    "linux",
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
  assert.equal(fake.observation.environment?.CODEX_HOME, undefined);
  assert.equal(fake.observation.environment?.Path, "C:\\bin");
  assert.deepEqual(provider.lastCallMetadata, {
    requestId: "thread-1",
    inputTokens: 12,
    outputTokens: 4,
  });
  const diagnostics = provider.lastCallDiagnostics!;
  for (const key of [
    "spawnRequestedMs",
    "spawnReturnedMs",
    "stdinEndCalledMs",
    "stdinFinishedMs",
    "firstStdoutMs",
    "threadStartedObservedMs",
    "turnCompletedObservedMs",
    "finalOutputFileFirstObservedMs",
    "exitMs",
    "closeMs",
    "parseStartMs",
    "parseEndMs",
  ] as const) {
    assert.equal(typeof diagnostics.timings[key], "number", key);
  }
  assert.equal(diagnostics.stdoutBytes, Buffer.byteLength(eventOutput, "utf8"));
  assert.equal(diagnostics.stderrBytes, 0);
  assert.equal(diagnostics.finalOutputFileSize, Buffer.byteLength('{"answer":"ready"}', "utf8"));
  assert.equal(diagnostics.exitCode, 0);
  assert.equal(diagnostics.closeCode, 0);
  assert.deepEqual(diagnostics.usage, {
    status: "successful",
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

test("Codex en Windows resuelve codex.cmd y lo ejecuta con cmd.exe sin exponer el prompt", async (t) => {
  const launcherDirectory = await mkdtemp(join(tmpdir(), "codex-launcher-"));
  t.after(() => rm(launcherDirectory, { recursive: true, force: true }));
  const launcherPath = join(launcherDirectory, "codex.cmd");
  await writeFile(launcherPath, "@echo off\r\n", "utf8");
  const fake = fakeCodex({ output: '{"answer":"ready"}' });
  const prompt = 'Prompt privado & sin interpolar. Return {"answer":"ready"}.';
  const provider = createGuideGenerationProvider(
    {
      AI_PROVIDER: "codex-cli",
      AI_MODEL: "configured-model",
      AI_REASONING_EFFORT: "high",
      AI_TIMEOUT_MS: "1000",
      AI_API_KEY: "must-not-be-forwarded",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: `"${launcherDirectory}"`,
      USERPROFILE: "C:\\Users\\test",
    },
    fetch,
    fake.spawn,
    "win32",
  );

  const result = await provider.generateStructured({ ...request, prompt });

  assert.deepEqual(result, { answer: "ready" });
  assert.equal(fake.observation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.doesNotMatch(fake.observation.command!, /powershell|pwsh/i);
  assert.deepEqual(fake.observation.args?.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(fake.observation.shell, false);
  assert.equal(fake.observation.windowsVerbatimArguments, true);
  const commandLine = fake.observation.args?.[3] ?? "";
  assert.match(commandLine, /codex\.cmd/i);
  assert.match(commandLine, /--model/);
  assert.match(commandLine, /configured-model/);
  assert.match(commandLine, /--sandbox/);
  assert.match(commandLine, /read-only/);
  assert.match(commandLine, /--ephemeral/);
  assert.match(commandLine, /--skip-git-repo-check/);
  assert.match(commandLine, /approval_policy/);
  assert.match(commandLine, /never/);
  assert.match(commandLine, /model_reasoning_effort/);
  assert.match(commandLine, /high/);
  assert.doesNotMatch(commandLine, /--ignore-user-config/);
  assert.doesNotMatch(commandLine, /Prompt privado/);
  assert.equal(fake.observation.prompt, prompt);
  assert.deepEqual(fake.observation.initialFiles, []);
  assert.ok(fake.observation.cwd?.startsWith(tmpdir()));
  assert.equal(fake.observation.environment?.CODEX_HOME, join("C:\\Users\\test", ".codex"));
  assert.equal(fake.observation.environment?.AI_API_KEY, undefined);
  assert.equal(fake.observation.environment?.Path, `"${launcherDirectory}"`);
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
    "linux",
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
      "linux",
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
      "linux",
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

test("Codex en Windows distingue un launcher ausente de un proceso que falla", async (t) => {
  const launcherDirectory = await mkdtemp(join(tmpdir(), "codex-launcher-"));
  t.after(() => rm(launcherDirectory, { recursive: true, force: true }));
  let spawnCalled = false;
  const missingSpawn: CodexSpawn = () => {
    spawnCalled = true;
    throw new Error("should not spawn");
  };
  const environment = {
    AI_PROVIDER: "codex-cli",
    AI_TIMEOUT_MS: "1000",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: launcherDirectory,
  };
  const missingProvider = createGuideGenerationProvider(environment, fetch, missingSpawn, "win32");

  await assert.rejects(missingProvider.generateStructured(request), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "configuration");
    assert.match(error.message, /codex\.cmd.*PATH/i);
    return true;
  });
  assert.equal(spawnCalled, false);

  await writeFile(join(launcherDirectory, "codex.cmd"), "@echo off\r\n", "utf8");
  const failed = fakeCodex({ code: 1, stderr: "unexpected provider failure" });
  const failedProvider = createGuideGenerationProvider(environment, fetch, failed.spawn, "win32");
  await assert.rejects(failedProvider.generateStructured(request), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "process");
    assert.match(error.message, /no pudo completar/);
    assert.doesNotMatch(error.message, /No se encontró/);
    return true;
  });
});

test("Codex termina el proceso al vencer AI_TIMEOUT_MS", async () => {
  const fake = fakeCodex({ waitForKill: true });
  const provider = createGuideGenerationProvider(
    { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "5" },
    fetch,
    fake.spawn,
    "linux",
  );
  await assert.rejects(
    provider.generateStructured(request),
    (error) => error instanceof ProviderError && error.code === "timeout",
  );
  assert.equal(fake.observation.killed, true);
  assert.equal(provider.lastCallDiagnostics?.timeoutPhase, "no-output");
  assert.equal(provider.lastCallDiagnostics?.usage.status, "unavailable");
  assert.equal(typeof provider.lastCallDiagnostics?.timings.killRequestedMs, "number");
  assert.equal(typeof provider.lastCallDiagnostics?.timings.killCompletedMs, "number");
  await assert.rejects(access(fake.observation.cwd!));
});

test("Codex conserva usage observado antes de un timeout sin marcarlo como exitoso", async () => {
  const fake = fakeCodex({
    waitForKill: true,
    stdout:
      '{"type":"thread.started","thread_id":"thread-timeout"}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}\n',
  });
  const provider = createGuideGenerationProvider(
    { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "50" },
    fetch,
    fake.spawn,
    "linux",
  );

  await assert.rejects(
    provider.generateStructured({
      ...request,
      prompt: "PRIVATE_GUIDE_CONTENT must never appear in diagnostics.",
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "timeout");
      assert.equal(error.diagnostics?.timeoutPhase, "turn-completed-awaiting-close");
      assert.deepEqual(error.diagnostics?.usage, {
        status: "observed-before-failed-completion",
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      });
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /PRIVATE_GUIDE_CONTENT/);
      return true;
    },
  );
  assert.equal(provider.lastCallMetadata, undefined);
  assert.equal(provider.lastCallDiagnostics?.usage.status, "observed-before-failed-completion");
});

test("Codex distingue output final listo mientras close está pendiente", async () => {
  const output = '{"answer":"ready"}';
  const fake = fakeCodex({ output, waitForKill: true });
  const provider = createGuideGenerationProvider(
    { AI_PROVIDER: "codex-cli", AI_TIMEOUT_MS: "50" },
    fetch,
    fake.spawn,
    "linux",
  );

  await assert.rejects(provider.generateStructured(request), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "timeout");
    assert.equal(error.diagnostics?.timeoutPhase, "output-file-ready-awaiting-close");
    assert.equal(error.diagnostics?.finalOutputFileSize, Buffer.byteLength(output, "utf8"));
    assert.equal(typeof error.diagnostics?.timings.finalOutputFileFirstObservedMs, "number");
    return true;
  });
  assert.equal(fake.observation.killed, true);
});
