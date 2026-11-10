// Smoke test for @deepseek-ai/dsh-tool-context7.
//
// Drives the plugin WITHOUT the DSH loader: it builds a fake ctx, runs the
// exported Schemastery `Config` over a partial config (the loader's step), calls
// apply(), and then exercises the registered tools. The browser half is checked
// statically, without a DOM.
//
//   node smoke-test.mjs                        # offline: manifest + schema + wiring
//   CONTEXT7_SMOKE_LIVE=1 node smoke-test.mjs  # also hit the Context7 API
//   CONTEXT7_API_URL=… node smoke-test.mjs     # point at a mirror
//
// The live section is opt-in so the test stays usable offline. The key is read
// from CONTEXT7_API_KEY in the environment; without it the anonymous tier is
// used, which is enough for the assertions below but is rate limited.
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// The browser half: without these three, the Plugins page never loads the form.
check("declares a web client half", manifest.dsh?.client?.platform === "web", JSON.stringify(manifest.dsh?.client));
check("exports the client bundle", manifest.exports?.["./client"] === "./lib/client.js");
check("files ships the client bundle", (manifest.files ?? []).includes("lib/client.js"));
check(
  "client inject names the settings and plugin-manager UI",
  (manifest.dsh?.client?.inject ?? []).includes("@deepseek-ai/dsh-client-ui-settings") &&
    (manifest.dsh?.client?.inject ?? []).includes("@deepseek-ai/dsh-client-ui-plugin-manager"),
  JSON.stringify(manifest.dsh?.client?.inject)
);

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
// 2. Browser half: registration contract, checked without a DOM
// ---------------------------------------------------------------------------

// The browser half is a ModuleLoader bundle, not a module: it calls
// `window.__ModuleLoader__.load({ id, factory })` at load time. Capture that
// registration and inspect the plugin object the factory returns.
const clientSource = readFileSync(join(HERE, "lib", "client.js"), "utf8");
{
  let registration;
  const fakeWindow = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const factory = new Function("window", `${clientSource}\nreturn window.__ModuleLoader__.load;`);
  factory(fakeWindow);
  check("client registers a module", typeof registration === "object" && registration !== null);
  check("client module id is the package name", registration?.id === manifest.name, registration?.id);

  // A hook runtime that actually runs effects. A stub whose `useEffect` is a
  // no-op hides every bug that lives inside an effect — which is how a crashing
  // credential lookup reached the browser with all checks green.
  function createReact() {
    const states = [];
    const effects = [];
    let cursor = 0;
    return {
      React: {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) {
          const index = cursor++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (next) => {
            states[index] = typeof next === "function" ? next(states[index]) : next;
          }];
        },
        useEffect(effect) {
          const index = cursor++;
          if (!(index in effects)) effects[index] = { effect, ran: false };
        },
        useId: () => `id-${cursor++}`,
      },
      reset() { cursor = 0; },
      runEffects() {
        for (const slot of effects) {
          if (slot === undefined || slot.ran) continue;
          slot.ran = true;
          slot.effect();
        }
      },
      get states() { return states; },
    };
  }

  let runtime = createReact();
  // The factory runs once, so it gets a facade that forwards to the live runtime.
  const ReactFacade = {
    createElement: (...args) => runtime.React.createElement(...args),
    useState: (...args) => runtime.React.useState(...args),
    useEffect: (...args) => runtime.React.useEffect(...args),
    useId: (...args) => runtime.React.useId(...args),
  };

  const required = [];
  const plugin = registration?.factory((specifier) => {
    required.push(specifier);
    if (specifier === "react") return ReactFacade;
    throw new Error(`unexpected require(${specifier})`);
  });

  check("client returns a plugin", typeof plugin?.apply === "function");
  check("client requires only react (no Harness Client package)", JSON.stringify(required) === JSON.stringify(["react"]), required.join(", "));
  check("client injects slots", (plugin?.inject ?? []).includes("slots"), JSON.stringify(plugin?.inject));

  /**
   * A browser context faithful to Cordis in the two ways that matter here:
   *
   * 1. An unknown member throws, and reaching through the remote facade throws
   *    with the DOTTED service key — the exact message the browser logged:
   *      cannot get property "remote.credentials" without inject
   * 2. `describe` answers a RemoteResult envelope (`{ ok, value }`), while
   *    `set`/`unset` are plain promises that reject. Reading the envelope as the
   *    mapping is what made the key field report "not set / read-only" at once.
   */
  function createCtx({ withCredentials = true, stored = undefined } = {}) {
    let held = stored;
    const credentials = {
      describe: async (refs) => ({
        ok: true,
        value: Object.fromEntries(refs.map((ref) => [
          ref,
          held === undefined
            ? { configured: false, writable: true }
            : { configured: true, source: "file", writable: true },
        ])),
      }),
      set: async (ref, value) => { held = value; },
      unset: async () => { held = undefined; },
      get held() { return held; },
    };
    const facade = new Proxy({ $on: () => () => {} }, {
      get(object, prop) {
        if (prop in object) return object[prop];
        throw new Error(`cannot get property "remote.${String(prop)}" without inject`);
      },
    });
    const target = {
      locale: {
        register: () => () => {},
        bind: (ns) => (key, params) => (params === undefined ? `${ns}.${key}` : `${ns}.${key}:${JSON.stringify(params)}`),
      },
      slots: { inject: () => () => {}, register: () => () => {} },
      // A real `ctx.effect` runs its callback immediately and keeps the disposer;
      // a no-op here would silently skip every effect-based registration.
      effect: (callback) => {
        const disposer = callback();
        return typeof disposer === "function" ? disposer : () => {};
      },
      on: () => () => {},
      inject: () => () => {},
      // `remote` is declared in the plugin's `inject`, so the context resolves it.
      remote: facade,
      get: (name) => (name === "remote" ? facade : name === "remote.credentials" ? (withCredentials ? credentials : undefined) : undefined),
    };
    return {
      ctx: new Proxy(target, {
        get(object, prop) {
          if (prop in object) return object[prop];
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
      }),
      credentials,
    };
  }

  const registrations = [];
  const dictionaries = [];
  const appCtx = createCtx();
  plugin.apply({
    ...appCtx.ctx,
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {}; },
      bind: (ns) => (key, params) => (params === undefined ? `${ns}.${key}` : `${ns}.${key}:${JSON.stringify(params)}`),
    },
    slots: {
      inject: (owner, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
  });

  check("client registers into plugins.row.config", registrations.length === 1 && registrations[0].options.name === "plugins.row.config",
    registrations.map((entry) => entry.options.name).join(", "));
  const key = registrations[0]?.options.key;
  check("row config key is '<package>#<row id>'", key === `${manifest.name}#tool-context7`, key);
  check("row id matches the bundled patch", /id:\s*tool-context7/.test(patch));

  check("client registers en and zh dictionaries", dictionaries.length === 1 && dictionaries[0].dicts.en !== undefined && dictionaries[0].dicts.zh !== undefined,
    `${dictionaries.length} registration(s)`);

  // Every dictionary key must exist in both languages, or the page renders a raw
  // key in one locale.
  const en = dictionaries[0]?.dicts.en ?? {};
  const zh = dictionaries[0]?.dicts.zh ?? {};
  const missing = Object.keys(en).filter((entry) => zh[entry] === undefined);
  check("both dictionaries carry the same keys", missing.length === 0, missing.join(", "));
  const extras = Object.keys(zh).filter((entry) => en[entry] === undefined);
  check("neither dictionary has extra keys", extras.length === 0, extras.join(", "));

  // `Object.keys` cannot see a duplicated literal key — the later one silently
  // wins and an outdated string can shadow the current copy. Read the source.
  for (const [language, marker, end] of [["en", "const en = {", "const zh = {"], ["zh", "const zh = {", "const CSS"]]) {
    const start = clientSource.indexOf(marker);
    const stop = clientSource.indexOf(end, start + marker.length);
    const body = clientSource.slice(start, stop);
    const seen = new Map();
    for (const match of body.matchAll(/^\s{6}([A-Za-z][\w]*):/gm)) {
      seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    check(`locale/${language} dictionary has no duplicate keys`, duplicated.length === 0, duplicated.join(", "));
  }

  const t = (label, params) => (params === undefined ? label : `${label}:${JSON.stringify(params)}`);
  const form = {
    state: {
      status: "ready",
      value: { apiUrl: "https://context7.mirror/api", apiKeyEnv: "CONTEXT7_MIRROR_KEY", resolveLibraryId: true, queryDocs: false, maxOutputChars: 120000 },
      base: { apiUrl: "https://context7.com/api", apiKeyEnv: "CONTEXT7_API_KEY", resolveLibraryId: true, queryDocs: true, maxOutputChars: 200000 },
      user: { apiUrl: "https://context7.mirror/api" },
      revision: 3,
      writable: true,
    },
    mutate: async () => true,
  };

  /** Render once with a fresh runtime, then flush effects. A throw is a slot crash. */
  let last;
  function render(label, props) {
    runtime = createReact();
    last = runtime;
    try {
      const tree = registrations[0].component(props);
      runtime.runEffects();
      check(label, tree !== undefined && tree !== null);
      return tree;
    } catch (error) {
      check(label, false, `${error?.constructor?.name}: ${error?.message}`);
      return undefined;
    }
  }

  render("summary view renders without a form", { t, view: "summary" });
  // A row page whose entry projects no volatile field passes no `form`; the page
  // must say so instead of throwing, because a throwing component blanks the slot.
  render("page without a form renders a fallback", { t, view: "page" });

  // The full page, against a ctx whose facade traps unknown members.
  render("page renders against the Cordis inject trap", { t, view: "page", form, ctx: createCtx().ctx });
  // `describe()` is a round trip, so the accepted snapshot lands on a later tick.
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("the credential lookup resolved", last.states.some((state) => state?.status === "ready"),
    JSON.stringify(last.states.filter((state) => state?.status !== undefined)));
  check("the credential namespace is read by its dotted key", /ctx\.get\(\s*["']remote\.credentials["']\s*\)/.test(clientSource));
  check("the facade is never reached through for a namespace", !/ctx\.get\(\s*["']remote["']\s*\)\?\.\w/.test(clientSource));

  // A deployment without a credential controller must degrade, not crash.
  render("page degrades without a credential namespace", { t, view: "page", form, ctx: createCtx({ withCredentials: false }).ctx });
  check("the missing namespace reads as unavailable", last.states.some((state) => state?.status === "unavailable"),
    JSON.stringify(last.states.filter((state) => state?.status !== undefined)));

  // The key input must render for an UNSET key too: that is precisely when it is
  // needed, and gating it on `configured` once hid it there.
  function textOf(node, out = []) {
    if (node === null || node === undefined) return out;
    if (typeof node === "string") { out.push(node); return out; }
    if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
    if (typeof node === "object") {
      if (node.type === "input" && node.props?.type === "password") out.push("PASSWORD_INPUT");
      for (const child of node.children ?? []) textOf(child, out);
    }
    return out;
  }

  {
    const tree = render("page renders with an unset key", { t, view: "page", form, ctx: createCtx().ctx });
    check("the key input renders when no key is stored", textOf(tree).includes("PASSWORD_INPUT"),
      textOf(tree).filter((text) => text === "PASSWORD_INPUT").length === 0 ? "no password input in the tree" : "");
  }

  {
    const tree = render("page renders with a stored key", { t, view: "page", form, ctx: createCtx({ stored: "ctx7sk-secret" }).ctx });
    check("the key input still renders with a stored key", textOf(tree).includes("PASSWORD_INPUT"));
  }

  // The page must not import the primitives package; the plan forbids it, and
  // slot entry crashes are silent otherwise.
  check("client avoids JSX and TypeScript", !/<[A-Za-z][A-Za-z0-9]*[\s/>]/.test(clientSource.replace(/\/\/.*$/gm, "")), "no JSX in the browser half");
  check("client imports no Harness Client package", !/require\(["']@deepseek-ai\//.test(clientSource), "no @deepseek-ai require");
  check("client styles by theme token only", !/:\s*#[0-9a-fA-F]{3,8}\b/.test(clientSource), "no literal hex colors");

  // Buttons and inputs must not be squeezed by their flex row: a wrapped label
  // ("保存密/钥") is what an unspecified button width produces.
  check("buttons keep their own width", /\.tc7-button\s*\{[^}]*flex:\s*0 0 auto/.test(clientSource));
  check("buttons do not wrap their label", /\.tc7-button\s*\{[^}]*white-space:\s*nowrap/.test(clientSource));
  check("the key input flexes and may shrink", /\.tc7-secretRow\s*>\s*\.tc7-input\s*\{[^}]*min-width:\s*0/.test(clientSource));
}

// ---------------------------------------------------------------------------
// 3. Plugin contract
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

// The loader normalizes config through the schema before apply(), including the
// defaults the bundled patch relies on. The result holds live references for the
// volatile fields, so every assertion below reads through `get()`.
const config = Config({ apiUrl: process.env.CONTEXT7_API_URL ?? API_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV });

/** Read a config value, whether it arrived volatile or plain. */
const read = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);

check(
  "schema fills every default",
  read(config.resolveLibraryId) === true &&
    read(config.queryDocs) === true &&
    read(config.apiKey) === "" &&
    read(config.timeoutMs) > 0 &&
    read(config.maxOutputChars) > 0,
  JSON.stringify({ apiUrl: read(config.apiUrl), timeoutMs: read(config.timeoutMs) })
);

// The page can only edit volatile fields — that is the whole mechanism, so assert
// both directions: the editable ones project, and the secret/timeout do not.
const volatileFields = Object.entries(Config.toJSON().refs).filter(([, node]) => node?.meta?.volatile === true).length;
check("schema declares volatile fields for the page", volatileFields >= 5, `${volatileFields} volatile nodes`);
check("apiKey stays out of the editable projection", read(config.apiKey) === "" && typeof config.apiKey === "string", typeof config.apiKey);
check("timeoutMs stays plain (applied on reload)", typeof config.timeoutMs === "number", typeof config.timeoutMs);

function makeCtx() {
  const registered = [];
  const sections = [];
  const ctx = {
    tools: {
      register(def, options) {
        registered.push({ def, options });
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
const names = registered.map(({ def }) => def.name);
check("registers both tools", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
check("every tool has a description", registered.every(({ def }) => typeof def.description === "string" && def.description.length > 20));
check("every tool declares a timeout", registered.every(({ def }) => Number.isFinite(def.timeoutMs) && def.timeoutMs > 0));
check("every tool carries a step-time switch", registered.every(({ options }) => typeof options?.when === "function"));
check("prompt sections are named per tool", sections.every((section) => section.name.startsWith("tool:context7_")), sections.map((s) => s.name).join(", "));
check("prompt sections take the web-fetch slot order", sections.every((section) => section.order === TOOL_WEB_FETCH_ORDER), sections.map((s) => `${s.name}@${s.order}`).join(", "));

// The prompt text is a function, so a tool switched off on the page also drops
// its guidance from the next assembly (assembly discards empty sections).
check("prompt text is resolved per assembly", sections.every((section) => typeof section.text === "function"));
const texts = sections.map((section) => section.text());
check("enabled tools contribute guidance", texts.every((text) => typeof text === "string" && text.length > 20), texts.map((text) => text.length).join(", "));

// Per-tool switches are the second half of "enable/disable": the bundle stays
// mounted and one declaration leaves the schema list. They are step-time `when`
// conditions now, so flipping the live reference must be enough — no rebuild.
{
  const { ctx: partialCtx, registered: partialRegistered, sections: partialSections } = makeCtx();
  const partial = Config({ resolveLibraryId: false });
  apply(partialCtx, partial);
  const switched = partialRegistered.map(({ def, options }) => ({ name: def.name, at: options.when }));
  const resolveEntry = switched.find((entry) => entry.name === "context7_resolve_library_id");
  const docsEntry = switched.find((entry) => entry.name === "context7_query_docs");
  check("both tools stay registered when one is switched off", switched.length === 2, switched.map((entry) => entry.name).join(", "));
  check("switched-off tool reports inactive per step", resolveEntry?.at({ agent: { id: "a" }, signal: AbortSignal.abort() }) === false);
  check("switched-on tool reports active per step", docsEntry?.at({ agent: { id: "a" }, signal: AbortSignal.abort() }) === true);
  const offText = partialSections.find((section) => section.name === "tool:context7_resolve_library_id");
  check("switched-off tool drops its prompt text", offText?.text() === "");
  const onText = partialSections.find((section) => section.name === "tool:context7_query_docs");
  check("switched-on tool keeps its prompt text", typeof onText?.text() === "string" && onText.text().length > 20);
}

// A live reference is updated in place by the settings write, so a value changed
// after apply() must be visible to the very next call without a rebuild. The
// harness commits through cosmokit's `updateVolatile`, which is what this uses.
{
  const cosmokit = await import("@deepseek-ai/cosmokit");
  const { ctx: liveCtx, registered: liveRegistered } = makeCtx();
  const live = Config({});
  apply(liveCtx, live);
  const before = liveRegistered[0].options.when({ agent: { id: "a" }, signal: AbortSignal.abort() });
  cosmokit.updateVolatile(live.resolveLibraryId, cosmokit.createVolatile(false));
  const after = liveRegistered[0].options.when({ agent: { id: "a" }, signal: AbortSignal.abort() });
  check("a live reference change reaches the switch", before === true && after === false, `${before} -> ${after}`);
}

// A blank API URL must fail at mount, with the fix in the message. The schema
// deliberately keeps a default (the bundle has to stay mountable with a
// placeholder), so this exercises the `apply()` guard — the path a hand-written
// composition or a blanked profile patch actually takes.
{
  const { ctx: blankCtx } = makeCtx();
  let message;
  try {
    apply(blankCtx, Config({ apiUrl: "  " }));
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
    apply(seamToolCtx, Config({}));
    await seamTools[0].def.execute({ query: "react", libraryName: "React" }, { signal: AbortSignal.timeout(5000) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("credential store key becomes a bearer token", seen[0] === "Bearer ctx7sk-from-store", String(seen[0]));
}

// The same seam, after the page renames the reference: the next call must resolve
// the new name through the store instead of the old one.
{
  const seenRefs = [];
  const store = { CONTEXT7_API_KEY: "ctx7sk-old", CONTEXT7_MIRROR_KEY: "ctx7sk-new" };
  const renameCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    get: (service) => (service === "credentials" ? {
      resolve: async (ref) => { seenRefs.push(ref); return store[ref] === undefined ? undefined : { value: store[ref] }; }
    } : undefined)
  };
  const tokens = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    tokens.push(init?.headers?.authorization);
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" };
  };
  try {
    const cosmokit = await import("@deepseek-ai/cosmokit");
    const live = Config({});
    const { ctx: renameToolCtx, registered: renameTools } = makeCtx();
    renameToolCtx.get = renameCtx.get;
    apply(renameToolCtx, live);
    await renameTools[0].def.execute({ query: "react", libraryName: "React" }, { signal: AbortSignal.timeout(5000) });
    cosmokit.updateVolatile(live.apiKeyEnv, cosmokit.createVolatile("CONTEXT7_MIRROR_KEY"));
    await renameTools[0].def.execute({ query: "react", libraryName: "React" }, { signal: AbortSignal.timeout(5000) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("a live reference rename re-resolves the credential", tokens[0] === "Bearer ctx7sk-old" && tokens[1] === "Bearer ctx7sk-new", tokens.join(" -> "));
}

if (!LIVE) {
  console.log(`\n${failures === 0 ? "OFFLINE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log("Set CONTEXT7_SMOKE_LIVE=1 to also run the tools against the Context7 API.");
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 4. Live API
// ---------------------------------------------------------------------------

const signal = AbortSignal.timeout(60000);
const byName = Object.fromEntries(registered.map(({ def }) => [def.name, def]));

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
