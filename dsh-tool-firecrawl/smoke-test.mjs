// Smoke test for the installed dsh-tool-firecrawl plugin.
// Imports the installed copy by absolute path, drives apply() with a fake ctx,
// and runs each tool's execute() against the live firecrawl.localhost instance.
const PLUGIN = "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-firecrawl/lib/index.js";
const { apply, name, inject } = await import(PLUGIN);

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
};

const config = {
  apiUrl: "http://firecrawl.localhost",
  apiKey: "",
  scrape: true, search: true, developerSearch: true, map: true, parse: true, crawl: true, checkCrawlStatus: true,
  timeoutMs: 60000, searchMaxResults: 3, mapMaxResults: 10, crawlMaxResults: 3, maxOutputChars: 200000,
};

apply(ctx, config);
console.log("plugin name:", name, "| inject:", JSON.stringify(inject));
console.log("registered tools:", registered.map((t) => t.name).join(", "));

const signal = AbortSignal.timeout(30000);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

async function run(label, toolName, args) {
  const def = byName[toolName];
  if (!def) { console.log(`FAIL ${label}: ${toolName} not registered`); return; }
  try {
    const out = await def.execute(args, { signal });
    console.log(`\n=== ${label} OK ===`);
    console.log(String(out).slice(0, 700));
  } catch (e) {
    console.log(`\n=== ${label} FAIL: ${e.message} ===`);
  }
}

await run("scrape", "firecrawl_scrape", { url: "https://example.com" });
await run("search", "firecrawl_search", { query: "firecrawl self-hosted", limit: 3 });
await run("developer_search", "firecrawl_developer_search", { query: "react hooks", k: 3 });
await run("map", "firecrawl_map", { url: "https://example.com", limit: 5 });

// crawl -> id -> check status
try {
  const crawlDef = byName["firecrawl_crawl"];
  const started = await crawlDef.execute({ url: "https://example.com", limit: 2 }, { signal });
  console.log("\n=== crawl OK ===");
  console.log(String(started).slice(0, 400));
  const m = String(started).match(/Job id:\s*([0-9a-f-]+)/i);
  if (m) {
    await run("check_crawl_status", "firecrawl_check_crawl_status", { id: m[1] });
  } else {
    console.log("(no crawl id parsed; skipping status check)");
  }
} catch (e) {
  console.log("\n=== crawl FAIL:", e.message, "===");
}

// parse: write a supported .html file, then parse it
import { writeFile, unlink } from "node:fs/promises";
const htmlPath = "C:/Users/hxy/.dsh/profiles/web/_smoke-parse.html";
await writeFile(htmlPath, "<html><head><title>Smoke</title></head><body><h1>Hello</h1><p>Firecrawl parse smoke test.</p></body></html>");
await run("parse", "firecrawl_parse", { filePath: htmlPath });
await unlink(htmlPath).catch(() => {});
