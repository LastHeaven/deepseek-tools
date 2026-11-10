// @deepseek-ai/dsh-tool-context7
//
// Native Cordis tool plugin exposing the Context7 documentation tools against
// the hosted Context7 REST API. It registers the two model-facing tools
// (resolve-library-id, query-docs) in-process through the `tools` registry and
// calls the Context7 REST API with the built-in `fetch`, so there is no MCP
// server, no stdio bridge, no child process and no client dependency. It is the
// in-process replacement for the older `mcp-context7` MCP client entry.
//
// This package ships as a bundle: `package.json` declares `dsh.bundle.patch`
// and the bundled `cordis.patch.yml` mounts the single `tool-context7` row, so
// `dsh plugin --profile <name> add <this package>` installs and activates it in
// one step. Everything registered here is fiber-scoped, so the profile's
// Plugins page (or a `disabled: true` override row) unloads it cleanly.
//
// The same package also ships a browser half (`lib/client.js`) that registers
// this row's configuration page on the Plugins page, so the parameters below are
// edited in the UI instead of by hand in `cordis.patch.yml`.
//
// Verified REST endpoints (base url https://context7.com/api):
//   GET /v2/libs/search?query=<q>&libraryName=<name>   -> library search
//   GET /v2/context?query=<q>&libraryId=<id>            -> docs for a library
//
// The hosted server accepts the API key as either
// `Authorization: Bearer <key>` or the `X-Context7-API-Key` header. An unset
// key still works on the anonymous tier (lower rate limits).
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics and the Plugins page. */
const name = "tool-context7";
/** Services required by the tool suite. Both are effect-scoped registries. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;
/** Default credential reference resolved through the credential seam. */
const DEFAULT_API_KEY_ENV = "CONTEXT7_API_KEY";
/** Context7 REST API base url. A deployment overrides it in its patch. */
const API_BASE_URL = "https://context7.com/api";
/** Fallback order for the `TOOL_WEB_FETCH` slot, used when the registry has no accessor. */
const TOOL_WEB_FETCH_ORDER = 2100;

/**
 * Plugin config, resolved by the loader (schemastery defaults applied).
 *
 * Every field the Plugins page edits is `.volatile()`. That is what makes the
 * page work at all: the settings service projects only volatile fields into a
 * form, and the loader hands a volatile field to `apply()` as a live reference
 * instead of a snapshot. The page writes through the profile's config editor,
 * the reference is updated in place, and the next tool call reads the new value
 * without restarting the plugin.
 *
 * Two fields stay ordinary, and so appear in `cordis.patch.yml` only:
 *
 * - `apiKey` is the patch-file escape hatch for a deployment with no credential
 *   store. Keeping it out of the volatile projection keeps a literal secret off
 *   the configuration wire entirely; the page edits `apiKeyEnv` and writes the
 *   secret itself through the credential store.
 *
 * `timeoutMs` IS volatile, but it needs more than the marker. `defineTool` copies
 * the number it is handed, so a plain field would freeze at mount; the timeout
 * policy reads `definition.timeoutMs` on every dispatch, so `withLiveTimeout()`
 * installs a getter over the live reference instead. See its doc comment.
 *
 * `apiUrl` mirrors the bundled patch rather than being schema-required: the
 * bundle has to stay mountable with a placeholder, and the loud failure for a
 * blanked URL lives in `apply()` and in every call where it names the fix. See
 * the README.
 */
const Config = z.object({
  apiUrl: z.string().default(API_BASE_URL).volatile(),
  apiKey: z.string().default(""),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile(),
  resolveLibraryId: z.boolean().default(true).volatile(),
  queryDocs: z.boolean().default(true).volatile(),
  timeoutMs: z.number().step(1).min(1).max(2147483647).default(DEFAULT_TIMEOUT_MS).volatile(),
  maxOutputChars: z.number().step(1).min(1).default(200000).volatile()
});

/**
 * Read one config value through its live reference.
 *
 * A `.volatile()` field arrives as `{ get() }` and an ordinary field as the
 * value itself, so every read goes through here. Reading on use — instead of
 * capturing a plain object once in `apply()` — is what makes a page edit reach
 * the very next call.
 */
function unwrap(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

/** Flatten the config, volatile or not, into the plain values used per request. */
function readConfig(config) {
  return {
    apiUrl: unwrap(config.apiUrl),
    apiKey: unwrap(config.apiKey),
    apiKeyEnv: unwrap(config.apiKeyEnv),
    resolveLibraryId: unwrap(config.resolveLibraryId),
    queryDocs: unwrap(config.queryDocs),
    timeoutMs: unwrap(config.timeoutMs),
    maxOutputChars: unwrap(config.maxOutputChars)
  };
}

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-context7: ${label} must be a positive integer`);
}

/** Largest delay `setTimeout` accepts; `deadline()` rejects anything above it. */
const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Read the per-call budget, falling back to the default for an unusable value.
 *
 * `deadline()` throws on a non-positive or non-finite timeout, and that throw
 * lands inside the tool-call wrapper: one bad number would fail *every* tool call
 * rather than one. The schema's `min(1)` and the loader's re-validation make this
 * unreachable through the configuration page, so it is a guard for a hand-written
 * patch or an expression, not the normal path.
 */
function timeoutOf(config) {
  const value = readConfig(config).timeoutMs;
  if (Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS) return value;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Make one tool definition's `timeoutMs` track the live config reference.
 *
 * `defineTool` copies the number it is handed into the definition
 * (`dsh-tools/lib/index.js`), so a plain field freezes at mount. It does not
 * freeze the *definition* — `Object.isFrozen()` is false — and the enforcement
 * site, `dsh-tool-call-timeout-policy`, reads `definition.timeoutMs` on every
 * dispatch:
 *
 *   const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
 *
 * So redefining the property as a getter over the volatile reference is what
 * makes a page edit arm the next call's deadline, with no rebuild and no second
 * source of truth. `dsh-tools` also validates the definition at registration
 * (a positive finite number), which the getter satisfies by construction.
 */
function withLiveTimeout(definition, config) {
  assertPositiveInteger("timeoutMs", readConfig(config).timeoutMs);
  Object.defineProperty(definition, "timeoutMs", {
    configurable: true,
    enumerable: true,
    get: () => timeoutOf(config)
  });
  return definition;
}

// ---------------------------------------------------------------------------
// Auth: literal config key, else the credential store, else the environment
// ---------------------------------------------------------------------------

/**
 * Resolve the API key for one request.
 *
 * `ctx.credentials` is the harness credential seam. It is a soft dependency on
 * purpose: a composition without the store must still work off a config literal
 * or the process environment, so this uses `ctx.get` instead of `inject`.
 *
 * Deliberately NOT memoised: the store keeps an in-memory snapshot that its own
 * watcher refreshes, so a per-call read costs nothing and is what makes a
 * rotated key reach the very next call without a restart.
 *
 * The anonymous tier needs no key at all, so a missing key is not an error here
 * — it simply omits the `Authorization` header.
 */
async function resolveApiKey(ctx, config) {
  if (config.apiKey) return config.apiKey;
  const ref = String(config.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(ref);
      if (hit && hit.value) return hit.value;
    } catch {
      /* a malformed reference must not fail the plugin; fall through */
    }
  }
  const fromEnv = process.env[ref];
  return fromEnv || "";
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  const raw = String(config.apiUrl ?? "").trim();
  // `apiUrl` carries a default, so this only fires for an explicitly blanked
  // value — a plausible hand-edit or a cleared page field. Fail with the fix
  // instead of fetching "undefined/v2/libs/search".
  if (!raw) {
    throw new Error(
      "tool-context7: `apiUrl` is empty. Set it to the Context7 API base URL, e.g. https://context7.com/api."
    );
  }
  return raw.replace(/\/+$/, "");
}

async function makeHeaders(ctx, config) {
  const headers = { "X-Context7-Source": "dsh-tool-context7" };
  const key = await resolveApiKey(ctx, config);
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function getJson(ctx, config, path, signal) {
  const res = await fetch(baseUrl(config) + path, { method: "GET", headers: await makeHeaders(ctx, config), signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json && json.message) detail = String(json.message);
    } catch { /* keep status fallback */ }
    if (res.status === 429) {
      detail = config.apiKey
        ? "Rate limited or quota exceeded. Upgrade your plan at https://context7.com/plans for higher limits."
        : "Rate limited or quota exceeded. Create a free API key at https://context7.com/dashboard for higher limits.";
    } else if (res.status === 404) {
      detail = "The library you are trying to access does not exist. Please try with a different library ID.";
    } else if (res.status === 401) {
      detail = "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.";
    }
    throw new Error(`context7 GET ${path} failed (${detail})`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Formatters (model-facing text)
// ---------------------------------------------------------------------------

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
}

/** Validate the per-call output budget, which the page can change at any time. */
function outputBudget(config) {
  const max = config.maxOutputChars;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("tool-context7: `maxOutputChars` must be a positive integer. Set it on the plugin's configuration page.");
  }
  return max;
}

function formatSearch(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return data?.error || "No libraries found matching the provided name.";
  const lines = results.map((r) => {
    const id = r.id || "";
    const snippetCount = r.snippets != null ? r.snippets : r.codeSnippets;
    const rep = r.reputation || r.sourceReputation || "";
    const bench = r.benchmark != null ? r.benchmark : r.benchmarkScore;
    const versions = Array.isArray(r.versions) && r.versions.length ? ` (versions: ${r.versions.join(", ")})` : "";
    const bits = [];
    if (snippetCount != null) bits.push(`${snippetCount} snippets`);
    if (rep) bits.push(`reputation: ${rep}`);
    if (bench != null) bits.push(`benchmark: ${bench}`);
    const meta = bits.length ? ` [${bits.join(", ")}]` : "";
    return `- ${id} — ${r.description || ""}${meta}${versions}`;
  });
  return `Available Libraries:\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Prompt sections
// ---------------------------------------------------------------------------

/**
 * Register one guidance section in the harness's own tool-section scale.
 *
 * Both tools sit in the documentation-lookup family, right after web fetch, so
 * they inherit that slot's order instead of a hard-coded number: the lookup is
 * tolerant of a composition whose prompt service has no accessor, and falls
 * back to the numeric slot the harness reserves for it.
 *
 * `text` is a function so a tool switched off on the configuration page also
 * withdraws its guidance: an empty string is dropped by assembly.
 */
function promptSection(ctx, sectionName, text) {
  const source = ctx.systemPrompt;
  let order = TOOL_WEB_FETCH_ORDER;
  if (source !== undefined && typeof source.getSectionOrder === "function") {
    try {
      order = source.getSectionOrder("TOOL_WEB_FETCH");
    } catch {
      order = TOOL_WEB_FETCH_ORDER;
    }
  }
  ctx.systemPrompt.section({ name: sectionName, order, text });
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

/**
 * One tool's step-time switch.
 *
 * The page can toggle a tool without remounting the plugin, so the decision is
 * an activation condition the executor evaluates per step rather than a branch
 * in `apply()`: `when` false removes the tool from both the declaration list
 * and dispatch.
 */
function enabledWhen(config, field) {
  return () => readConfig(config)[field] !== false;
}

function applyResolveLibraryIdTool(ctx, config) {
  promptSection(ctx, "tool:context7_resolve_library_id",
    () => (readConfig(config).resolveLibraryId === false ? "" :
      "Use the context7_resolve_library_id tool to map a library or product name to a Context7-compatible library ID before querying docs, unless the user already gave an ID in /org/project or /org/project/version form. Pick the match with the best name/reputation/snippet coverage, and do not call it more than 3 times per question."));
  ctx.tools.register(withLiveTimeout(defineTool({
    name: "context7_resolve_library_id",
    description: "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries. Call this before context7_query_docs unless the user explicitly provides a library ID in the format '/org/project' or '/org/project/version'. Each result includes the library ID, name, description, code-snippet count, source reputation, benchmark score, and available versions.",
    parameters: {
      query: { type: "string", required: true, description: "What to look up in the library's documentation; used to rank results by relevance. Avoid secrets or credentials." },
      libraryName: { type: "string", required: true, description: "Library name to search for, with proper punctuation (e.g. 'Next.js' not 'nextjs', 'Customer.io' not 'customerio')." }
    },
    output: stringOutput(),
    timeoutMs: readConfig(config).timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = readConfig(config);
      const params = new URLSearchParams({ query: args.query, libraryName: args.libraryName });
      const res = await getJson(ctx, settings, `/v2/libs/search?${params.toString()}`, exec.signal);
      const data = await res.json();
      return truncate(formatSearch(data), outputBudget(settings));
    },
    presentCall: (args) => ({ card: "generic", title: args.libraryName, kind: "context7-resolve", rawInput: args.libraryName })
  }), config), { when: enabledWhen(config, "resolveLibraryId") });
}

function applyQueryDocsTool(ctx, config) {
  promptSection(ctx, "tool:context7_query_docs",
    () => (readConfig(config).queryDocs === false ? "" :
      "Use the context7_query_docs tool to fetch up-to-date, version-specific documentation and code examples for a library. Call context7_resolve_library_id first to get the exact ID, unless the user gave one. Keep each query to one concept, and do not call it more than 3 times per question."));
  ctx.tools.register(withLiveTimeout(defineTool({
    name: "context7_query_docs",
    description: "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework. Requires an exact Context7-compatible library ID (e.g. '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') from context7_resolve_library_id or the user. Scope the query to a single concept.",
    parameters: {
      libraryId: { type: "string", required: true, description: "Exact Context7-compatible library ID (e.g. '/mongodb/docs', '/vercel/next.js/v14.3.0-canary.87')." },
      query: { type: "string", required: true, description: "What to look up, scoped to one concept (e.g. 'How to set up authentication with JWT in Express.js'). Avoid secrets or credentials." }
    },
    output: stringOutput(),
    timeoutMs: readConfig(config).timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = readConfig(config);
      const params = new URLSearchParams({ query: args.query, libraryId: args.libraryId });
      const res = await getJson(ctx, settings, `/v2/context?${params.toString()}`, exec.signal);
      const text = await res.text();
      if (!text) {
        return "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid Context7-compatible library ID, use context7_resolve_library_id with the package name you wish to retrieve documentation for.";
      }
      return truncate(text, outputBudget(settings));
    },
    presentCall: (args) => ({ card: "generic", title: args.libraryId, kind: "context7-docs", rawInput: args.libraryId })
  }), config), { when: enabledWhen(config, "queryDocs") });
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the Context7 tools.
 *
 * Registration is effect-based: disposing this plugin's fiber (turning the row
 * off on the Plugins page, `disabled: true`, or HMR replacing it) unregisters
 * every tool and prompt section, so no manual teardown is needed and no stale
 * tool declaration survives into the next request.
 *
 * Both tools are always registered; the per-tool switches are step-time `when`
 * conditions, and their prompt text is resolved per assembly. A page edit
 * therefore takes effect on the next request instead of waiting for a reload.
 * The per-call budget follows the same rule through `withLiveTimeout()`, so
 * changing it on the page arms the very next call's deadline.
 */
function apply(ctx, config) {
  const initial = readConfig(config);
  // Validate at mount as well: a broken value in a hand-written patch should fail
  // where the loader prints it, not silently fall back on every call.
  assertPositiveInteger("timeoutMs", initial.timeoutMs);

  // Validate the URL at mount, not at the first model call: a blanked
  // deployment must fail where the fix is obvious (startup log) instead of
  // surfacing as a confusing tool error mid-conversation. A page edit that
  // blanks it is caught per call by `baseUrl`.
  baseUrl(initial);

  // Validated at its point of use instead: a snapshot checked once would go stale
  // on the first page edit.
  void outputBudget(initial);

  applyResolveLibraryIdTool(ctx, config);
  applyQueryDocsTool(ctx, config);
}

export {
  API_BASE_URL,
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  TOOL_WEB_FETCH_ORDER,
  apply,
  inject,
  name,
  withLiveTimeout
};
