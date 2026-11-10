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
 * `apiUrl` mirrors the bundled patch rather than being schema-required: the
 * bundle has to stay mountable with a placeholder, and the loud failure for a
 * blanked URL lives in `apply()` where it names the fix. See the README.
 */
const Config = z.object({
  apiUrl: z.string().default(API_BASE_URL),
  apiKey: z.string().default(""),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
  resolveLibraryId: z.boolean().default(true),
  queryDocs: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-context7: ${label} must be a positive integer`);
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
  // value — a plausible hand-edit. Fail with the fix instead of fetching
  // "undefined/v2/libs/search".
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

function applyResolveLibraryIdTool(ctx, config) {
  promptSection(ctx, "tool:context7_resolve_library_id",
    "Use the context7_resolve_library_id tool to map a library or product name to a Context7-compatible library ID before querying docs, unless the user already gave an ID in /org/project or /org/project/version form. Pick the match with the best name/reputation/snippet coverage, and do not call it more than 3 times per question.");
  ctx.tools.register(defineTool({
    name: "context7_resolve_library_id",
    description: "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries. Call this before context7_query_docs unless the user explicitly provides a library ID in the format '/org/project' or '/org/project/version'. Each result includes the library ID, name, description, code-snippet count, source reputation, benchmark score, and available versions.",
    parameters: {
      query: { type: "string", required: true, description: "What to look up in the library's documentation; used to rank results by relevance. Avoid secrets or credentials." },
      libraryName: { type: "string", required: true, description: "Library name to search for, with proper punctuation (e.g. 'Next.js' not 'nextjs', 'Customer.io' not 'customerio')." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const params = new URLSearchParams({ query: args.query, libraryName: args.libraryName });
      const res = await getJson(ctx, config, `/v2/libs/search?${params.toString()}`, exec.signal);
      const data = await res.json();
      return truncate(formatSearch(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.libraryName, kind: "context7-resolve", rawInput: args.libraryName })
  }));
}

function applyQueryDocsTool(ctx, config) {
  promptSection(ctx, "tool:context7_query_docs",
    "Use the context7_query_docs tool to fetch up-to-date, version-specific documentation and code examples for a library. Call context7_resolve_library_id first to get the exact ID, unless the user gave one. Keep each query to one concept, and do not call it more than 3 times per question.");
  ctx.tools.register(defineTool({
    name: "context7_query_docs",
    description: "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework. Requires an exact Context7-compatible library ID (e.g. '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') from context7_resolve_library_id or the user. Scope the query to a single concept.",
    parameters: {
      libraryId: { type: "string", required: true, description: "Exact Context7-compatible library ID (e.g. '/mongodb/docs', '/vercel/next.js/v14.3.0-canary.87')." },
      query: { type: "string", required: true, description: "What to look up, scoped to one concept (e.g. 'How to set up authentication with JWT in Express.js'). Avoid secrets or credentials." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const params = new URLSearchParams({ query: args.query, libraryId: args.libraryId });
      const res = await getJson(ctx, config, `/v2/context?${params.toString()}`, exec.signal);
      const text = await res.text();
      if (!text) {
        return "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid Context7-compatible library ID, use context7_resolve_library_id with the package name you wish to retrieve documentation for.";
      }
      return truncate(text, config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.libraryId, kind: "context7-docs", rawInput: args.libraryId })
  }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the enabled Context7 tools.
 *
 * Registration is effect-based: disposing this plugin's fiber (turning the row
 * off on the Plugins page, `disabled: true`, or HMR replacing it) unregisters
 * every tool and prompt section, so no manual teardown is needed and no stale
 * tool declaration survives into the next request.
 */
function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);

  // Validate the URL at mount, not at the first model call: a blanked
  // deployment must fail where the fix is obvious (startup log) instead of
  // surfacing as a confusing tool error mid-conversation.
  baseUrl(config);

  if (config.resolveLibraryId) applyResolveLibraryIdTool(ctx, config);
  if (config.queryDocs) applyQueryDocsTool(ctx, config);
}

export { API_BASE_URL, Config, DEFAULT_API_KEY_ENV, DEFAULT_TIMEOUT_MS, TOOL_WEB_FETCH_ORDER, apply, inject, name };
