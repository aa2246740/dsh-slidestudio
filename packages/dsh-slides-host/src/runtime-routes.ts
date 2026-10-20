import type { IncomingMessage, ServerResponse } from "node:http";
import { buildCatalogDto, resolveCatalogPreviewFile } from "@open-slidestudio/presentation-run";
import { BYOK_PRESETS } from "./byok.js";
import { hubCapabilityCard } from "./hub-capability.js";
import { loadSlidesModelCatalog, modelInputModalities, type RuntimeModelCatalog } from "./local-models.js";
import { readXaiLoginSnapshot, routeHasNativeSearch } from "./oauth-login.js";
import { connectionState, hostedProviders, slidesProviders, withDshModelCatalog } from "./providers.js";
import { inspectHubProduceGates } from "./produce-gates.js";
import type { SlidesHostRuntime } from "./routes.js";
import {
  applyToolSettingsToEnv,
  mergeToolSettingsEnv,
  parseToolSettingsPatch,
  readStoredToolSettings,
  readToolSettings,
  toToolSettingsView,
  writeToolSettings,
} from "./tool-settings.js";
import { readJson, sendJson } from "./http-json.js";

type RouteDependencies = {
  match: (pathname: string, pattern: string) => Record<string, string> | undefined;
};

function capabilityEnv(home: string): NodeJS.ProcessEnv {
  const stored = readStoredToolSettings(home);
  return stored ? mergeToolSettingsEnv(process.env, stored) : process.env;
}

function availableRoster(runtime: SlidesHostRuntime, catalog?: RuntimeModelCatalog) {
  return (
    runtime.managedModels
      ? hostedProviders(catalog ?? new Map())
      : withDshModelCatalog(slidesProviders(runtime.dshHome), catalog)
  ).map((provider) => {
    const health = runtime.providerHealth?.(provider.id);
    if (!health) return provider;
    if (runtime.managedModels) return { ...provider, degraded: true, degradedReason: health.reason };
    return health.kind === "broken"
      ? { ...provider, ready: false, readyReason: health.reason }
      : { ...provider, degraded: true, degradedReason: health.reason };
  });
}

export async function handleRuntimeRoutes(
  runtime: SlidesHostRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dependencies: RouteDependencies,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname === "/slides/runtime" && req.method === "GET") {
    sendJson(
      res,
      200,
      runtime.renderRuntime?.() ?? { phase: "failed", error: "Render runtime status is unavailable." },
    );
    return true;
  }
  if (pathname === "/slides/runtime" && req.method === "POST") {
    void runtime.startRenderRuntime?.();
    sendJson(res, 200, runtime.renderRuntime?.() ?? { phase: "failed", error: "Render runtime setup is unavailable." });
    return true;
  }
  if (req.method === "GET" && pathname === "/slides/catalog") {
    sendJson(res, 200, buildCatalogDto(runtime.workspaceRoot));
    return true;
  }
  const previewParams = dependencies.match(pathname, "/slides/catalog/previews/:sourceId");
  if (req.method === "GET" && previewParams) {
    const preview = resolveCatalogPreviewFile(previewParams.sourceId!, runtime.workspaceRoot);
    if (!preview) {
      sendJson(res, 404, { error: "unknown catalog preview" });
      return true;
    }
    res.writeHead(200, {
      "content-type": preview.mediaType,
      "content-length": preview.bytes.length,
      etag: `"${preview.sha256}"`,
      "cache-control": "public, max-age=0, must-revalidate",
    });
    res.end(preview.bytes);
    return true;
  }
  if (req.method === "GET" && pathname === "/slides/tool-settings") {
    sendJson(res, 200, { ok: true, settings: toToolSettingsView(readToolSettings(runtime.dshHome)) });
    return true;
  }
  if (req.method === "PUT" && pathname === "/slides/tool-settings") {
    await updateToolSettings(runtime, req, res);
    return true;
  }
  if (req.method === "GET") {
    switch (pathname) {
      case "/slides/health":
        await sendHealth(runtime, res, url);
        return true;
      case "/slides/models":
        await sendModels(runtime, res);
        return true;
      case "/slides/providers":
        await sendProviders(runtime, res);
        return true;
    }
  }
  return false;
}

async function updateToolSettings(
  runtime: SlidesHostRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const previous = readToolSettings(runtime.dshHome);
    const settings = parseToolSettingsPatch(await readJson(req), previous);
    writeToolSettings(runtime.dshHome, settings);
    applyToolSettingsToEnv(process.env, settings);
    sendJson(res, 200, { ok: true, settings: toToolSettingsView(settings) });
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "invalid tool settings",
    });
  }
}

async function sendHealth(runtime: SlidesHostRuntime, res: ServerResponse, url: URL): Promise<void> {
  const connection = connectionState(runtime.dshHome);
  const produceGates = inspectHubProduceGates(runtime.workspaceRoot);
  const wantProvider = url.searchParams.get("provider")?.trim() || "";
  const wantModel = url.searchParams.get("model")?.trim() || "";
  const modelCatalog = await runtime.listModelCatalog?.();
  const roster = availableRoster(runtime, modelCatalog);
  const selectedProvider =
    wantProvider || (runtime.managedModels ? roster.find((row) => row.ready)?.id : undefined) || connection.providerId;
  const selectedRow = roster.find((item) => item.id === selectedProvider);
  const selectedModel = wantModel || selectedRow?.models?.[0] || connection.model;
  const modelKnown = selectedRow?.models.includes(selectedModel) ?? false;
  const selectedReady = modelKnown && selectedRow?.ready === true;
  const selectedModalities = modelInputModalities(runtime.dshHome, selectedProvider, selectedModel, modelCatalog);
  sendJson(res, 200, {
    ok: true,
    product: "DSH SlideStudio",
    kernel: "dsh",
    minimaxReady: connection.ready,
    generateReady: selectedReady && produceGates.ok,
    produceGates: {
      ok: produceGates.ok,
      id: produceGates.id,
      missing: produceGates.missing,
      failed: produceGates.failed,
      hashMatch: produceGates.hashMatch,
      emptyWriteRejected: produceGates.emptyWriteRejected,
      emptyCreateHasNoSeed: produceGates.emptyCreateHasNoSeed,
      generateReady: produceGates.generateReady,
    },
    connection,
    renderRuntime: runtime.renderRuntime?.() ?? {
      phase: "failed",
      error: "Render runtime status is unavailable.",
    },
    selection: { providerId: selectedProvider, model: selectedModel, ready: Boolean(selectedReady) },
    capability: hubCapabilityCard({
      providerId: selectedProvider,
      modelId: selectedModel,
      modelInputModalities: selectedModalities,
      ready: Boolean(selectedReady),
      env: capabilityEnv(runtime.dshHome),
      nativeSearch: routeHasNativeSearch(selectedProvider) && Boolean(selectedReady),
    }),
  });
}

async function sendModels(runtime: SlidesHostRuntime, res: ServerResponse): Promise<void> {
  const catalog = await runtime.listModelCatalog?.();
  const groups = availableRoster(runtime, catalog)
    .filter((provider) => provider.ready && provider.models.length > 0)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      ready: true,
      degraded: provider.degraded ?? false,
      degradedReason: provider.degradedReason,
      nativeSearch: provider.nativeSearch ?? false,
      modelEfforts: provider.modelEfforts,
      efforts: provider.efforts,
      models: provider.models.map((id) => ({
        id,
        name: catalog?.get(provider.id)?.get(id)?.name || id,
        inputModalities: modelInputModalities(runtime.dshHome, provider.id, id, catalog) ?? [],
      })),
    }));
  sendJson(res, 200, groups);
}

async function sendProviders(runtime: SlidesHostRuntime, res: ServerResponse): Promise<void> {
  const connection = connectionState(runtime.dshHome);
  const xai = readXaiLoginSnapshot(runtime.dshHome);
  const catalog = loadSlidesModelCatalog(runtime.dshHome);
  const providers = availableRoster(runtime, await runtime.listModelCatalog?.());
  sendJson(res, 200, {
    providers,
    connection,
    catalog: catalog
      ? {
          defaultProvider: catalog.defaultProvider,
          defaultModel: catalog.defaultModel,
          excluded: catalog.excluded,
          oauthSkipped: catalog.oauthSkipped,
        }
      : undefined,
    oauth: {
      available: xai.status === "signed-in",
      ...(xai.status === "signed-in"
        ? { route: "pi-xai" }
        : {
            reason:
              "OAuth grants stay in the local DSH App. This product uses an isolated DSH_HOME and will not copy them.",
          }),
    },
    presets: BYOK_PRESETS,
  });
}
