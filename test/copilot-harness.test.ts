import test from "node:test";
import assert from "node:assert/strict";
import {
  copilotChildEnv,
  copilotByokProvider,
  copilotNonRetryable,
  copilotProviderFailure,
  copilotToolContext,
  copilotTurnInputText,
  createCopilotHarness,
} from "../src/harness/copilot-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

test("Copilot forwards external-content screening into its native tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const ref = copilotToolContext({ screenExternalContent } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
});

test("Copilot turn input text joins the user message and environment", () => {
  assert.equal(
    copilotTurnInputText({
      history: [],
      input: "What can you do?",
      environment: "You are in a sandbox",
    }),
    "What can you do?\n\nYou are in a sandbox",
  );
});

test("Copilot turn input text omits a missing environment", () => {
  assert.equal(copilotTurnInputText({ history: [], input: "just the question" }), "just the question");
});

test("Copilot child environment excludes core credentials and user homes", () => {
  const env = copilotChildEnv(
    {
      PATH: "/bin",
      HOME: "/Users/private",
      COPILOT_HOME: "/Users/private/.copilot",
      CORE_SIGNING_SECRET: "signing-secret",
      DATABASE_URL: "postgres://secret",
      ANTHROPIC_API_KEY: "anthropic-needed-by-provider",
      OPENAI_API_KEY: "openai-needed-by-provider",
      GH_TOKEN: "gh-token",
      COPILOT_GITHUB_TOKEN: "copilot-token",
    },
    "/tmp/control-jail",
  );

  assert.equal(env.HOME, "/tmp/control-jail");
  assert.equal(env.COPILOT_HOME, "/tmp/control-jail/copilot-home");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ANTHROPIC_API_KEY, "anthropic-needed-by-provider");
  assert.equal(env.OPENAI_API_KEY, "openai-needed-by-provider");
  assert.equal(env.GH_TOKEN, "gh-token");
  assert.equal(env.COPILOT_GITHUB_TOKEN, "copilot-token");
  assert.equal("CORE_SIGNING_SECRET" in env, false);
  assert.equal("DATABASE_URL" in env, false);
});

test("Copilot BYOK provider prefers Anthropic over OpenAI", () => {
  const provider = copilotByokProvider({
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-openai",
  });
  assert.equal(provider?.type, "anthropic");
  assert.equal(provider?.apiKey, "sk-ant");
});

test("Copilot BYOK provider falls back to OpenAI when only an OpenAI key is present", () => {
  const provider = copilotByokProvider({ OPENAI_API_KEY: "sk-openai" });
  assert.equal(provider?.type, "openai");
  assert.equal(provider?.apiKey, "sk-openai");
  assert.equal((provider as { wireApi?: string })?.wireApi, "responses");
});

test("Copilot BYOK provider returns undefined when only a GitHub token is present", () => {
  assert.equal(copilotByokProvider({ GH_TOKEN: "gh-token" }), undefined);
});

test("Copilot BYOK provider returns undefined when no credentials are present", () => {
  assert.equal(copilotByokProvider({}), undefined);
});

test("Copilot classifies deterministic provider failures as terminal and leaves transient ones retryable", () => {
  const terminal = [
    "401 Unauthorized: invalid x-api-key",
    "403 Forbidden",
    "HTTP 402 Payment Required",
    "invalid_api_key",
    "incorrect api key provided",
    "authentication error: missing bearer token",
    "not logged in",
    "exceeded your current quota, please check your plan",
    "insufficient_quota",
    "out of credits",
    "credits_depleted",
    "model_not_found",
    "the model does not exist or you do not have access",
    "your organization must be verified to stream this model",
  ];
  for (const message of terminal) {
    assert.equal(copilotNonRetryable(message), true, message);
    assert.ok(copilotProviderFailure(message) instanceof NonRetryableTurnError, message);
  }

  const transient = [
    "429 Too Many Requests",
    "rate limit reached, please retry",
    "socket hang up",
    "the server had an error while processing your request",
    "ECONNRESET",
    "copilot turn failed",
  ];
  for (const message of transient) {
    assert.equal(copilotNonRetryable(message), false, message);
    assert.ok(!(copilotProviderFailure(message) instanceof NonRetryableTurnError), message);
  }
});

test("Copilot never classifies its own infrastructure failures as terminal", () => {
  const ours = [
    "permission denied for table session_entries",
    "EACCES: permission denied, open '/data/tape/x.jsonl'",
    "copilot session error",
  ];
  for (const message of ours) {
    assert.ok(copilotProviderFailure(message) instanceof Error, message);
    assert.ok(!(copilotProviderFailure(message) instanceof NonRetryableTurnError), message);
  }
});

test("Copilot harness profile advertises SDK transport and dynamic tools", () => {
  const harness = createCopilotHarness({});
  assert.equal(harness.profile.id, "copilot");
  assert.equal(harness.profile.controlTransport, "sdk");
  assert.equal(harness.profile.toolTransport, "dynamic");
  assert.equal(harness.profile.transcriptFormat, "copilot-sdk");
  assert.deepEqual([...harness.profile.capabilities].sort(), ["abort", "images", "provider-sessions", "steer"]);
});

test("Copilot tool presentation leaves core tool names unchanged", () => {
  const harness = createCopilotHarness({});
  assert.equal(harness.tools.name("history"), "history");
  assert.equal(harness.tools.name("execute"), "execute");
});

test("Copilot harness exposes model utilities wired to a single-shot runtime", () => {
  const harness = createCopilotHarness({});
  assert.equal(typeof harness.models.oneShot, "function");
  assert.equal(typeof harness.models.judge, "function");
  assert.equal(typeof harness.models.screenSecurity, "function");
  assert.equal(typeof harness.models.generateTitle, "function");
  assert.equal(typeof harness.models.summarizeApproval, "function");
  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(typeof harness.turns.close, "function");
  assert.equal(typeof harness.turns.resetSession, "function");
});

test("Copilot spawn failure does not hang run or cleanup", async () => {
  const harness = createCopilotHarness({ binaryPath: "/definitely/missing/copilot" });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = harness.turns.runTurn({
    session: { id: "missing-binary" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => ({ ...entry, sessionId: "missing-binary", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  await assert.rejects(
    Promise.race([turn, new Promise((_, reject) => setTimeout(() => reject(new Error("run hung")), 5_000))]),
  );
  await Promise.race([
    harness.turns.close?.(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 5_000)),
  ]);
});
