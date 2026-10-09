const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer", minimum: 0 };
const object = (properties, required = []) => ({ type: "object", properties, required });
const array = (items) => ({ type: "array", items });
const error = object({ error: string, requestId: string }, ["error"]);
const jsonResponse = (schema, description = "Successful response") => ({
  description,
  content: { "application/json": { schema } },
  headers: { "X-Request-ID": { description: "Validated opaque correlation ID, not authentication.", schema: string } },
});
function operation(id, summary, response, body) {
  return {
    operationId: id,
    summary,
    ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body } } } } : {}),
    responses: {
      200: jsonResponse(response),
      400: jsonResponse(error, "Invalid request"),
      403: jsonResponse(error, "Cross-site request rejected"),
      500: jsonResponse(error, "Runtime failure; correlate by request ID"),
    },
  };
}

const health = object(
  { ok: boolean, llm: boolean, source: { type: ["string", "null"] }, model: { type: ["string", "null"] } },
  ["ok", "llm"],
);
const diagnostics = object(
  {
    app: string,
    version: string,
    startedAt: { type: "string", format: "date-time" },
    counters: array(
      object({
        method: string,
        route: string,
        status: integer,
        count: integer,
        totalMs: { type: "number" },
        maxMs: { type: "number" },
      }),
    ),
    errors: array(object({ fingerprint: string, requestId: string, error: object({ name: string, code: string }) })),
  },
  ["app", "version", "counters", "errors"],
);
const model = object(
  { id: string, name: string, inputModalities: array({ type: "string", enum: ["text", "image"] }) },
  ["id", "name"],
);
const group = object({ providerId: string, providerName: string, ready: boolean, models: array(model) }, [
  "providerId",
  "models",
]);
const generateInput = object({
  prompt: string,
  title: string,
  modelId: string,
  templateId: string,
  references: array(object({ name: string, text: string })),
  baseDeck: { type: "object", description: "Archived legacy Deck IR, never used as native PPTD SSOT." },
  baseVersionId: string,
  baseVersionNumber: integer,
  pins: array(object({ id: string, slideId: string, x: { type: "number" }, y: { type: "number" }, text: string })),
});
const generateResult = object(
  {
    deck: { type: "object" },
    versionId: string,
    versionNumber: integer,
    versionLabel: string,
    summary: string,
    provider: string,
    displayName: string,
    steps: array(
      object({ id: string, tool: string, status: { type: "string", enum: ["running", "completed", "failed"] } }),
    ),
  },
  ["deck", "provider"],
);
const projectQuery = [
  {
    name: "project",
    in: "query",
    required: false,
    description: "Local project path, validated by the native server.",
    schema: string,
  },
];
const command = object({
  cmd: {
    type: "object",
    description: "Native canvas-session command. See the typed command protocol in packages/canvas-session.",
  },
  tabId: string,
  project: string,
});
const sessionInput = object(
  {
    brief: { type: "string", minLength: 1 },
    designSystemId: string,
    provider: string,
    model: string,
    thinking: string,
    clientRequestId: string,
  },
  ["brief"],
);
const sessionResponse = object({ sessionId: string, projectRoot: string, attemptId: string }, ["sessionId"]);
const sessionParameter = [{ name: "sessionId", in: "path", required: true, schema: string }];

export const apiContracts = {
  legacy: {
    title: "Archived legacy API",
    port: 8787,
    source: "apps/server/src/index.mjs",
    paths: {
      "/api/health": { get: operation("legacyHealth", "Local provider readiness, without credentials", health) },
      "/api/generate": {
        post: operation(
          "legacyGenerate",
          "Generate or refine the archived legacy Deck with the selected model",
          generateResult,
          generateInput,
        ),
      },
      "/api/export-pptx": {
        post: {
          ...operation(
            "legacyExport",
            "Export the archived legacy Deck as editable PPTX",
            {},
            object({ deck: { type: "object" }, filename: string }, ["deck"]),
          ),
          responses: {
            200: {
              description: "Editable PPTX",
              content: {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            400: jsonResponse(error),
            500: jsonResponse(error),
          },
        },
      },
      "/api/diagnostics": {
        get: operation("legacyDiagnostics", "Bounded in-memory operational counters", diagnostics),
      },
      "/api/openapi": { get: operation("legacySchema", "This generated OpenAPI document", { type: "object" }) },
    },
  },
  native: {
    title: "Native editor API, critical HTTP interfaces",
    port: 55200,
    source: "apps/native-web/src/server.mjs",
    paths: {
      "/api/health": {
        get: operation(
          "nativeHealth",
          "Read editor/project health and capability status",
          object({ ok: boolean, title: string, pageCount: integer }),
        ),
      },
      "/api/projects": {
        get: operation(
          "nativeProjects",
          "Discover local PPTD projects",
          object({ projects: array(object({ id: string, title: string, path: string, pageCount: integer })) }),
        ),
      },
      "/api/open": {
        post: operation(
          "nativeOpen",
          "Open a validated local project in the requesting tab",
          { type: "object" },
          object({ path: string, tabId: string }, ["path"]),
        ),
      },
      "/api/command": {
        post: operation(
          "nativeCommand",
          "Apply a native command under project and tab write guards",
          { type: "object" },
          command,
        ),
      },
      "/api/versions": {
        get: {
          ...operation("nativeVersions", "List recoverable PPTD versions", { type: "object" }),
          parameters: projectQuery,
        },
        post: operation(
          "nativeSnapshot",
          "Save a recoverable version",
          { type: "object" },
          object({ project: string, label: string, tabId: string }),
        ),
      },
      "/api/versions/restore": {
        post: operation(
          "nativeRestore",
          "Restore a validated version with existing write-lock rules",
          { type: "object" },
          object({ id: string, project: string, tabId: string }, ["id"]),
        ),
      },
      "/api/export": {
        post: operation(
          "nativeExport",
          "Export the editable deck or current page; output includes the existing export report",
          { type: "object" },
          object({ project: string, format: { type: "string", enum: ["pptx", "png", "pdf"] }, tabId: string }),
        ),
      },
      "/api/diagnostics": {
        get: operation(
          "nativeDiagnostics",
          "Local request counters without project identities or content",
          diagnostics,
        ),
      },
    },
  },
  host: {
    title: "SlideStudio Host API shared by standalone and plugin",
    port: 13080,
    source: "packages/dsh-slides-host/src/routes.ts",
    paths: {
      "/slides/health": {
        get: operation(
          "hostHealth",
          "Read selected-provider readiness and produce gates",
          object({
            ok: boolean,
            generateReady: boolean,
            selection: object({ providerId: string, model: string, ready: boolean }),
          }),
        ),
      },
      "/slides/models": {
        get: operation(
          "hostModels",
          "Read the current runtime-backed model roster, without invented fallback entries",
          array(group),
        ),
      },
      "/slides/providers": {
        get: operation(
          "hostProviders",
          "Read supplier-scoped provider status; never expose API keys",
          object({ providers: array({ type: "object" }), connection: { type: "object" } }),
        ),
      },
      "/slides/assistant-intent": {
        post: operation(
          "hostIntent",
          "Classify the next turn without granting write permission",
          { type: "object" },
          object({ text: string, projectRoot: string }, ["text"]),
        ),
      },
      "/slides/sessions": {
        post: operation(
          "hostCreateSession",
          "Start a real provider-backed session; may incur provider usage",
          sessionResponse,
          sessionInput,
        ),
      },
      "/slides/sessions/{sessionId}/turn": {
        parameters: sessionParameter,
        post: operation(
          "hostTurn",
          "Send a scoped continuous-conversation turn",
          { type: "object" },
          object({ text: string, model: string, editorEdit: { type: "object" }, steer: boolean }, ["text"]),
        ),
      },
      "/slides/sessions/{sessionId}/stop": {
        parameters: sessionParameter,
        post: operation(
          "hostStop",
          "Stop without authorizing or completing unfinished edits",
          { type: "object" },
          object({}),
        ),
      },
      "/slides/state/{sessionId}": {
        parameters: sessionParameter,
        get: operation(
          "hostState",
          "Read durable session state and verified page evidence",
          object({ binding: { type: "object" }, project: { type: "object" }, phase: { type: "object" } }, [
            "binding",
            "project",
            "phase",
          ]),
        ),
      },
    },
  },
};
