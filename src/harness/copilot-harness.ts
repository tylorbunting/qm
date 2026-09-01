import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveAll,
  CopilotClient,
  defineTool,
  RuntimeConnection,
  type CopilotSession,
  type ProviderConfig,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { DEFAULT_COPILOT_MODEL_ID, modelSupportedByHarness } from "../model/pi-models.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { countTokens } from "../util/tokens.ts";
import { parseSecurityScreenVerdict, SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { coreToolOptions, createPiTools, type PiToolsOptions, type ToolContextRef } from "./pi-tools.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";

export interface CopilotHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  signals?: RunSignalStore;
  tasks?: TaskStore;
}

export function copilotHarnessConfigOptions(config: Config): CopilotHarnessOptions {
  return {
    ...(config.copilotModel ? { defaultModelId: config.copilotModel } : {}),
    ...(config.judgeModelId && modelSupportedByHarness(config.judgeModelId, "copilot")
      ? { judgeModelId: config.judgeModelId }
      : {}),
    ...(config.copilotBinPath ? { binaryPath: config.copilotBinPath } : {}),
    env: config.copilotProcessEnv,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export function copilotToolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenExternalContent: turn.screenExternalContent,
    toolApprovalGate: turn.toolApprovalGate,
  };
}

type BridgedTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    callId: string,
    args: unknown,
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; terminate?: boolean }>;
};

const COPILOT_NON_RETRYABLE_PATTERN =
  /\b(?:401|402|403)\b|unauthoriz|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication (?:error|failed)|missing bearer|missing (?:api key|credentials)|not logged in|insufficient[_ -]?quota|exceeded your current quota|billing|credit(?: balance| limit)|out of credits|credits_depleted|must be verified|model[_ -]?not[_ -]?found|does not exist or you do not have access|unsupported[_ -]?model/i;

export function copilotNonRetryable(message: string): boolean {
  return COPILOT_NON_RETRYABLE_PATTERN.test(message);
}

export function copilotProviderFailure(message: string): Error {
  return copilotNonRetryable(message) ? new NonRetryableTurnError(message) : new Error(message);
}

export function copilotTurnInputText(
  turn: Pick<HarnessTurnInput, "history" | "priorTurns" | "input" | "environment">,
): string {
  return [turn.input, turn.environment].filter((item) => item?.trim()).join("\n\n");
}

const COPILOT_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

export function copilotChildEnv(source: NodeJS.ProcessEnv, jail: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: jail, COPILOT_HOME: join(jail, "copilot-home") };
  for (const name of COPILOT_ENV_PASSTHROUGH) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export function copilotByokProvider(env: NodeJS.ProcessEnv): ProviderConfig | undefined {
  if (env.ANTHROPIC_API_KEY) {
    const baseUrl = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    return {
      type: "openai",
      baseUrl: `${baseUrl}/v1`,
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }
  if (env.OPENAI_API_KEY)
    return {
      type: "openai",
      baseUrl: (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: env.OPENAI_API_KEY,
      wireApi: "responses",
    };
  return undefined;
}

function toolOptions(opts: CopilotHarnessOptions, turn?: HarnessTurnInput): PiToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
    controlTools: opts.controlTools,
    execTimeoutMs: opts.execTimeoutMs,
    execTimeoutCeilingMs: opts.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs,
    ...(turn
      ? {
          readOnly: turn.readOnly,
          surfaceTools: turn.surfaceTools,
          surfaceName: turn.surfaceName,
          credentialExecServices: turn.credentialExecServices,
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

function asTools(ref: ToolContextRef, options: PiToolsOptions): BridgedTool[] {
  return createPiTools(ref, options) as unknown as BridgedTool[];
}

function usageFromAssistantMessage(event: SessionEvent): LlmCallUsage | null {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const output = typeof data.outputTokens === "number" ? data.outputTokens : 0;
  return { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, costUsd: 0 };
}

function usageFromUsageEvent(event: SessionEvent): LlmCallUsage | null {
  const data = event.data as
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cost?: number;
      }
    | undefined;
  if (!data) return null;
  const input = data.inputTokens ?? 0;
  const output = data.outputTokens ?? 0;
  const cacheRead = data.cacheReadTokens ?? 0;
  const cacheWrite = data.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: data.cost ?? 0,
  };
}

interface Runtime {
  client: CopilotClient;
  jail: string;
}

export function createCopilotHarness(opts: CopilotHarnessOptions = {}): Harness {
  const configuredModel = opts.modelId;
  const judgeModelId = opts.judgeModelId ?? DEFAULT_COPILOT_MODEL_ID;
  const resolveModelId = (scope?: ScopeId) =>
    [
      typeof configuredModel === "function" ? configuredModel(scope) : configuredModel,
      opts.defaultModelId,
      DEFAULT_COPILOT_MODEL_ID,
    ].find((id): id is string => modelSupportedByHarness(id, "copilot"))!;
  const defaultTurnWallClockMs = opts.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  let runtime: Runtime | null = null;
  let starting: Promise<Runtime> | null = null;

  const ensureRuntime = async (): Promise<Runtime> => {
    if (runtime) return runtime;
    if (starting) return await starting;
    starting = (async () => {
      const jail = mkdtempSync(join(tmpdir(), "qm-copilot-"));
      const sourceEnv = opts.env ?? {};
      const childEnv = copilotChildEnv(sourceEnv, jail);
      const gitHubToken = sourceEnv.GH_TOKEN ?? sourceEnv.GITHUB_TOKEN ?? sourceEnv.COPILOT_GITHUB_TOKEN;
      const client = new CopilotClient({
        ...(opts.binaryPath ? { connection: RuntimeConnection.forStdio({ path: opts.binaryPath }) } : {}),
        workingDirectory: jail,
        env: childEnv,
        useLoggedInUser: !gitHubToken,
        ...(gitHubToken ? { gitHubToken } : {}),
      });
      await client.start();
      runtime = { client, jail };
      return runtime;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  };

  const runPrompt = async (turn: HarnessTurnInput, toolsEnabled = true): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    const rt = await ensureRuntime();
    const ref = copilotToolContext(turn);
    const toolAbort = new AbortController();
    ref.abortSignal = toolAbort.signal;
    const tools = toolsEnabled ? asTools(ref, toolOptions(opts, turn)) : [];
    const model = modelSupportedByHarness(turn.model, "copilot") ? turn.model! : resolveModelId(turn.scopeLabel);
    const provider = copilotByokProvider(opts.env ?? {});
    const userEntry = await turn.emit({
      type: "user",
      payload: {
        text: turn.input,
        ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      },
      scopeLabel: turn.scopeLabel,
    });
    const inputText = copilotTurnInputText(turn);
    const fallbackInputTokens = countTokens(inputText);
    const sessionConfig: SessionConfig = {
      ...(model ? { model } : {}),
      streaming: true,
      systemMessage: { mode: "replace", content: turn.systemPrompt },
      onPermissionRequest: approveAll,
      ...(provider ? { provider } : {}),
      infiniteSessions: { enabled: false },
      skipCustomInstructions: true,
      ...(toolsEnabled && tools.length
        ? {
            tools: tools.map((tool) =>
              defineTool(tool.name, {
                description: tool.description,
                parameters: tool.parameters as Record<string, unknown>,
                skipPermission: true,
                handler: (args) => tool.execute(randomBytes(8).toString("hex"), args),
              }),
            ),
          }
        : {}),
    };
    let session: CopilotSession | undefined;
    let firstOutputAt: number | null = null;
    let modelCalls = 0;
    let tapeWriteFailed = false;
    const startedAt = Date.now();
    const stopSignals =
      opts.signals && turn.runId
        ? startSignalPoll(
            opts.signals,
            turn.runId,
            {
              onAbort: async () => {
                toolAbort.abort();
                await session?.abort().catch(() => undefined);
              },
              onSteer: async (text, ts) => {
                await turn.emit({
                  type: "user",
                  payload: { text, ...(ts ? { ts } : {}), steered: true },
                  scopeLabel: turn.scopeLabel,
                });
                await session?.send(text).catch(() => undefined);
              },
            },
            { onError: (error) => swallow("copilot signal poll", error) },
          )
        : null;
    let timer: NodeJS.Timeout | undefined;
    try {
      session = await rt.client.createSession(sessionConfig);
      const onCancel = () => {
        toolAbort.abort();
        void session?.abort().catch(() => undefined);
      };
      if (turn.cancel) {
        if (turn.cancel.aborted) onCancel();
        else turn.cancel.addEventListener("abort", onCancel, { once: true });
      }
      let lastUsage: LlmCallUsage | null = null;
      const unsubscribe = session.on((event: SessionEvent) => {
        switch (event.type) {
          case "assistant.message_delta": {
            const delta = (event.data as { deltaContent?: string }).deltaContent;
            if (typeof delta === "string" && delta) {
              firstOutputAt ??= Date.now();
              turn.onDelta?.(delta);
            }
            break;
          }
          case "assistant.message": {
            const usage = usageFromAssistantMessage(event);
            if (usage && usage.output) {
              modelCalls++;
              const input = lastUsage?.input ?? 0;
              turn.recordModelCall({ model, inputTokens: input, entryCount: turn.history.length });
            }
            break;
          }
          case "assistant.usage": {
            lastUsage = usageFromUsageEvent(event);
            if (lastUsage && (lastUsage.output || lastUsage.input)) {
              modelCalls++;
              turn.recordModelCall({
                model,
                inputTokens: lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite,
                entryCount: turn.history.length,
              });
            }
            break;
          }
          case "model.call_failure": {
            const data = event.data as { errorMessage?: string };
            throw copilotProviderFailure(data.errorMessage ?? "copilot model call failed");
          }
          case "session.error": {
            const message =
              (event.data as { message?: string })?.message ?? JSON.stringify(event.data);
            throw copilotProviderFailure(message);
          }
        }
      });
      if (turn.tape) {
        try {
          await turn.tape({
            kind: "message",
            harness: "copilot",
            scopeLabel: turn.scopeLabel,
            entrySeq: userEntry.seq,
            meta: {
              bareText: turn.input,
              ...((turn.triggerTs ?? turn.entryTs) ? { ts: (turn.triggerTs ?? turn.entryTs)! } : {}),
            },
            payload: { role: "user", content: inputText },
          });
        } catch (error) {
          tapeWriteFailed = true;
          swallow("copilot: tape append", error);
        }
      }
      const attachments = (turn.images ?? []).map((image) => ({
        type: "blob" as const,
        data: image.dataBase64,
        mimeType: image.mimeType,
      }));
      const response = await Promise.race([
        session.sendAndWait({ prompt: inputText, ...(attachments.length ? { attachments } : {}) }),
        new Promise<never>((_, reject) => {
          if (wallMs > 0)
            timer = setTimeout(
              () => reject(new NonRetryableTurnError(`Copilot turn exceeded ${Math.round(wallMs / 1000)}s wall clock`)),
              wallMs,
            );
        }),
      ]);
      unsubscribe();
      if (modelCalls === 0) {
        modelCalls = 1;
        turn.recordModelCall({ model, inputTokens: fallbackInputTokens, entryCount: turn.history.length });
      }
      if (turn.recordLlmRequest) {
        try {
          await turn.recordLlmRequest({
            turnSeq: userEntry.seq,
            step: 0,
            model,
            promptEnvelope: { sessionConfig: { ...sessionConfig, ...(provider ? { provider: "[redacted]" } : {}) } },
            truncated: Boolean(turn.images?.length),
            transport: { modelId: model },
            ttftMs: firstOutputAt ? firstOutputAt - startedAt : null,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          swallow("copilot: llm request record", error);
        }
      }
      const reply = (response?.data?.content ?? "").trim();
      const terminal = ref.silentRequested || ref.pausedOnApproval;
      const finalReply = terminal ? "" : reply;
      if (finalReply)
        await turn.emit({
          type: "assistant",
          payload: { text: finalReply },
          scopeLabel: turn.scopeLabel,
        });
      return {
        reply: finalReply,
        ...(ref.silentRequested ? { silent: true } : {}),
        ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
        ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
        modelCalls,
        ...(tapeWriteFailed ? { tapeWriteFailed: true } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      await stopSignals?.();
      await session?.disconnect().catch(() => undefined);
    }
  };

  const single = async (
    systemPrompt: string,
    prompt: string,
    signal?: AbortSignal,
    observe?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
    modelOverride?: string,
  ): Promise<string | undefined> => {
    const session = { id: `oneshot-${randomBytes(8).toString("hex")}` } as HarnessTurnInput["session"];
    const scope = { kind: "org", id: "oneshot" } as unknown as ScopeId;
    const emitted: SessionEntry[] = [];
    const result = await runPrompt(
      {
        session,
        input: prompt,
        systemPrompt,
        history: [],
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: scope,
        orgScopeId: scope,
        ...(signal ? { cancel: signal } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
        readOnly: true,
        emit: async (entry) => {
          const saved = {
            ...entry,
            sessionId: session.id,
            seq: emitted.length + 1,
            createdAt: Date.now(),
          } as SessionEntry;
          emitted.push(saved);
          return saved;
        },
        recordModelCall: observe?.recordModelCall ?? (() => {}),
        ...(observe?.recordLlmRequest ? { recordLlmRequest: observe.recordLlmRequest } : {}),
      },
      false,
    );
    return result.reply || undefined;
  };

  return defineHarness(
    {
      id: "copilot",
      controlTransport: "sdk",
      toolTransport: "dynamic",
      transcriptFormat: "copilot-sdk",
      capabilities: new Set(["abort", "steer", "images", "provider-sessions"]),
    },
    {
      runTurn: runPrompt,
      close: async () => {
        await starting?.catch(() => undefined);
        const current = runtime;
        if (current) {
          await current.client.stop().catch(() => undefined);
          rmSync(current.jail, { recursive: true, force: true });
          if (runtime === current) runtime = null;
        }
      },
      resetSession: () => {},
      oneShot: (system, prompt) => single(system, prompt),
      judge: (system, prompt) => single(system, prompt, undefined, undefined, judgeModelId),
      screenSecurity: async ({ payload, signal, recordModelCall, recordLlmRequest }) =>
        parseSecurityScreenVerdict(
          await single(SECURITY_SCREEN_SYSTEM_PROMPT, payload, signal, {
            recordModelCall,
            ...(recordLlmRequest ? { recordLlmRequest } : {}),
          }),
        ),
      generateTitle: async (transcript) =>
        sanitizeTitle(await single(TITLE_GENERATION_PROMPT, titleUserPrompt(transcript))),
      summarizeApproval: async (command, reason, purpose) =>
        single(
          "Explain this command in one plain-English sentence for an approver.",
          [command, reason, purpose].filter(Boolean).join("\n"),
        ),
    },
  );
}
