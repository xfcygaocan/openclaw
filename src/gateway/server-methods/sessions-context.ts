import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveCommandsSystemPromptBundle } from "../../auto-reply/reply/commands-system-prompt.js";
import type { HandleCommandsParams } from "../../auto-reply/reply/commands-types.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
  getSessionDefaults,
} from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

export const sessionsContextHandlers: GatewayRequestHandlers = {
  "sessions.context": async ({ params, respond }) => {
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }

    try {
      const { cfg, storePath, entry } = loadSessionEntry(key);
      const agentId = resolveSessionAgentId({ sessionKey: key, config: cfg });
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const { provider, model } = resolveSessionModelRef(cfg, entry, agentId);
      const defaults = getSessionDefaults(cfg);
      const contextTokens = entry?.contextTokens ?? defaults.contextTokens ?? 128_000;

      // Build a synthetic HandleCommandsParams with minimal stubs so
      // resolveCommandsSystemPromptBundle can assemble the full system prompt and tools.
      const syntheticCtx: MsgContext = { SessionKey: key };
      const syntheticParams: HandleCommandsParams = {
        ctx: syntheticCtx,
        cfg,
        command: {
          surface: "tui",
          channel: "tui",
          ownerList: [],
          senderIsOwner: true,
          isAuthorizedSender: true,
          rawBodyNormalized: "",
          commandBodyNormalized: "",
        },
        agentId,
        directives: {
          cleaned: "",
          hasThinkDirective: false,
          hasVerboseDirective: false,
          hasReasoningDirective: false,
          hasElevatedDirective: false,
          hasExecDirective: false,
          hasExecOptions: false,
          invalidExecHost: false,
          invalidExecSecurity: false,
          invalidExecAsk: false,
          invalidExecNode: false,
          hasStatusDirective: false,
          hasModelDirective: false,
          hasQueueDirective: false,
          queueReset: false,
          hasQueueOptions: false,
        },
        elevated: { enabled: false, allowed: false, failures: [] },
        sessionEntry: entry,
        sessionKey: key,
        storePath,
        workspaceDir,
        defaultGroupActivation: () => "mention",
        resolvedThinkLevel: (entry as Record<string, unknown> | undefined)?.thinkingLevel as
          | HandleCommandsParams["resolvedThinkLevel"]
          | undefined,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        provider,
        model,
        contextTokens,
        isGroup: false,
      };

      const bundle = await resolveCommandsSystemPromptBundle(syntheticParams);

      // Read raw conversation messages from the session transcript.
      const sessionId = entry?.sessionId;
      const messages = sessionId ? readSessionMessages(sessionId, storePath) : [];

      const tools = bundle.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      respond(true, {
        systemPrompt: bundle.systemPrompt,
        tools,
        messages,
        meta: {
          model,
          provider,
          agentId,
          sessionKey: key,
          thinkingLevel: entry?.thinkingLevel ?? null,
          contextTokens,
        },
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `sessions.context failed: ${String(err)}`),
      );
    }
  },
};
