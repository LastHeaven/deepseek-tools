// @deepseek-ai/dsh-tool-firecrawl
//
// Native Cordis tool plugin exposing the Firecrawl tools against a self-hosted
// Firecrawl instance (default http://firecrawl.localhost, no auth). This is the
// in-process replacement for the `firecrawl-mcp` + `firecrawl-filter.mjs`
// stdio proxy: it registers the same seven model-facing tools directly through
// the `tools` registry and calls the Firecrawl REST API with `fetch`, so no
// child process, no MCP JSON-RPC layer, and no `@mendable/firecrawl-js` SDK
// dependency are needed.
//
// Verified endpoints for a self-hosted instance:
//   POST /v1/scrape            scrape one URL
//   POST /v2/search            web search (returns data.web)
//   POST /v1/map               enumerate a site's URLs
//   POST /v1/crawl             start a crawl -> { id }
//   GET  /v1/crawl/{id}        crawl status/progress
//   POST /v2/parse             parse a local file (multipart)
//   GET  /v2/search/developer  developer-index search (cloud only; falls back
//                              to /v2/search?categories=developer on 404)
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-firecrawl";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default("http://firecrawl.localhost"),
  apiKey: z.string().default(""),
  scrape: z.boolean().default(true),
  search: z.boolean().default(true),
  developerSearch: z.boolean().default(true),
  map: z.boolean().default(true),
  parse: z.boolean().default(true),
  crawl: z.boolean().default(true),
  checkCrawlStatus: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  searchMaxResults: z.number().default(8),
  mapMaxResults: z.number().default(100),
  crawlMaxResults: z.number().default(50),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-firecrawl: ${label} must be a positive integer`);
}

/** Scrape `formats` values the model may request. */
const SCRAPE_FORMATS = ["markdown", "html", "rawHtml", "links", "screenshot", "summary", "changeTracking", "branding", "json", "query"];
/** Search source-type categories the model may request. */
const SEARCH_CATEGORIES = ["github", "research", "pdf", "developer"];
/** Search source groups the model may request. */
const SEARCH_SOURCES = ["web", "images", "news"];
/** Parse output formats. */
const PARSE_FORMATS = ["markdown", "html", "rawHtml", "links", "summary", "json", "query"];

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  return String(config.apiUrl || "http://firecrawl.localhost").replace(/\/+$/, "");
}

function makeHeaders(config, extra) {
  const headers = { ...(extra || {}) };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/** Strip absent/empty top-level fields so Firecrawl defaults apply. */
function removeEmptyTopLevel(value) {
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === null) continue;
    if (typeof val === "string" && val.length === 0) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    out[key] = val;
  }
  return out;
}

async function requestJson(config, method, path, body, signal) {
  const init = { method, headers: makeHeaders(config), signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl(config) + path, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === "object" && data !== null ? (data.error || data.message || text) : text;
    throw new Error(`firecrawl ${method} ${path} failed (HTTP ${res.status}): ${String(detail).slice(0, 500)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Formatters (model-facing text)
// ---------------------------------------------------------------------------

function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) : s;
}

function formatScrape(data, url) {
  const d = data && data.data !== undefined ? data.data : (data || {});
  const parts = [];
  const meta = d.metadata || {};
  const title = meta.title || url;
  parts.push(`Scraped ${url}${title ? ` — ${title}` : ""}`);
  if (d.markdown != null && d.markdown !== "") parts.push(d.markdown);
  else if (d.html != null && d.html !== "") parts.push(d.html);
  else if (d.rawHtml != null && d.rawHtml !== "") parts.push(d.rawHtml);
  else if (d.extract != null) parts.push("Extracted JSON:\n" + JSON.stringify(d.extract, null, 2));
  else if (d.llm_extraction != null) parts.push("Extracted JSON:\n" + JSON.stringify(d.llm_extraction, null, 2));
  if (Array.isArray(d.links) && d.links.length) parts.push("Links:\n" + d.links.map((l) => `- ${l}`).join("\n"));
  if (typeof d.summary === "string" && d.summary) parts.push("Summary: " + d.summary);
  if (meta.statusCode != null) parts.push(`(HTTP ${meta.statusCode})`);
  return parts.join("\n\n");
}

function formatSearch(data) {
  const d = data && data.data !== undefined ? data.data : (data || {});
  const web = Array.isArray(d) ? d : (Array.isArray(d.web) ? d.web : []);
  const lines = [];
  for (const r of web) {
    const label = r.title || r.url || r.description || "";
    lines.push(`- [${label}](${r.url})` + (r.description ? ` — ${r.description}` : ""));
  }
  if (!lines.length) return "No results found.";
  return `Search results (${lines.length}):\n${lines.join("\n")}\n\nCite the relevant URLs above as markdown links in your answer.`;
}

function formatDeveloper(data) {
  const d = data || {};
  const results = Array.isArray(d.results) ? d.results : (Array.isArray(d.data?.results) ? d.data.results : []);
  if (!results.length) return "No developer results found.";
  const lines = results.map((r) => {
    const kind = r.type || r.sourceType || r.kind;
    return `- [${r.title || r.id || "result"}](${r.url || ""})${kind ? ` (${kind})` : ""}\n  ${(r.passages || []).map((p) => p.text || p.snippet || "").join(" ").slice(0, 400)}`;
  });
  return `Developer results (${results.length}):\n${lines.join("\n")}`;
}

function formatMap(data, url) {
  const links = Array.isArray(data) ? data : (Array.isArray(data?.links) ? data.links : Array.isArray(data?.data) ? data.data : []);
  if (!links.length) return `No URLs mapped under ${url}.`;
  return `Mapped URLs under ${url} (${links.length}):\n${links.map((l) => `- ${l}`).join("\n")}`;
}

function formatCrawlStarted(data, url) {
  const d = data || {};
  const id = d.id || d.jobId;
  if (!id) return `Crawl started for ${url} but no job id was returned: ${JSON.stringify(d)}`;
  return `Crawl started for ${url}.\nJob id: ${id}\nCheck progress with firecrawl_check_crawl_status using this id.`;
}

function formatCrawlStatus(data) {
  const d = data || {};
  const status = d.status || "unknown";
  const completed = d.completed ?? "?";
  const total = d.total ?? "?";
  const pages = Array.isArray(d.data) ? d.data : [];
  const parts = [`Crawl status: ${status} (${completed}/${total} pages)`];
  for (const page of pages) {
    const md = page.markdown || page.html || page.rawHtml || "";
    if (md) parts.push(`- ${page.metadata?.url || "(page)"}\n\n${clip(md, 2000)}`);
    else parts.push(`- ${page.metadata?.url || "(page)"}`);
  }
  return parts.join("\n\n");
}

function formatParse(data) {
  const d = data && data.data !== undefined ? data.data : (data || {});
  const parts = [];
  if (d.markdown != null && d.markdown !== "") parts.push(d.markdown);
  else if (d.html != null && d.html !== "") parts.push(d.html);
  else if (d.rawHtml != null && d.rawHtml !== "") parts.push(d.rawHtml);
  if (typeof d.summary === "string" && d.summary) parts.push("Summary: " + d.summary);
  if (Array.isArray(d.links) && d.links.length) parts.push("Links:\n" + d.links.map((l) => `- ${l}`).join("\n"));
  if (!parts.length) parts.push(JSON.stringify(d, null, 2));
  return parts.join("\n\n");
}

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
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

function applyScrapeTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:firecrawl_scrape",
    order: 115,
    text: "Use the firecrawl_scrape tool to retrieve the content of a specific URL through Firecrawl (a known page only). Use firecrawl_map or firecrawl_search to discover URLs, and firecrawl_crawl to collect many pages."
  });
  ctx.tools.register(defineTool({
    name: "firecrawl_scrape",
    description: "Retrieve and extract content from one supplied URL through Firecrawl. Use this when a specific page is identified and needs its content or defined fields. Returns markdown (default), HTML, links, a screenshot, or JSON matching a supplied schema. Set maxAge: 0 to force a live fetch.",
    parameters: {
      url: { type: "string", required: true, description: "The URL to scrape." },
      formats: { type: "array", items: { type: "string", enum: SCRAPE_FORMATS }, description: "Content formats to return (default markdown)." },
      onlyMainContent: { type: "boolean", description: "Return only the page's main content." },
      waitFor: { type: "number", description: "Milliseconds to wait for JavaScript to render before scraping." },
      maxAge: { type: "number", description: "Maximum cache age in ms; 0 forces a live fetch." },
      mobile: { type: "boolean", description: "Use a mobile viewport." },
      includeTags: { type: "array", items: { type: "string" }, description: "CSS selectors to include." },
      excludeTags: { type: "array", items: { type: "string" }, description: "CSS selectors to exclude." },
      removeBase64Images: { type: "boolean", description: "Remove base64 image data from the result." },
      skipTlsVerification: { type: "boolean", description: "Skip TLS certificate verification." },
      jsonOptions: { type: "object", additionalProperties: false, properties: { prompt: { type: "string" }, schema: { type: "json" } }, description: "Prompt and schema for JSON extraction (used with formats: [\"json\"])." },
      location: { type: "object", additionalProperties: false, properties: { country: { type: "string" }, languages: { type: "array", items: { type: "string" } } }, description: "Geographic location for the request." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { url, ...options } = args;
      const data = await requestJson(config, "POST", "/v1/scrape", removeEmptyTopLevel({ url, ...options }), exec.signal);
      return truncate(formatScrape(data, url), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "scrape", rawInput: args.url })
  }));
}

function applySearchTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:firecrawl_search",
    order: 116,
    text: "Use the firecrawl_search tool to discover current information on the web through Firecrawl. It returns ranked results; cite the relevant URLs as markdown links. For a programming question, add categories: [\"developer\"]."
  });
  ctx.tools.register(defineTool({
    name: "firecrawl_search",
    description: "Search the web through Firecrawl and return ranked results. Operators include quoted phrases, -term, site:host, inurl:term, and intitle:term. includeDomains and excludeDomains are mutually exclusive hostname filters; categories and sources limit result types.",
    parameters: {
      query: { type: "string", required: true, description: "The search query." },
      limit: { type: "number", description: `Maximum number of results to return (default ${config.searchMaxResults}).` },
      categories: { type: "array", items: { type: "string", enum: SEARCH_CATEGORIES }, description: "Limit results to GitHub, research, PDF, or developer sources." },
      sources: { type: "array", items: { type: "string", enum: SEARCH_SOURCES }, description: "Result source groups: web, images, or news." },
      includeDomains: { type: "array", items: { type: "string" }, description: "Only results from these hostnames." },
      excludeDomains: { type: "array", items: { type: "string" }, description: "Exclude results from these hostnames." },
      location: { type: "string", description: "Geographic region for results." },
      tbs: { type: "string", description: "Time-based search qualifier." },
      filter: { type: "string", description: "Result filter expression." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { query, limit, ...options } = args;
      if (args.includeDomains && args.excludeDomains && args.includeDomains.length && args.excludeDomains.length) {
        throw new Error("includeDomains and excludeDomains are mutually exclusive");
      }
      const data = await requestJson(config, "POST", "/v2/search", removeEmptyTopLevel({ query, limit: limit ?? config.searchMaxResults, ...options }), exec.signal);
      return truncate(formatSearch(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.query, kind: "search", rawInput: args.query })
  }));
}

function applyDeveloperSearchTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "firecrawl_developer_search",
    description: "For a developer question — code behaviour, a library or framework, an API contract, an error message, or a known bug — search an index built for coding agents (GitHub issues, merged pull requests, repository READMEs, curated documentation). Set skills to \"only\" to search agent-skill files. On self-hosted instances without the developer index this degrades to a developer-category web search.",
    parameters: {
      query: { type: "string", required: true, description: "Natural-language developer question or search phrase." },
      k: { type: "number", description: "Number of ranked results to return (default 10)." },
      skills: { type: "string", enum: ["only"], description: "Set to \"only\" to search only agent-skill files." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const params = new URLSearchParams({ query: args.query });
      if (args.k != null) params.append("k", String(args.k));
      if (args.skills != null) params.append("skills", args.skills);
      let data;
      try {
        data = await requestJson(config, "GET", `/v2/search/developer?${params.toString()}`, undefined, exec.signal);
      } catch (error) {
        // Self-hosted instances lack the developer index; degrade to a search.
        if (String(error.message).includes("404")) {
          data = await requestJson(config, "POST", "/v2/search", { query: args.query, limit: args.k ?? 10, categories: ["developer"] }, exec.signal);
          return truncate(formatSearch(data), config.maxOutputChars);
        }
        throw error;
      }
      return truncate(formatDeveloper(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.query, kind: "search", rawInput: args.query })
  }));
}

function applyMapTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "firecrawl_map",
    description: "Enumerate URLs indexed under one website through Firecrawl without fetching each page's content. Use it for a site's URL inventory or to locate several relevant pages. Returns matching URLs rather than page bodies.",
    parameters: {
      url: { type: "string", required: true, description: "The website URL to map." },
      search: { type: "string", description: "Optional term to narrow the URL list." },
      sitemap: { type: "string", enum: ["include", "skip", "only"], description: "Sitemap handling." },
      includeSubdomains: { type: "boolean", description: "Include subdomains." },
      limit: { type: "number", description: `Maximum URLs to return (default ${config.mapMaxResults}).` },
      ignoreQueryParameters: { type: "boolean", description: "Ignore query parameters when deduplicating." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { url, limit, ...options } = args;
      const data = await requestJson(config, "POST", "/v1/map", removeEmptyTopLevel({ url, limit: limit ?? config.mapMaxResults, ...options }), exec.signal);
      return truncate(formatMap(data, url), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "map", rawInput: args.url })
  }));
}

function applyParseTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "firecrawl_parse",
    description: "Parse one supported document (HTML, PDF, Word, RTF, OpenDocument, spreadsheet) into markdown, HTML, links, a summary, or JSON. Reads filePath from the local filesystem and uploads it to the self-hosted Firecrawl instance. Remote web URLs belong in firecrawl_scrape.",
    parameters: {
      filePath: { type: "string", required: true, description: "Absolute or relative path to a local file to parse." },
      contentType: { type: "string", description: "Optional MIME type override; inferred from the extension when omitted." },
      formats: { type: "array", items: { type: "string", enum: PARSE_FORMATS }, description: "Output formats (default markdown)." },
      onlyMainContent: { type: "boolean", description: "Return only the main content." },
      includeTags: { type: "array", items: { type: "string" }, description: "CSS selectors to include." },
      excludeTags: { type: "array", items: { type: "string" }, description: "CSS selectors to exclude." },
      redactPII: { type: "boolean", description: "Request PII redaction." },
      pdfOptions: { type: "object", additionalProperties: false, properties: { maxPages: { type: "integer" } }, description: "PDF parsing options." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const absPath = resolvePath(args.filePath);
      const buffer = await readFile(absPath);
      const filename = basename(absPath);
      const contentType = args.contentType || inferContentType(filename);
      const options = removeEmptyTopLevel({
        formats: args.formats,
        onlyMainContent: args.onlyMainContent,
        includeTags: args.includeTags,
        excludeTags: args.excludeTags,
        redactPII: args.redactPII,
        pdfOptions: args.pdfOptions
      });
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
      form.append("options", JSON.stringify(options));
      const res = await fetch(baseUrl(config) + "/v2/parse", {
        method: "POST",
        headers: makeHeaders(config),
        body: form,
        signal: exec.signal
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!res.ok) {
        const detail = typeof data === "object" && data !== null ? (data.error || data.message || text) : text;
        throw new Error(`firecrawl POST /v2/parse failed (HTTP ${res.status}): ${String(detail).slice(0, 500)}`);
      }
      return truncate(formatParse(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.filePath, kind: "parse", rawInput: args.filePath })
  }));
}

function applyCrawlTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "firecrawl_crawl",
    description: "Start a multi-page crawl at a website URL through Firecrawl and return the job id. Poll the job with firecrawl_check_crawl_status until it reaches completed or failed. Scope with include/exclude paths, depth, page limit, and subdomain/external-link controls. Returns the crawl id.",
    parameters: {
      url: { type: "string", required: true, description: "The website URL to crawl." },
      limit: { type: "number", description: `Maximum pages to crawl (default ${config.crawlMaxResults}).` },
      maxDiscoveryDepth: { type: "number", description: "Maximum link depth to discover." },
      includePaths: { type: "array", items: { type: "string" }, description: "Only crawl URLs matching these path patterns." },
      excludePaths: { type: "array", items: { type: "string" }, description: "Skip URLs matching these path patterns." },
      allowSubdomains: { type: "boolean", description: "Crawl subdomains too." },
      allowExternalLinks: { type: "boolean", description: "Follow external links." },
      crawlEntireDomain: { type: "boolean", description: "Crawl the entire domain." },
      ignoreQueryParameters: { type: "boolean", description: "Ignore query parameters when deduplicating." },
      deduplicateSimilarURLs: { type: "boolean", description: "Deduplicate similar URLs." },
      sitemap: { type: "string", enum: ["include", "skip", "only"], description: "Sitemap handling." },
      scrapeOptions: { type: "object", additionalProperties: false, properties: { formats: { type: "array", items: { type: "string", enum: SCRAPE_FORMATS } }, onlyMainContent: { type: "boolean" }, waitFor: { type: "number" } }, description: "Per-page scrape options." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const { url, limit, ...options } = args;
      const data = await requestJson(config, "POST", "/v1/crawl", removeEmptyTopLevel({ url, limit: limit ?? config.crawlMaxResults, ...options }), exec.signal);
      return formatCrawlStarted(data, url);
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "crawl", rawInput: args.url })
  }));
}

function applyCheckCrawlStatusTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "firecrawl_check_crawl_status",
    description: "Retrieve the current status, progress, and available results for an existing crawl id. This only reads Firecrawl job state and does not start or modify the crawl.",
    parameters: {
      id: { type: "string", required: true, description: "The crawl job id returned by firecrawl_crawl." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const data = await requestJson(config, "GET", `/v1/crawl/${encodeURIComponent(args.id)}`, undefined, exec.signal);
      return truncate(formatCrawlStatus(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.id, kind: "crawl", rawInput: args.id })
  }));
}

/** Guess a MIME type from a filename extension. */
function inferContentType(filename) {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  const map = {
    ".html": "text/html",
    ".htm": "text/html",
    ".xhtml": "application/xhtml+xml",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".docm": "application/vnd.ms-word.document.macroEnabled.12",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".rtf": "application/rtf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    ".epub": "application/epub+zip",
    ".csv": "text/csv"
  };
  return map[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("searchMaxResults", config.searchMaxResults);
  assertPositiveInteger("mapMaxResults", config.mapMaxResults);
  assertPositiveInteger("crawlMaxResults", config.crawlMaxResults);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);

  if (config.scrape) applyScrapeTool(ctx, config);
  if (config.search) applySearchTool(ctx, config);
  if (config.developerSearch) applyDeveloperSearchTool(ctx, config);
  if (config.map) applyMapTool(ctx, config);
  if (config.parse) applyParseTool(ctx, config);
  if (config.crawl) applyCrawlTool(ctx, config);
  if (config.checkCrawlStatus) applyCheckCrawlStatusTool(ctx, config);
}

export { Config, DEFAULT_TIMEOUT_MS, apply, inject, name };
