import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { bindMinimaxCnKey, generateRouteState, minimaxCnKeyPresent, openrouterKeyPresent, readMinimaxCnKey, resolveSlidesLlmRoute, OPENROUTER_MINIMAX_FREE_MODEL, } from "./args.js";
import { isAntigravityId, loadSlidesModelCatalog, providerModelEffortsFromHome, providerReasoningEffortsFromHome, } from "./local-models.js";
import { readByokProviders } from "./byok.js";
import { GROK_DEFAULT_MODEL, GROK_PREFERRED_MODELS, GROK_PROVIDER, OSS_OAUTH_PROVIDERS, readXaiLoginSnapshot, routeHasNativeSearch, signedInOauthRoutes, } from "./oauth-login.js";
const FALLBACK_PROVIDERS = [
    {
        id: GROK_PROVIDER,
        name: "Grok (xAI)",
        methods: ["oauth"],
        models: [...GROK_PREFERRED_MODELS],
        nativeSearch: true,
    },
    {
        id: "minimax-cn",
        name: "MiniMax 中国",
        methods: ["api_key"],
        models: ["MiniMax-M3", "MiniMax-M2.7"],
        nativeSearch: false,
    },
];
export function slidesProviders(home) {
    const catalog = home ? loadSlidesModelCatalog(home) : undefined;
    const keys = (catalog?.providers ?? []).map((row) => {
        const apiKeyEnv = row.apiKeyEnv?.trim();
        const envReady = Boolean(apiKeyEnv && process.env[apiKeyEnv]?.trim());
        const keyStored = Boolean(home && loadHomeKey(home, row.id));
        const efforts = home ? providerReasoningEffortsFromHome(home, row.id) : undefined;
        const modelEfforts = home ? providerModelEffortsFromHome(home, row.id) : undefined;
        return {
            id: row.id,
            name: row.name,
            methods: ["api_key"],
            models: row.models.length > 0 ? row.models : ["MiniMax-M3"],
            // A catalog row's static `ready` flag only describes the route, never
            // credentials — "ready" means a call could actually be attempted: a key
            // resolves from env or the home key store, or the route is keyless by
            // declaration (no apiKeyEnv, e.g. a local gateway that authenticates
            // itself).
            ready: Boolean(envReady || keyStored || (row.ready && !row.apiKeyEnv)),
            keyStored,
            nativeSearch: routeHasNativeSearch(row.id),
            ...(efforts !== undefined ? { efforts } : {}),
            ...(modelEfforts !== undefined ? { modelEfforts } : {}),
        };
    });
    const base = keys.length > 0
        ? keys
        : FALLBACK_PROVIDERS.map((provider) => ({
            ...provider,
            ready: provider.id === "minimax-cn" &&
                Boolean(minimaxCnKeyPresent() || (home && loadHomeKey(home, provider.id))) &&
                !generateRouteState.minimaxCnAuthFailed,
        }));
    if (home) {
        for (const row of readByokProviders(home)) {
            if (base.some((item) => item.id === row.id))
                continue;
            const keyStored = Boolean(loadHomeKey(home, row.id));
            const envReady = Boolean(process.env[row.apiKeyEnv]?.trim());
            const modelEfforts = providerModelEffortsFromHome(home, row.id);
            base.push({
                id: row.id,
                name: row.name,
                methods: ["api_key"],
                models: row.models.length > 0 ? [...row.models] : ["default"],
                ready: envReady || keyStored,
                keyStored,
                nativeSearch: false,
                userAdded: true,
                baseURL: row.baseURL,
                ...(modelEfforts !== undefined ? { modelEfforts } : {}),
            });
        }
    }
    const oauth = home ? signedInOauthRoutes(home) : [];
    const signed = new Set(oauth.map((row) => row.route));
    const merged = [...base];
    // Subscription routes come from the oss-oauth-login plugin, but the model
    // import writes the same ids into the catalog WITHOUT the grant (oauth
    // files are never copied into this home). That catalog row has no key, so
    // its own `ready` is false — a stored grant must override it, or a signed-in
    // route disappears from the picker.
    for (const row of OSS_OAUTH_PROVIDERS) {
        const signedIn = signed.has(row.route);
        const index = merged.findIndex((item) => item.id === row.route);
        if (index >= 0) {
            merged[index] = { ...merged[index], ready: signedIn, methods: ["oauth"] };
            continue;
        }
        // A stored grant means the adapter exists. Real call failures degrade the
        // route at runtime; nothing more is checkable here.
        merged.push({
            id: row.route,
            name: row.name,
            methods: ["oauth"],
            models: row.models.length > 0 ? [...row.models] : [],
            ready: signedIn,
            nativeSearch: routeHasNativeSearch(row.route),
        });
    }
    return merged;
}
/** Hosted plugins use DSH's live adapters; no duplicate credential/catalog store. */
export function hostedProviders(catalog) {
    return [...catalog].map(([id, models]) => ({
        id,
        name: id,
        methods: [],
        models: [...models.keys()],
        ready: models.size > 0,
        nativeSearch: routeHasNativeSearch(id),
        modelEfforts: Object.fromEntries([...models].map(([model, info]) => [model, info.efforts ?? []])),
    }));
}
/** The same model roster is used by the picker, health and execution guards. */
export function withDshModelCatalog(providers, catalog) {
    return providers
        .filter((provider) => !isAntigravityId(provider.id))
        .map((provider) => {
        if (!catalog)
            return provider;
        const advertised = catalog.get(provider.id);
        return {
            ...provider,
            models: [...(advertised?.keys() ?? [])],
            modelEfforts: Object.fromEntries([...(advertised ?? [])].map(([id, model]) => [id, model.efforts ?? []])),
        };
    });
}
export function slidesProviderHasModel(home, providerId, modelId, catalog) {
    return withDshModelCatalog(slidesProviders(home), catalog).some((provider) => provider.id === providerId && provider.models.includes(modelId));
}
/** @deprecated Use slidesProviders(home). */
export const SLIDES_PROVIDERS = FALLBACK_PROVIDERS;
/**
 * Keys this process has handled. `scrubRegisteredSecrets` removes the exact
 * values from fault text — pattern redaction alone cannot catch a provider key
 * that does not look like a sk-prefixed or Bearer token.
 */
const registeredSecrets = new Set();
function redact(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 8)
        registeredSecrets.add(trimmed);
    return trimmed.length > 4 ? `…${trimmed.slice(-4)}` : "****";
}
/** Remove every registered secret value from free text before it hits disk/UI. */
export function scrubRegisteredSecrets(text) {
    let out = text;
    for (const secret of registeredSecrets) {
        if (secret.length >= 8 && out.includes(secret)) {
            out = out.split(secret).join("[redacted]");
        }
    }
    return out;
}
export function credentialsDir(home) {
    return path.join(home, "credentials");
}
export function keyFile(home, providerId) {
    return path.join(credentialsDir(home), `${providerId}.key`);
}
export function loadHomeKey(home, providerId) {
    const file = keyFile(home, providerId);
    if (!fs.existsSync(file))
        return undefined;
    const value = fs.readFileSync(file, "utf8").trim();
    if (value)
        redact(value);
    return value || undefined;
}
const HOME_KEY_ENV_NAMES = {
    "minimax-cn": ["MINIMAX_CN_API_KEY", "MINIMAXCN_API_KEY", "MINIMAX_API_KEY"],
    amd: ["AMD_API_KEY"],
    "op-custom": ["OP_CUSTOM_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
};
function catalogApiKeyEnv(home, providerId) {
    try {
        const catalog = loadSlidesModelCatalog(home);
        const fromCatalog = catalog?.providers.find((row) => row.id === providerId)?.apiKeyEnv?.trim();
        if (fromCatalog)
            return fromCatalog;
    }
    catch {
        // Catalog is optional; BYOK file still binds.
    }
    return readByokProviders(home).find((row) => row.id === providerId)?.apiKeyEnv;
}
/** Resolve Windows tools from System32 so Git Bash's GNU `whoami` on PATH cannot shadow them. */
function windowsSystemTool(name) {
    return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", name);
}
export function saveHomeKey(home, providerId, apiKey) {
    const value = apiKey.trim();
    if (!value)
        throw new Error("api key required");
    fs.mkdirSync(credentialsDir(home), { recursive: true, mode: 0o700 });
    const file = keyFile(home, providerId);
    const temp = path.join(credentialsDir(home), `.${providerId}.${randomUUID()}.tmp`);
    let descriptor;
    try {
        descriptor = fs.openSync(temp, "wx", 0o600);
        if (process.platform === "win32") {
            const identity = execFileSync(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
                encoding: "utf8",
            });
            const sid = identity
                .split(",")
                .map((part) => part.trim().replace(/^"|"$/g, ""))
                .find((part) => /^S-1-(?:\d+-)+\d+$/.test(part));
            if (!sid)
                throw new Error("Unable to resolve the current Windows SID for key-file permissions");
            const systemRoot = process.env.SystemRoot;
            if (!systemRoot)
                throw new Error("Unable to resolve the Windows system directory for key-file permissions");
            execFileSync(path.join(systemRoot, "System32", "icacls.exe"), [temp, "/inheritance:r", "/grant:r", `*${sid}:(F)`], {
                stdio: "ignore",
            });
        }
        fs.writeFileSync(descriptor, `${value}\n`);
        if (process.platform !== "win32")
            fs.fchmodSync(descriptor, 0o600);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temp, file);
    }
    catch (error) {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temp, { force: true });
        throw error;
    }
    if (providerId === "minimax-cn") {
        process.env.MINIMAX_CN_API_KEY = value;
        process.env.MINIMAXCN_API_KEY = value;
        process.env.MINIMAX_API_KEY = value;
    }
    else if (providerId === "amd") {
        process.env.AMD_API_KEY = value;
    }
    else if (providerId === "op-custom") {
        process.env.OP_CUSTOM_API_KEY = value;
    }
    else if (providerId === "openrouter") {
        process.env.OPENROUTER_API_KEY = value;
    }
    const catalogEnv = catalogApiKeyEnv(home, providerId);
    if (catalogEnv)
        process.env[catalogEnv] = value;
    redact(value);
}
export function deleteHomeKey(home, providerId) {
    const file = keyFile(home, providerId);
    const existed = fs.existsSync(file);
    if (existed)
        fs.unlinkSync(file);
    const names = new Set(HOME_KEY_ENV_NAMES[providerId] ?? []);
    const catalogEnv = catalogApiKeyEnv(home, providerId);
    if (catalogEnv)
        names.add(catalogEnv);
    for (const name of names)
        delete process.env[name];
    return existed;
}
export function bindHomeKeys(home, env = process.env) {
    bindMinimaxCnKey(env);
    if (!minimaxCnKeyPresent(env)) {
        const stored = loadHomeKey(home, "minimax-cn");
        if (stored) {
            env.MINIMAX_CN_API_KEY = stored;
            env.MINIMAXCN_API_KEY = stored;
            env.MINIMAX_API_KEY = stored;
        }
    }
    const bound = new Set(["minimax-cn"]);
    try {
        for (const row of loadSlidesModelCatalog(home)?.providers ?? []) {
            const apiKeyEnv = row.apiKeyEnv?.trim();
            if (!apiKeyEnv || env[apiKeyEnv]?.trim())
                continue;
            const stored = loadHomeKey(home, row.id);
            if (stored)
                env[apiKeyEnv] = stored;
            bound.add(row.id);
        }
    }
    catch {
        // Catalog is best-effort here; fallbacks below still bind well-known ids.
    }
    for (const row of readByokProviders(home)) {
        if (bound.has(row.id) || env[row.apiKeyEnv]?.trim())
            continue;
        const stored = loadHomeKey(home, row.id);
        if (stored)
            env[row.apiKeyEnv] = stored;
        bound.add(row.id);
    }
    for (const [id, names] of Object.entries(HOME_KEY_ENV_NAMES)) {
        if (id === "minimax-cn" || bound.has(id))
            continue;
        if (names.some((name) => env[name]?.trim()))
            continue;
        const stored = loadHomeKey(home, id);
        if (stored)
            env[names[0]] = stored;
    }
}
export function connectionState(home, env = process.env, model = "MiniMax-M3") {
    const hadEnvCn = Boolean(readMinimaxCnKey(env));
    const fromHome = Boolean(loadHomeKey(home, "minimax-cn"));
    bindHomeKeys(home, env);
    const xai = readXaiLoginSnapshot(home);
    const catalog = loadSlidesModelCatalog(home);
    const route = resolveSlidesLlmRoute(env, { xai, home, catalog });
    if (route.provider === GROK_PROVIDER && xai.status === "signed-in") {
        return {
            providerId: GROK_PROVIDER,
            ready: true,
            method: "oauth",
            source: "dsh-home",
            model: route.model || GROK_DEFAULT_MODEL,
        };
    }
    const row = catalog?.providers.find((item) => item.id === route.provider);
    const ready = route.provider === "minimax-cn"
        ? minimaxCnKeyPresent(env) && !generateRouteState.minimaxCnAuthFailed
        : route.provider === "openrouter"
            ? openrouterKeyPresent(env)
            : route.provider === "amd"
                ? Boolean(env.AMD_API_KEY?.trim())
                : route.provider === "op-custom"
                    ? Boolean(env.OP_CUSTOM_API_KEY?.trim())
                    : Boolean(row?.ready || (row?.apiKeyEnv && env[row.apiKeyEnv]?.trim()));
    if (ready) {
        return {
            providerId: route.provider,
            ready: true,
            method: "api_key",
            source: hadEnvCn && route.provider === "minimax-cn"
                ? "env"
                : fromHome && route.provider === "minimax-cn"
                    ? "dsh-home"
                    : "env",
            model: route.model || model,
        };
    }
    return {
        providerId: route.provider,
        ready: false,
        method: "none",
        source: "none",
        model: route.model || catalog?.defaultModel || OPENROUTER_MINIMAX_FREE_MODEL,
    };
}
export function assertNoSecretLeak(text, secrets) {
    for (const secret of secrets) {
        const trimmed = secret.trim();
        if (trimmed.length >= 8 && text.includes(trimmed)) {
            throw new Error("secret leak");
        }
    }
}
//# sourceMappingURL=providers.js.map