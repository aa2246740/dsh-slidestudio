/**
 * `PiAiLlmPort`: drive `@earendil-works/pi-ai` directly so SlideStudio runs
 * without any host. Serves either a model registered in a pi-ai `Models`
 * collection (built-in catalog or caller-provided providers) or a custom
 * OpenAI-compatible endpoint with an API key. HTTP status and Retry-After of
 * a failed request are captured and attached as a structured `LlmFailure`.
 */
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type ProviderResponse,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { parseRetryAfterMs } from "./faults.js";
import {
  attachLlmFailure,
  failedStream,
  failureFromThrown,
  modelForRoute,
  routeForModel,
  type LlmFailure,
  type LlmInputModality,
  type LlmPort,
  type LlmRoute,
} from "./llm-port.js";
import { redactText, registerSecret } from "./redact.js";

export type PiAiCustomApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export type PiAiRegisteredConfig = {
  readonly kind: "registered";
  readonly models: Models;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly reasoningEffort?: ThinkingLevel;
  readonly maxRetries?: number;
};

export type PiAiEndpointConfig = {
  readonly kind: "openai-compatible";
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly providerId?: string;
  readonly api?: PiAiCustomApi;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly inputModalities?: readonly LlmInputModality[];
  readonly reasoningEffort?: ThinkingLevel;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxRetries?: number;
};

export type PiAiPortConfig = PiAiRegisteredConfig | PiAiEndpointConfig;

const CUSTOM_APIS: Record<PiAiCustomApi, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

export class PiAiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAiConfigError";
  }
}

function endpointModels(config: PiAiEndpointConfig): { models: Models; model: Model<Api>; route: LlmRoute } {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new PiAiConfigError(`baseUrl is not a valid URL: ${config.baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PiAiConfigError("baseUrl must be http(s)");
  if (!config.modelId.trim()) throw new PiAiConfigError("modelId is required");
  const api = config.api ?? "openai-completions";
  const route: LlmRoute = {
    providerId: config.providerId ?? "openai-compatible",
    modelId: config.modelId,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    inputModalities: config.inputModalities ?? ["text"],
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
  const model = {
    ...modelForRoute(route, { api, baseUrl: config.baseUrl }),
    ...(config.headers ? { headers: { ...config.headers } } : {}),
  };
  const apiKey = config.apiKey;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: route.providerId,
      name: route.providerId,
      baseUrl: config.baseUrl,
      auth: { apiKey: { name: "api-key", resolve: async () => (apiKey ? { auth: { apiKey } } : undefined) } },
      models: [model],
      api: { [api]: CUSTOM_APIS[api]() },
    }),
  );
  return { models, model, route };
}

function registeredModel(config: PiAiRegisteredConfig): { models: Models; model: Model<Api>; route: LlmRoute } {
  const model = config.models.getModel(config.providerId, config.modelId);
  if (!model) throw new PiAiConfigError(`model ${config.providerId}/${config.modelId} is not registered`);
  return { models: config.models, model, route: routeForModel(model, config.reasoningEffort) };
}

type Captured = { status?: number; headers?: Record<string, string> };

function failureFor(message: AssistantMessage, captured: Captured): LlmFailure {
  const retryAfterMs =
    parseRetryAfterMs(captured.headers ? { headers: captured.headers } : undefined) ??
    parseRetryAfterMs(message.errorMessage ?? "");
  const status = captured.status !== undefined && captured.status >= 400 ? captured.status : undefined;
  const code =
    message.stopReason === "aborted"
      ? "ABORTED"
      : status === 429
        ? "RATE_LIMIT"
        : status === 401 || status === 403
          ? "AUTH"
          : status !== undefined && status >= 500
            ? "SERVER"
            : "PI_AI_ERROR";
  const safeMessage = redactText(message.errorMessage ?? "model request failed");
  return {
    code,
    message: safeMessage,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

async function forward(source: AssistantMessageEventStream, out: AssistantMessageEventStream, captured: Captured) {
  for await (const event of source) {
    if (event.type === "error") {
      const failure = failureFor(event.error, captured);
      event.error.errorMessage = failure.message;
      attachLlmFailure(event.error, failure);
    }
    out.push(event);
  }
  out.end();
}

export class PiAiLlmPort implements LlmPort {
  readonly route: LlmRoute;
  readonly model: Model<Api>;
  private readonly models: Models;
  private readonly apiKey?: string;
  private readonly maxRetries?: number;

  constructor(config: PiAiPortConfig) {
    const resolved = config.kind === "registered" ? registeredModel(config) : endpointModels(config);
    this.models = resolved.models;
    this.model = resolved.model;
    this.route = resolved.route;
    this.apiKey = config.kind === "registered" ? config.apiKey : undefined;
    this.maxRetries = config.maxRetries;
    registerSecret(config.apiKey);
  }

  readonly stream: StreamFn = (model, context, options) => {
    const captured: Captured = {};
    const out = createAssistantMessageEventStream();
    try {
      const source = this.models.streamSimple(model, context, {
        ...options,
        ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
        onResponse: async (response: ProviderResponse, requestModel: Model<Api>) => {
          captured.status = response.status;
          captured.headers = response.headers;
          await options?.onResponse?.(response, requestModel);
        },
      });
      void forward(source, out, captured).catch((error: unknown) => {
        const failed = failedStream(model, failureFromThrown(error, "PI_AI_ERROR"));
        void failed.result().then((message) => out.push({ type: "error", reason: "error", error: message }));
      });
      return out;
    } catch (error) {
      return failedStream(model, failureFromThrown(error, "PI_AI_ERROR"), options?.signal?.aborted === true);
    }
  };
}

/** A port over pi-ai's built-in provider catalog (provider API keys from options or the environment). */
export async function createBuiltinPiAiPort(
  input: Omit<PiAiRegisteredConfig, "kind" | "models">,
): Promise<PiAiLlmPort> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  return new PiAiLlmPort({ kind: "registered", models: builtinModels(), ...input });
}
