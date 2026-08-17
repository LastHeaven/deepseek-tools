// @deepseek-ai/dsh-tool-context7
//
// Native Cordis tool plugin exposing the Context7 documentation tools against
// the hosted Context7 REST API. This is the in-process replacement for the
// `mcp-context7` MCP client entry: it registers the same two model-facing tools
// (resolve-library-id, query-docs) directly through the `tools` registry and
// calls the Context7 REST API with `fetch`, so no child process and no MCP
// JSON-RPC layer are needed.
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

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-context7";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;

/** Context7 REST API base url. */
const API_BASE_URL = "https://context7.com/api";

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default(API_BASE_URL),
  apiKey: z.string().default(""),
  resolveLibraryId: z.boolean().default(true),
  queryDocs: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-context7: ${label} must be a positive integer`);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  return String(config.apiUrl || API_BASE_URL).replace(/\/+$/, "");
}

function makeHeaders(config) {
  const headers = { "X-Context7-Source": "dsh-tool-context7" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function getJson(config, path, signal) {
  const res = await fetch(baseUrl(config) + path, { method: "GET", headers: makeHeaders(config), signal });
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
// Tool factories
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

function applyResolveLibraryIdTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:context7_resolve_library_id",
    order: 117,
    text: "Use the context7_resolve_library_id tool to map a library or product name to a Context7-compatible library ID before querying docs, unless the user already gave an ID in /org/project or /org/project/version form. Pick the match with the best name/reputation/snippet coverage, and do not call it more than 3 times per question."
  });
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
      const res = await getJson(config, `/v2/libs/search?${params.toString()}`, exec.signal);
      const data = await res.json();
      return truncate(formatSearch(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.libraryName, kind: "context7-resolve", rawInput: args.libraryName })
  }));
}

function applyQueryDocsTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:context7_query_docs",
    order: 118,
    text: "Use the context7_query_docs tool to fetch up-to-date, version-specific documentation and code examples for a library. Call context7_resolve_library_id first to get the exact ID, unless the user gave one. Keep each query to one concept, and do not call it more than 3 times per question."
  });
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
      const res = await getJson(config, `/v2/context?${params.toString()}`, exec.signal);
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

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);

  if (config.resolveLibraryId) applyResolveLibraryIdTool(ctx, config);
  if (config.queryDocs) applyQueryDocsTool(ctx, config);
}

export { Config, DEFAULT_TIMEOUT_MS, apply, inject, name };
