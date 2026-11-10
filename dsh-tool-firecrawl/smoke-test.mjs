// Smoke test for @deepseek-ai/dsh-tool-firecrawl.
//
// Drives the plugin WITHOUT the DSH loader: it builds a fake ctx, runs the
// exported Schemastery `Config` over a partial config (the loader's step), calls
// apply(), and then exercises the registered tools. The browser half is checked
// statically, without a DOM.
//
//   node smoke-test.mjs                       # offline: manifest + schema + wiring
//   FIRECRAWL_SMOKE_LIVE=1 node smoke-test.mjs  # also hit the instance
//   FIRECRAWL_API_URL=… node smoke-test.mjs   # point at another instance
//
// The live section is opt-in so the test is usable on a machine without a
// Firecrawl instance — the reference case for a self-hosted plugin, which has no
// built-in target.
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const LIVE = process.env.FIRECRAWL_SMOKE_LIVE === "1";

// ---------------------------------------------------------------------------
// 0. Re-exec with the @deepseek-ai peers aliased
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
//
// This runs FIRST, before any assertion prints, so a run reports each check
// exactly once. The re-exec uses the same file, and the guard variable stops the
// child from recursing.
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

if (process.env.FIRECRAWL_SMOKE_PEERS !== "1") {
  const dshRoot = process.env.FIRECRAWL_DSH_ROOT ?? join(dirname(execFileSync("where", ["dsh"], { encoding: "utf8" }).split(/\r?\n/)[0].trim()), "node_modules", "@deepseek-ai", "dsh");
  const anchor = join(dshRoot, "package.json");
  if (!existsSync(anchor)) {
    console.log(`FAIL cannot locate the dsh installation to resolve @deepseek-ai peers (looked for ${anchor})`);
    console.log("Set FIRECRAWL_DSH_ROOT to the dsh package directory and retry.");
    process.exit(1);
  }
  const aliasDir = join(HERE, ".smoke-peers");
  mkdirSync(aliasDir, { recursive: true });
  const aliasFile = join(aliasDir, "peers.mjs");
  writeFileSync(aliasFile, PEER_ALIAS, "utf8");
  const result = (await import("node:child_process")).spawnSync(
    process.execPath,
    ["--import", pathToFileURL(aliasFile).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, DSH_PEER_ANCHOR: anchor, FIRECRAWL_SMOKE_PEERS: "1" } }
  );
  rmSync(aliasDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

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
check("patch mounts tool-firecrawl by package name", /name:\s*'@deepseek-ai\/dsh-tool-firecrawl'/.test(patch));
check("patch sets an id", /id:\s*tool-firecrawl/.test(patch));
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
  // credential lookup once reached the browser with all checks green.
  function createReact() {
    const states = [];
    const effects = [];
    let cursor = 0;
    return {
      React: {
        // Mirror React by folding children into props: `Field` reads
        // `props.children`, so a fake that keeps them only in the element would
        // render every field empty and hide the controls from the assertions.
        createElement: (type, props, ...children) => {
          const merged = { ...(props ?? {}) };
          if (children.length === 1) merged.children = children[0];
          else if (children.length > 1) merged.children = children;
          return { type, props: merged, children };
        },
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
   *    with the DOTTED service key — the exact message the browser logs:
   *      cannot get property "remote.credentials" without inject
   * 2. `describe` answers a RemoteResult envelope (`{ ok, value }`), while
   *    `set`/`unset` are plain promises that reject. Reading the envelope as the
   *    mapping makes the key field report "not set / read-only" at once.
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
  plugin.apply({
    ...createCtx().ctx,
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
  check("row config key is '<package>#<row id>'", key === `${manifest.name}#tool-firecrawl`, key);
  check("row id matches the bundled patch", /id:\s*tool-firecrawl/.test(patch));

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

  // Every field the form asks for must have a label in BOTH dictionaries, or the
  // page renders `toolFirecrawl.scrape` in one locale.
  const FORM_FIELDS = [
    "scrape", "search", "developerSearch", "map", "parse", "crawl", "checkCrawlStatus",
    "searchMaxResults", "mapMaxResults", "crawlMaxResults", "maxOutputChars",
  ];
  const badLabels = FORM_FIELDS.filter((field) => en[field] === undefined || zh[field] === undefined);
  check("every edited field is labelled in both dictionaries", badLabels.length === 0, badLabels.join(", "));
  const badHints = FORM_FIELDS.filter((field) => en[`${field}Hint`] === undefined || zh[`${field}Hint`] === undefined);
  check("every edited field has a hint in both dictionaries", badHints.length === 0, badHints.join(", "));

  const t = (label, params) => (params === undefined ? label : `${label}:${JSON.stringify(params)}`);
  const form = {
    state: {
      status: "ready",
      value: {
        apiUrl: "http://firecrawl.mirror:3002",
        apiKeyEnv: "FIRECRAWL_MIRROR_KEY",
        scrape: true, search: false, developerSearch: true, map: true, parse: false, crawl: true, checkCrawlStatus: true,
        searchMaxResults: 12, mapMaxResults: 40, crawlMaxResults: 25, maxOutputChars: 90000,
      },
      base: {
        apiUrl: "http://firecrawl.localhost",
        apiKeyEnv: "FIRECRAWL_API_KEY",
        scrape: true, search: true, developerSearch: true, map: true, parse: true, crawl: true, checkCrawlStatus: true,
        searchMaxResults: 8, mapMaxResults: 100, crawlMaxResults: 50, maxOutputChars: 200000,
      },
      user: { apiUrl: "http://firecrawl.mirror:3002" },
      revision: 4,
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
    const tree = render("page renders with a stored key", { t, view: "page", form, ctx: createCtx({ stored: "fc-secret" }).ctx });
    check("the key input still renders with a stored key", textOf(tree).includes("PASSWORD_INPUT"));
  }

  // All seven switches and all four counts must actually appear as controls: a
  // field left out of the render is a configuration option nobody can change.
  //
  // The walker expands function components the way a renderer would. Without
  // that, `h(ToggleRow, …)` stays an unrendered element and the seven switches
  // are invisible to the assertion — which is exactly the false negative this
  // check exists to avoid.
  function collect(tree) {
    const inputs = [];
    const switches = [];
    const seen = new Set();
    (function walk(node, depth) {
      if (node === null || node === undefined || depth > 40) return;
      if (Array.isArray(node)) { for (const child of node) walk(child, depth); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "function") {
        if (seen.has(node.type)) return;
        seen.add(node.type);
        walk(node.type(node.props ?? {}), depth + 1);
        seen.delete(node.type);
        return;
      }
      if (node.type === "input") inputs.push(node.props ?? {});
      if (node.props?.role === "switch") switches.push(node.props);
      for (const child of node.children ?? []) walk(child, depth + 1);
      // Children also live in `props.children`; walking both risks visiting a
      // single child twice, so only the element's own list is walked above.
    })(tree, 0);
    return { inputs, switches };
  }

  {
    const tree = render("page renders every control", { t, view: "page", form, ctx: createCtx().ctx });
    const { inputs, switches } = collect(tree);
    check("renders all seven tool switches", switches.length === 7, `${switches.length} switch(es)`);
    const numberInputs = inputs.filter((props) => props.type === "number");
    check("renders all four count fields", numberInputs.length === 4, `${numberInputs.length} number input(s)`);
    check("renders text, URL and password inputs", inputs.some((p) => p.type === "url") && inputs.some((p) => p.type === "text") && inputs.some((p) => p.type === "password"),
      inputs.map((p) => p.type).join(", "));
    const defaulted = numberInputs.map((p) => String(p.value)).sort().join(",");
    check("count fields show the accepted values", defaulted === "12,25,40,90000", defaulted);
    check("a switched-off tool shows unchecked", switches.some((p) => p["aria-checked"] === "false"),
      switches.map((p) => p["aria-label"]).join(", "));
  }

  // The page must not import the primitives package; the plan forbids it, and
  // slot entry crashes are silent otherwise.
  check("client avoids JSX and TypeScript", !/<[A-Za-z][A-Za-z0-9]*[\s/>]/.test(clientSource.replace(/\/\/.*$/gm, "")), "no JSX in the browser half");
  check("client imports no Harness Client package", !/require\(["']@deepseek-ai\//.test(clientSource), "no @deepseek-ai require");
  check("client styles by theme token only", !/:\s*#[0-9a-fA-F]{3,8}\b/.test(clientSource), "no literal hex colors");

  // Buttons and inputs must not be squeezed by their flex row: a wrapped label
  // ("保存密/钥") is what an unspecified button width produces.
  check("buttons keep their own width", /\.fcw-button\s*\{[^}]*flex:\s*0 0 auto/.test(clientSource));
  check("buttons do not wrap their label", /\.fcw-button\s*\{[^}]*white-space:\s*nowrap/.test(clientSource));
  check("the key input flexes and may shrink", /\.fcw-secretRow\s*>\s*\.fcw-input\s*\{[^}]*min-width:\s*0/.test(clientSource));
}

// ---------------------------------------------------------------------------
// 3. Plugin contract
// ---------------------------------------------------------------------------

// Past the re-exec at the top of this file the peers resolve, so the installed
// bundle can be imported even though its real path has no node_modules of its
// own.
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE = process.env.FIRECRAWL_PLUGIN_PROFILE ?? "web";
const INSTALLED = join(DSH_HOME, "profiles", PROFILE, "node_modules", "@deepseek-ai", "dsh-tool-firecrawl", "lib", "index.js");
const PLUGIN = process.env.FIRECRAWL_PLUGIN ?? pathToFileURL(existsSync(INSTALLED) ? INSTALLED : join(HERE, "lib", "index.js")).href;

console.log(`\nplugin module: ${PLUGIN}`);
const { apply, name, inject, Config, DEFAULT_API_URL, DEFAULT_API_KEY_ENV, TOOL_WEB_FETCH_ORDER } = await import(PLUGIN);

check("exports name", typeof name === "string" && name === "tool-firecrawl", name);
check("injects tools and systemPrompt", JSON.stringify(inject) === JSON.stringify(["tools", "systemPrompt"]));
check("declares a default API url", DEFAULT_API_URL === "http://firecrawl.localhost", DEFAULT_API_URL);
check("declares a default key reference", DEFAULT_API_KEY_ENV === "FIRECRAWL_API_KEY", DEFAULT_API_KEY_ENV);

// The loader normalizes config through the schema before apply(), including the
// defaults the bundled patch relies on. The result holds live references for the
// volatile fields, so every assertion below reads through `get()`.
const config = Config({ apiUrl: process.env.FIRECRAWL_API_URL ?? DEFAULT_API_URL, apiKeyEnv: DEFAULT_API_KEY_ENV });

/** Read a config value, whether it arrived volatile or plain. */
const read = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);

check(
  "schema fills every default",
  read(config.scrape) === true &&
    read(config.crawl) === true &&
    read(config.apiKey) === "" &&
    read(config.timeoutMs) > 0 &&
    read(config.searchMaxResults) === 8 &&
    read(config.mapMaxResults) === 100 &&
    read(config.crawlMaxResults) === 50 &&
    read(config.maxOutputChars) > 0,
  JSON.stringify({ apiUrl: read(config.apiUrl), timeoutMs: read(config.timeoutMs) })
);

// The page can only edit volatile fields — that is the whole mechanism, so assert
// both directions: the editable ones project, and the secret/timeout do not.
const volatileFields = Object.entries(Config.toJSON().refs).filter(([, node]) => node?.meta?.volatile === true).length;
check("schema declares volatile fields for the page", volatileFields >= 13, `${volatileFields} volatile nodes`);
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

const expected = [
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_developer_search",
  "firecrawl_map",
  "firecrawl_parse",
  "firecrawl_crawl",
  "firecrawl_check_crawl_status"
];
const names = registered.map(({ def }) => def.name);
check("registers all seven tools", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
check("every tool has a description", registered.every(({ def }) => typeof def.description === "string" && def.description.length > 20));
check("every tool declares a timeout", registered.every(({ def }) => Number.isFinite(def.timeoutMs) && def.timeoutMs > 0));
check("every tool carries a step-time switch", registered.every(({ options }) => typeof options?.when === "function"));
check("prompt sections are named per tool", sections.every((section) => section.name.startsWith("tool:firecrawl_")), sections.map((s) => s.name).join(", "));
check("prompt sections take the web-fetch slot order", sections.every((section) => section.order === TOOL_WEB_FETCH_ORDER), sections.map((s) => `${s.name}@${s.order}`).join(", "));
check("prompt text is resolved per assembly", sections.every((section) => typeof section.text === "function"));

// No count baked into a registered description: the schema is built once, the
// page can change the value any time, so a number here would go stale.
check("tool descriptions carry no baked-in default count", registered.every(({ def }) => !/default \d/.test(def.description)));

// Per-tool switches are the second half of "enable/disable": the bundle stays
// mounted and one declaration leaves the schema list. They are step-time `when`
// conditions now, so flipping the live reference must be enough — no rebuild.
{
  const { ctx: partialCtx, registered: partialRegistered, sections: partialSections } = makeCtx();
  const partial = Config({ scrape: false, crawl: false, checkCrawlStatus: false });
  apply(partialCtx, partial);
  const switched = partialRegistered.map(({ def, options }) => ({ name: def.name, at: options.when }));
  check("all seven tools stay registered when three are switched off", switched.length === 7, switched.map((entry) => entry.name).join(", "));
  const at = (toolName) => switched.find((entry) => entry.name === toolName)?.at({ agent: { id: "a" }, signal: AbortSignal.abort() });
  check("switched-off tools report inactive per step",
    at("firecrawl_scrape") === false && at("firecrawl_crawl") === false && at("firecrawl_check_crawl_status") === false);
  check("switched-on tools report active per step", at("firecrawl_search") === true && at("firecrawl_map") === true);
  const offText = partialSections.find((section) => section.name === "tool:firecrawl_scrape");
  check("switched-off tool drops its prompt text", offText?.text() === "");
  const onText = partialSections.find((section) => section.name === "tool:firecrawl_search");
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
  const switched = liveRegistered.find((entry) => entry.def.name === "firecrawl_search").options.when;
  const before = switched({ agent: { id: "a" }, signal: AbortSignal.abort() });
  cosmokit.updateVolatile(live.search, cosmokit.createVolatile(false));
  const after = switched({ agent: { id: "a" }, signal: AbortSignal.abort() });
  check("a live reference change reaches the switch", before === true && after === false, `${before} -> ${after}`);

  // The count defaults and the base URL are read per call for the same reason.
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => JSON.stringify({ success: true, links: ["http://a"] }) };
  };
  try {
    const { ctx: capCtx, registered: capRegistered } = makeCtx();
    const capped = Config({});
    apply(capCtx, capped);
    const mapTool = capRegistered.find((entry) => entry.def.name === "firecrawl_map").def;
    cosmokit.updateVolatile(capped.apiUrl, cosmokit.createVolatile("http://mirror.local"));
    cosmokit.updateVolatile(capped.mapMaxResults, cosmokit.createVolatile(7));
    let sent;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return realFetch(url, init);
    };
    await mapTool.execute({ url: "https://example.com" }, { signal: AbortSignal.timeout(5000) });
    check("a renamed apiUrl reaches the next request", sent?.url === "http://mirror.local/v1/map", sent?.url);
    check("an edited count default reaches the next request", sent?.body?.limit === 7, JSON.stringify(sent?.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// A count the page blanks after mount must fail with a message naming the page,
// not with a request that carries `limit: NaN`.
{
  const cosmokit = await import("@deepseek-ai/cosmokit");
  const { ctx: badCtx, registered: badRegistered } = makeCtx();
  const bad = Config({});
  apply(badCtx, bad);
  cosmokit.updateVolatile(bad.searchMaxResults, cosmokit.createVolatile(0));
  const searchTool = badRegistered.find((entry) => entry.def.name === "firecrawl_search").def;
  let message;
  try {
    await searchTool.execute({ query: "x" }, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    message = String(error.message);
  }
  check("an invalid count fails with the fix in the message",
    typeof message === "string" && message.includes("searchMaxResults") && message.includes("configuration page"), message);
}

// The credential seam is preferred over the environment, and a key from either
// source must reach the request as a bearer token.
{
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers?.authorization);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { markdown: "# hi" } }), text: async () => "{}" };
  };
  try {
    const { ctx: seamToolCtx, registered: seamTools } = makeCtx();
    seamToolCtx.get = (service) => (service === "credentials" ? { resolve: async (ref) => (ref === "FIRECRAWL_API_KEY" ? { value: "fc-from-store" } : undefined) } : undefined);
    apply(seamToolCtx, Config({}));
    const scrapeTool = seamTools.find((entry) => entry.def.name === "firecrawl_scrape").def;
    await scrapeTool.execute({ url: "https://example.com" }, { signal: AbortSignal.timeout(5000) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("credential store key becomes a bearer token", seen[0] === "Bearer fc-from-store", String(seen[0]));
}

// The same seam, after the page renames the reference: the next call must resolve
// the new name through the store instead of the old one.
{
  const store = { FIRECRAWL_API_KEY: "fc-old", FIRECRAWL_MIRROR_KEY: "fc-new" };
  const tokens = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    tokens.push(init?.headers?.authorization);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { markdown: "# hi" } }), text: async () => "{}" };
  };
  try {
    const cosmokit = await import("@deepseek-ai/cosmokit");
    const live = Config({});
    const { ctx: renameToolCtx, registered: renameTools } = makeCtx();
    renameToolCtx.get = (service) => (service === "credentials" ? {
      resolve: async (ref) => (store[ref] === undefined ? undefined : { value: store[ref] })
    } : undefined);
    apply(renameToolCtx, live);
    const scrapeTool = renameTools.find((entry) => entry.def.name === "firecrawl_scrape").def;
    await scrapeTool.execute({ url: "https://example.com" }, { signal: AbortSignal.timeout(5000) });
    cosmokit.updateVolatile(live.apiKeyEnv, cosmokit.createVolatile("FIRECRAWL_MIRROR_KEY"));
    await scrapeTool.execute({ url: "https://example.com" }, { signal: AbortSignal.timeout(5000) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("a live reference rename re-resolves the credential", tokens[0] === "Bearer fc-old" && tokens[1] === "Bearer fc-new", tokens.join(" -> "));
}

if (!LIVE) {
  console.log(`\n${failures === 0 ? "OFFLINE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log("Set FIRECRAWL_SMOKE_LIVE=1 to also run the tools against the instance.");
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 4. Live instance
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
