// Smoke test for @deepseek-ai/dsh-tool-context7.
//
// Drives the plugin WITHOUT the DSH loader: it builds a fake ctx, runs the
// exported Schemastery `Config` over a partial config (the loader's step), calls
// apply(), and then exercises the registered tools against the live Context7 API.
//
//   node smoke-test.mjs                        # offline: manifest + schema + wiring
//   CONTEXT7_SMOKE_LIVE=1 node smoke-test.mjs  # also hit the Context7 API
//   CONTEXT7_API_URL=… node smoke-test.mjs     # point at a mirror
//
// The live section is opt-in so the test stays usable offline. The key is read
// from CONTEXT7_API_KEY in the environment; without it the anonymous tier is
// used, which is enough for the assertions below but is rate limited.
import { readFileSync, existsSync, symlinkSync, mkdirSync, rmSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const LIVE = process.env.CONTEXT7_SMOKE_LIVE === "1";

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
check("patch mounts tool-context7 by package name", /name:\s*'@deepseek-ai\/dsh-tool-context7'/.test(patch));
check("patch sets an id", /id:\s*tool-context7/.test(patch));
check("patch carries no literal API key", !/apiKey:/.test(patch));

const icon = readFileSync(join(HERE, "icon.svg"), "utf8");
check("icon is a well-formed svg", /^<svg[\s>]/.test(icon.trim()) && icon.trim().endsWith("</svg>"), `${icon.length} bytes`);
check("icon stays under 256 KiB", Buffer.byteLength(icon) < 262144);

// ---------------------------------------------------------------------------
// 2. Plugin contract
// ---------------------------------------------------------------------------

// The plugin's `@deepseek-ai/*` peers are NOT dependencies of this package:
// they belong to the harness that loads it. A plain dynamic `import()` of the
// module therefore fails with ERR_MODULE_NOT_FOUND, because bare-specifier
// resolution walks up from the module's REAL path — which is this checkout, or
// a profile's symlink to it — and neither has the peers.
//
// So resolve the peers the way the harness does (from the dsh installation that
// owns them) and alias them for the duration of this process. `--import` only
// accepts a specifier, and the alias has to be installed before the loader
// resolves it, hence the re-exec.
const PEER_ALIAS = `
import { registerHooks } from "node:module";
import { createRequire } from "node:module";
const require = createRequire(process.env.DSH_PEER_ANCHOR);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@deepseek-ai/")) {
      try { return { url: new URL("file://" + require.resolve(specifier).replace(/\\\\/g, "/")).href, shortCircuit: true }; }
      catch { /* fall through to the default resolver */ }
    }
    return nextResolve(specifier, context);
  }
});
`;

if (process.env.CONTEXT7_SMOKE_PEERS !== "1") {
  const dshRoot = process.env.CONTEXT7_DSH_ROOT ?? join(dirname(execFileSync("where", ["dsh"], { encoding: "utf8" }).split(/\r?\n/)[0].trim()), "node_modules", "@deepseek-ai", "dsh");
  const anchor = join(dshRoot, "package.json");
  if (!existsSync(anchor)) {
    console.log(`FAIL cannot locate the dsh installation to resolve @deepseek-ai peers (looked for ${anchor})`);
    console.log("Set CONTEXT7_DSH_ROOT to the dsh package directory and retry.");
    process.exit(1);
  }
  const aliasDir = join(HERE, ".smoke-peers");
  mkdirSync(aliasDir, { recursive: true });
  const aliasFile = join(aliasDir, "peers.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(aliasFile, PEER_ALIAS, "utf8");
  const result = (await import("node:child_process")).spawnSync(
    process.execPath,
    ["--import", pathToFileURL(aliasFile).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, DSH_PEER_ANCHOR: anchor, CONTEXT7_SMOKE_PEERS: "1" } }
  );
  rmSync(aliasDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

// Past the re-exec the peers resolve, so the installed bundle can be imported
// even though its real path has no node_modules of its own.
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE = process.env.CONTEXT7_PLUGIN_PROFILE ?? "web";
const INSTALLED = join(DSH_HOME, "profiles", PROFILE, "node_modules", "@deepseek-ai", "dsh-tool-context7", "lib", "index.js");
const PLUGIN = process.env.CONTEXT7_PLUGIN ?? pathToFileURL(existsSync(INSTALLED) ? INSTALLED : join(HERE, "lib", "index.js")).href;

console.log(`\nplugin module: ${PLUGIN}`);
const { apply, name, inject, Config, API_BASE_URL, DEFAULT_API_KEY_ENV, TOOL_WEB_FETCH_ORDER } = await import(PLUGIN);

check("exports name", typeof name === "string" && name === "tool-context7", name);
check("injects tools and systemPrompt", JSON.stringify(inject) === JSON.stringify(["tools", "systemPrompt"]));
check("declares a default API url", API_BASE_URL === "https://context7.com/api", API_BASE_URL);
check("declares a default key reference", DEFAULT_API_KEY_ENV === "CONTEXT7_API_KEY", DEFAULT_API_KEY_ENV);

// The loader normalizes config through the schema before apply(); mimic that,
// including the defaults the bundled patch relies on.
const config = Config({ apiUrl: process.env.CONTEXT7_API_URL ?? API_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV });
check(
  "schema fills every default",
  config.resolveLibraryId === true && config.queryDocs === true && config.apiKey === "" && config.timeoutMs > 0 && config.maxOutputChars > 0,
  JSON.stringify(config)
);

function makeCtx() {
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
      },
      // The harness exposes the central slot scale; the plugin must use it.
      getSectionOrder: (slotName) => (slotName === "TOOL_WEB_FETCH" ? TOOL_WEB_FETCH_ORDER : 0)
    },
    // The credential seam is a soft dependency; `undefined` means "no store".
    get: () => undefined
  };
  return { ctx, registered, sections };
}

const { ctx, registered, sections } = makeCtx();
apply(ctx, config);

const expected = ["context7_resolve_library_id", "context7_query_docs"];
const names = registered.map((tool) => tool.name);
check("registers both tools", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
check("every tool has a description", registered.every((tool) => typeof tool.description === "string" && tool.description.length > 20));
check("every tool declares a timeout", registered.every((tool) => Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0));
check("prompt sections are named per tool", sections.every((section) => section.name.startsWith("tool:context7_")), sections.map((s) => s.name).join(", "));
check("prompt sections take the web-fetch slot order", sections.every((section) => section.order === TOOL_WEB_FETCH_ORDER), sections.map((s) => `${s.name}@${s.order}`).join(", "));

// Per-tool switches are the second half of "enable/disable": a deployment can
// keep the bundle mounted and still remove one declaration from the schema list.
{
  const partial = Config({ resolveLibraryId: false });
  const { ctx: partialCtx, registered: partialRegistered } = makeCtx();
  apply(partialCtx, partial);
  const partialNames = partialRegistered.map((tool) => tool.name);
  check("per-tool switches drop those tools", JSON.stringify(partialNames) === JSON.stringify(["context7_query_docs"]), partialNames.join(", "));
}

// A blank API URL must fail at mount, with the fix in the message. The schema
// deliberately keeps a default (the bundle has to stay mountable with a
// placeholder), so this exercises the `apply()` guard — the path a hand-written
// composition or a blanked profile patch actually takes.
{
  const { ctx: blankCtx } = makeCtx();
  let message;
  try {
    apply(blankCtx, { ...config, apiUrl: "  " });
  } catch (error) {
    message = String(error.message);
  }
  check("blank apiUrl fails loudly at mount", typeof message === "string" && message.includes("apiUrl"), message);
}

// The credential seam is preferred over the environment, and a key from either
// source must reach the request as a bearer token.
{
  const seen = [];
  const seamCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    get: (service) => (service === "credentials" ? { resolve: async (ref) => (ref === "CONTEXT7_API_KEY" ? { value: "ctx7sk-from-store" } : undefined) } : undefined)
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers?.authorization);
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" };
  };
  try {
    const { ctx: seamToolCtx, registered: seamTools } = makeCtx();
    seamToolCtx.get = seamCtx.get;
    apply(seamToolCtx, config);
    await seamTools[0].execute({ query: "react", libraryName: "React" }, { signal: AbortSignal.timeout(5000) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("credential store key becomes a bearer token", seen[0] === "Bearer ctx7sk-from-store", String(seen[0]));
}

if (!LIVE) {
  console.log(`\n${failures === 0 ? "OFFLINE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log("Set CONTEXT7_SMOKE_LIVE=1 to also run the tools against the Context7 API.");
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 3. Live API
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

await run("context7_resolve_library_id", "context7_resolve_library_id", { query: "react hooks", libraryName: "React" }, (out) => /Available Libraries|No libraries found/.test(out));
await run("context7_query_docs", "context7_query_docs", { libraryId: "/vercel/next.js", query: "useEffect cleanup function examples" }, (out) => typeof out === "string" && out.length > 0);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
