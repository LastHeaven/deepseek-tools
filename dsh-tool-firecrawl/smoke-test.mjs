// Smoke test for @deepseek-ai/dsh-tool-firecrawl.
//
// Drives the plugin WITHOUT the DSH loader: it builds a fake ctx, runs the
// exported Schemastery `Config` over a partial config (the loader's step), calls
// apply(), and then exercises the registered tools against a live Firecrawl
// instance.
//
//   node smoke-test.mjs                       # offline: manifest + schema + wiring
//   FIRECRAWL_FIRECRAWL_LIVE=1 node smoke-test.mjs   # also hit the instance
//   FIRECRAWL_API_URL=… node smoke-test.mjs   # point at another instance
//
// Offline checks need no network and no installed profile: they import THIS
// checkout, which is enough because the peer deps resolve from the DSH
// installation's module fallback. The live section is opt-in so the test is
// usable on a machine without a Firecrawl instance — the reference case for a
// self-hosted plugin, which has no built-in target.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const LIVE = process.env.FIRECRAWL_SMOKE_LIVE === "1";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Bundle packaging: what makes this an installable, toggleable plugin
// ---------------------------------------------------------------------------

check("package declares a bundle patch", manifest.dsh?.bundle?.patch === "./cordis.patch.yml", JSON.stringify(manifest.dsh));
check("manifest version is declared", manifest.dsh?.manifestVersion === 1);
check("files ships the patch layer", (manifest.files ?? []).includes("cordis.patch.yml"));
check("files ships the locale dictionaries", (manifest.files ?? []).includes("locale/*.json"));
check("files ships the icon", (manifest.files ?? []).includes("icon.svg"));
check("package.json names an icon", typeof manifest.icon === "string");
check("exports the patch layer", manifest.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml");
check("exports the locales", manifest.exports?.["./locale/*.json"] === "./locale/*.json");
check("exports the icon", manifest.exports?.["./icon"] === "./icon.svg");
check("declares engines.dsh", typeof manifest.engines?.dsh === "string", JSON.stringify(manifest.engines));

for (const language of ["en", "zh"]) {
  const file = join(HERE, "locale", `${language}.json`);
  check(`locale/${language}.json exists`, existsSync(file));
  if (!existsSync(file)) continue;
  const meta = JSON.parse(readFileSync(file, "utf8")).meta ?? {};
  check(`locale/${language}.json has meta.title`, typeof meta.title === "string" && meta.title.trim() !== "");
  check(`locale/${language}.json has meta.description`, typeof meta.description === "string" && meta.description.trim() !== "");
}

const patch = readFileSync(join(HERE, "cordis.patch.yml"), "utf8");
check("patch mounts tool-firecrawl by package name", /name:\s*'@deepseek-ai\/dsh-tool-firecrawl'/.test(patch));
check("patch sets an id", /id:\s*tool-firecrawl/.test(patch));

// ---------------------------------------------------------------------------
// 2. Plugin contract
// ---------------------------------------------------------------------------

// The `@deepseek-ai/*` peers are NOT installed in this checkout: they resolve
// from a DSH profile (or the installation's own module fallback). Default to the
// INSTALLED bundle, which is where those peers resolve, and fall back to this
// checkout when nothing is installed yet. Override with FIRECRAWL_PLUGIN.
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE = process.env.FIRECRAWL_PLUGIN_PROFILE ?? "web";
const INSTALLED = join(DSH_HOME, "profiles", PROFILE, "node_modules", "@deepseek-ai", "dsh-tool-firecrawl", "lib", "index.js");
const PLUGIN = process.env.FIRECRAWL_PLUGIN ?? pathToFileURL(existsSync(INSTALLED) ? INSTALLED : join(HERE, "lib", "index.js")).href;

console.log(`\nplugin module: ${PLUGIN}`);
const { apply, name, inject, Config, DEFAULT_API_URL, DEFAULT_API_KEY_ENV } = await import(PLUGIN);

check("exports name", typeof name === "string" && name === "tool-firecrawl");
check("injects tools and systemPrompt", JSON.stringify(inject) === JSON.stringify(["tools", "systemPrompt"]));

// The loader normalizes config through the schema before apply(); mimic that,
// including the defaults the bundled patch relies on.
const config = Config({
  apiUrl: process.env.FIRECRAWL_API_URL ?? DEFAULT_API_URL,
  apiKeyEnv: DEFAULT_API_KEY_ENV
});
check("schema fills every default", config.search === true && config.timeoutMs > 0 && config.maxOutputChars > 0, JSON.stringify(config));

const registered = [];
const sections = [];
const ctx = {
  tools: {
    register(def) {
      registered.push(def);
      return () => {};
    }
  },
  systemPrompt: {
    section(entry) {
      sections.push(entry);
      return () => {};
    }
  },
  // The credential seam is a soft dependency; `undefined` means "no store".
  get: () => undefined
};

apply(ctx, config);

const expected = [
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_developer_search",
  "firecrawl_map",
  "firecrawl_parse",
  "firecrawl_crawl",
  "firecrawl_check_crawl_status"
];
const names = registered.map((tool) => tool.name);
check("registers all seven tools", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
check("every tool has a description", registered.every((tool) => typeof tool.description === "string" && tool.description.length > 20));
check("every tool declares a timeout", registered.every((tool) => Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0));
check("prompt sections are named per tool", sections.every((section) => section.name.startsWith("tool:firecrawl_")), sections.map((s) => s.name).join(", "));

// Per-tool switches are the second half of "enable/disable": a deployment can
// keep the bundle mounted and still remove one declaration from the schema list.
{
  const partial = Config({ scrape: false, crawl: false, checkCrawlStatus: false });
  const count = [];
  apply(
    { tools: { register: (def) => (count.push(def.name), () => {}) }, systemPrompt: { section: () => () => {} }, get: () => undefined },
    partial
  );
  check("per-tool switches drop those tools", !count.includes("firecrawl_scrape") && !count.includes("firecrawl_crawl") && count.includes("firecrawl_search"), count.join(", "));
}

// A blank API URL must fail at mount, with the fix in the message. The schema
// deliberately keeps a default (the bundle has to stay mountable with a
// placeholder), so this exercises the `apply()` guard — the path a hand-written
// composition or a blanked profile patch actually takes.
{
  let message;
  try {
    apply({ tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} }, get: () => undefined }, { ...config, apiUrl: "  " });
  } catch (error) {
    message = String(error.message);
  }
  check("blank apiUrl fails loudly at mount", typeof message === "string" && message.includes("apiUrl"), message);
}

if (!LIVE) {
  console.log(`\n${failures === 0 ? "OFFLINE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log("Set FIRECRAWL_SMOKE_LIVE=1 to also run the tools against the instance.");
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 3. Live instance
// ---------------------------------------------------------------------------

const signal = AbortSignal.timeout(60000);
const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));

async function run(label, toolName, args, expect = () => true) {
  const def = byName[toolName];
  if (!def) {
    failures += 1;
    console.log(`\n=== ${label} — FAILED: ${toolName} not registered`);
    return undefined;
  }
  try {
    const out = await def.execute(args, { signal });
    const verdict = expect(out);
    if (verdict !== true) failures += 1;
    console.log(`\n=== ${label} — ${verdict === true ? "OK" : "UNEXPECTED"}`);
    console.log(String(out).slice(0, 700));
    return out;
  } catch (error) {
    failures += 1;
    console.log(`\n=== ${label} — FAILED`);
    console.log(String(error.message).slice(0, 700));
    return undefined;
  }
}

await run("firecrawl_scrape", "firecrawl_scrape", { url: "https://example.com" }, (out) => /Scraped https:\/\/example\.com/.test(out));
await run("firecrawl_search", "firecrawl_search", { query: "firecrawl self-hosted", limit: 3 }, (out) => /Search results|No results found/.test(out));
await run("firecrawl_developer_search", "firecrawl_developer_search", { query: "react hooks", k: 3 }, (out) => /Developer results|Search results|No developer results/.test(out));
await run("firecrawl_map", "firecrawl_map", { url: "https://example.com", limit: 5 }, (out) => /Mapped URLs|No URLs mapped/.test(out));

const started = await run("firecrawl_crawl", "firecrawl_crawl", { url: "https://example.com", limit: 2 }, (out) => /Crawl started|Job id/.test(out));
const jobId = /Job id:\s*(\S+)/i.exec(started ?? "")?.[1];
if (jobId) {
  await run("firecrawl_check_crawl_status", "firecrawl_check_crawl_status", { id: jobId }, (out) => /Crawl status:/.test(out));
} else {
  console.log("\n(no crawl id parsed; skipping the status check)");
}

// parse: write a supported file into the temp directory, then parse it.
const { writeFile, unlink } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const htmlPath = join(tmpdir(), `firecrawl-smoke-${process.pid}.html`);
await writeFile(htmlPath, "<html><head><title>Smoke</title></head><body><h1>Hello</h1><p>Firecrawl parse smoke test.</p></body></html>");
await run("firecrawl_parse", "firecrawl_parse", { filePath: htmlPath }, (out) => /Hello|Firecrawl parse smoke test|Summary/.test(out));
await unlink(htmlPath).catch(() => {});

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
