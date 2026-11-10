// Smoke test for @deepseek-ai/dsh-build-panel.
//
// Drives both halves of the package without the DSH loader and without a browser:
//
//   1. packaging — what makes it an installable, toggleable bundle
//   2. the Host half — buildPanel/list, buildPanel/overview, /build … run, and
//      teardown through a real Cordis fiber
//   3. the browser half — the module-system registration, then the real click
//      path (open the panel → pick a task → 执行此任务) against a miniature
//      stateful React
//
//   node smoke-test.mjs
//   BUILD_PANEL_PLUGIN=<file:///…/lib/index.js>   # test another copy
//
// It builds its own docs/ fixture in a temp directory, so it needs no workspace
// and writes nothing outside $TMPDIR.
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

// ---------------------------------------------------------------------------
// 0. Re-exec with the @deepseek-ai peers aliased
// ---------------------------------------------------------------------------

// The plugin's `@deepseek-ai/*` peers are NOT dependencies of this package: they
// belong to the harness that loads it. A plain dynamic `import()` of the module
// therefore fails with ERR_MODULE_NOT_FOUND, because bare-specifier resolution
// walks up from the module's REAL path — this checkout, which has no
// node_modules — and only the dsh installation and the profile have them.
//
// So resolve the peers the way the harness does and alias them for this process.
// `--import` only accepts a specifier and the alias must be installed before the
// loader resolves it, hence the re-exec. This runs FIRST, before any assertion
// prints, so a run reports each check exactly once.
const PEER_ALIAS = `
import { registerHooks, createRequire } from "node:module";
const require = createRequire(process.env.DSH_PEER_ANCHOR);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@deepseek-ai/")) {
      try { return { url: new URL("file:///" + require.resolve(specifier).replace(/\\\\/g, "/").replace(/^\\//, "")).href, shortCircuit: true }; }
      catch { /* fall through to the default resolver */ }
    }
    return nextResolve(specifier, context);
  }
});
`;

if (process.env.BUILD_PANEL_SMOKE_PEERS !== "1") {
  const dshRoot = process.env.BUILD_PANEL_DSH_ROOT
    ?? join(dirname(execFileSync("where", ["dsh"], { encoding: "utf8" }).split(/\r?\n/)[0].trim()), "node_modules", "@deepseek-ai", "dsh");
  const anchor = join(dshRoot, "package.json");
  if (!existsSync(anchor)) {
    console.log(`FAIL cannot locate the dsh installation to resolve @deepseek-ai peers (looked for ${anchor})`);
    console.log("Set BUILD_PANEL_DSH_ROOT to the dsh package directory and retry.");
    process.exit(1);
  }
  const aliasDir = join(HERE, ".smoke-peers");
  mkdirSync(aliasDir, { recursive: true });
  const aliasFile = join(aliasDir, "peers.mjs");
  writeFileSync(aliasFile, PEER_ALIAS, "utf8");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(aliasFile).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, DSH_PEER_ANCHOR: anchor, BUILD_PANEL_SMOKE_PEERS: "1" } }
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
// 1. Packaging: what makes this an installable, toggleable bundle
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

// The browser half: without these three, the panel never reaches the page.
check("declares a web client half", manifest.dsh?.client?.platform === "web", JSON.stringify(manifest.dsh?.client));
check("exports the client bundle", manifest.exports?.["./client"] === "./lib/client.js");
check("files ships the client bundle", (manifest.files ?? []).includes("lib/client.js"));
check(
  "client inject names the remotes and sidebar UI",
  (manifest.dsh?.client?.inject ?? []).includes("@deepseek-ai/dsh-api-remotes") &&
    (manifest.dsh?.client?.inject ?? []).includes("@deepseek-ai/dsh-client-ui-sidebar"),
  JSON.stringify(manifest.dsh?.client?.inject)
);
check("client inject never lists react (a seed word)", !(manifest.dsh?.client?.inject ?? []).includes("react"));

for (const language of ["en", "zh"]) {
  const file = join(HERE, "locale", `${language}.json`);
  check(`locale/${language}.json exists`, existsSync(file));
  if (!existsSync(file)) continue;
  const meta = JSON.parse(readFileSync(file, "utf8")).meta ?? {};
  check(`locale/${language}.json has meta.title`, typeof meta.title === "string" && meta.title.trim() !== "");
  check(`locale/${language}.json has meta.description`, typeof meta.description === "string" && meta.description.trim() !== "");
}

const patch = readFileSync(join(HERE, "cordis.patch.yml"), "utf8");
check("patch mounts the plugin by package name", patch.includes(`'${manifest.name}'`));
check("patch sets the build-panel id", /id:\s*build-panel/.test(patch));
check("patch inserts one row and does not ship a disabled state", (patch.match(/- id:/g) ?? []).length === 1 && !/^\s*disabled:/m.test(patch));
check("patch carries no config block (the plugin declares no Config)", !/^\s*config:/m.test(patch));

const icon = readFileSync(join(HERE, "icon.svg"), "utf8");
check("icon is a well-formed svg", /^<svg[\s>]/.test(icon.trim()) && icon.trim().endsWith("</svg>"), `${icon.length} bytes`);
check("icon stays under 256 KiB", Buffer.byteLength(icon) < 262144);

// A no-Config plugin must not export a Config schema: the Plugins page would
// otherwise show a configuration page for a row with nothing to configure.
const hostSource = readFileSync(join(HERE, "lib", "index.js"), "utf8");
check("host exports no Config schema", !/\bConfig\b/.test(hostSource.replace(/^\/\/.*$/gm, "")));

// ---------------------------------------------------------------------------
// 2. Fixture: a docs/ tree with a known order, statuses and counts
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), "bp-smoke-"));
const docs = join(root, "docs");

/** Write one file, creating its directory. */
async function put(relative, content) {
  const file = join(docs, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

const now = Date.now();
const MINUTE = 60 * 1000;

// 1002 has the newest plan, then 1004, then 1001; 1003 has no plan at all and so
// must sink to the tail. `not-a-task.md` is a file, not a directory, and must be
// skipped rather than reported as a task.
await put("1001/plan.md", "# plan 1001\n");
await put("1002/plan.md", "# plan 1002\n");
await put("1004/plan.md", "# plan 1004\n");
await put("1002/index.md", "# index 1002\n\nsrc/a.ts\n");
await put("1002/todo/a.md", "状态：待办\n做甲\n");
await put("1002/todo/b.md", "状态：已完成\n做乙\n");
await put("1002/finish/c.md", "状态：已完成\n做丙\n");
await put("1002/plans/2026-11-01.md", "旧计划\n");
await put(
  "1002/archive.md",
  ["", "| 时间 | 交接摘要 |", "| --- | --- |", "r1", "", "r2", "r3", "", "r4", "r5", "", "r6", "r7", ""].join("\n")
);
await put("1003/todo/x.md", "状态：待办\n做丁\n# 1003 没有 plan.md\n");
await put("not-a-task.md", "这里只是一个文件\n");

await utimes(join(docs, "1001", "plan.md"), now / 1000 - 300, now / 1000 - 300);
await utimes(join(docs, "1004", "plan.md"), now / 1000 - 200, now / 1000 - 200);
await utimes(join(docs, "1002", "plan.md"), now / 1000 - 60, now / 1000 - 60);

// ---------------------------------------------------------------------------
// 3. Host half: the browse service and the drive command
// ---------------------------------------------------------------------------

const { Context, Service } = await import("@deepseek-ai/cordis");
const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");

const pluginPath = process.env.BUILD_PANEL_PLUGIN
  ?? pathToFileURL(join(HERE, "lib", "index.js")).href;
const plugin = await import(pluginPath);

check("host exports a name", plugin.name === "build-panel", plugin.name);
check("host exports inject", JSON.stringify(plugin.inject) === JSON.stringify(["commands", "sessions"]), JSON.stringify(plugin.inject));
check("host exports apply", typeof plugin.apply === "function");

const ctx = new Context();
const registered = [];

// The fake registry is a real Cordis Service whose `register` is effect-based,
// exactly like `@deepseek-ai/dsh-commands`: that is the property that makes
// disabling the bundle remove the command, so a plain array stub would report a
// leak that does not exist. The traceable `this.ctx` binds the effect to the
// CALLING fiber, which is the mounting plugin.
class FakeCommands extends Service {
  constructor(context) {
    super(context, "commands");
  }
  register(definition) {
    return this.ctx.effect(() => {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    });
  }
}
new FakeCommands(ctx);

ctx.provide("sessions", {
  get(id) {
    return id === "test-session" ? { header: { cwd: root } } : undefined;
  }
});

// Mount through a real fiber so teardown is exercised, not just apply().
const fiber = ctx.plugin({ apply: plugin.apply, inject: plugin.inject, name: plugin.name });
await fiber;

const svc = ctx.get("buildPanel");
check("the buildPanel service is registered", svc !== undefined);
const methods = remoteMethods(svc).map((method) => method.method).sort();
check("the service exposes list and overview over the wire", methods.join(",") === "list,overview", methods.join(","));

check("one command is registered", registered.length === 1, `${registered.length}`);
const command = registered.find((definition) => definition.name === "build");
check("the command is /build", command !== undefined);
check("the command description omits commit", !/commit/.test(command.description), command.description);
check("the command hint omits commit", !/commit/.test(command.input.hint), command.input.hint);
check("the command advertises run", /\brun\b/.test(command.input.hint), command.input.hint);

// --- browse: list ---------------------------------------------------------
const list = await svc.list("test-session");
check("list reports its own type", list.type === "list", String(list.type));
check(
  "list orders newest plan first and sinks a plan-less task to the tail",
  list.tasks.map((task) => task.id).join(",") === "1002,1004,1001,1003",
  list.tasks.map((task) => task.id).join(",")
);
check("list skips a file under docs/", !list.tasks.some((task) => task.id === "not-a-task.md"));
const byId = Object.fromEntries(list.tasks.map((task) => [task.id, task]));
check("list reports plan presence", byId["1002"].planExists === true && byId["1003"].planExists === false);
check("list reports the plan mtime", typeof byId["1002"].planMtime === "number" && byId["1003"].planMtime === null);
check("list counts todo files", byId["1002"].todoCount === 2 && byId["1003"].todoCount === 1, JSON.stringify(byId["1002"]));
check("list counts finish files", byId["1002"].finishCount === 1);
check("list counts archived plans", byId["1002"].plansCount === 1);
check("list reports index presence", byId["1002"].indexExists === true && byId["1001"].indexExists === false);

// --- browse: overview -----------------------------------------------------
const overview = await svc.overview("test-session", "1002");
check("overview reports its own type", overview.type === "overview", String(overview.type));
check("overview carries the index", overview.index.includes("src/a.ts"));
check("overview carries the plan", overview.plan.includes("plan 1002"));
check("overview carries the archive tail", !overview.archiveTail.includes("r1"), JSON.stringify(overview.archiveTail));
check("overview truncates the archive to six lines", overview.archiveTail.split("\n").length === 6, overview.archiveTail);
check("overview lists todos with their status", JSON.stringify(overview.todos) === JSON.stringify([
  { file: "a.md", status: "待办" },
  { file: "b.md", status: "已完成" }
]), JSON.stringify(overview.todos));
check("overview lists finish and plans", overview.finish.join(",") === "c.md" && overview.plans.join(",") === "2026-11-01.md");

let missingThrew = null;
try { await svc.overview("test-session", "no-such-task"); } catch (error) { missingThrew = error.message; }
check("overview of a missing task fails loud", missingThrew !== null && missingThrew.includes("docs/no-such-task"), String(missingThrew));

let noSessionThrew = null;
try { await svc.list("no-such-session"); } catch (error) { noSessionThrew = error.message; }
check("a missing session fails loud", noSessionThrew !== null && noSessionThrew.includes("no-such-session"), String(noSessionThrew));

// --- drive: /build … run --------------------------------------------------
const followups = [];
const agent = {
  session: { header: { cwd: root } },
  followup(message) { followups.push(message); }
};
const run = await command.handler({ agent, rawInput: "1002 run", attachments: [] });
check("run succeeds", run.kind === "success", run.text);
check("run reports the task as JSON", JSON.stringify(JSON.parse(run.text)) === JSON.stringify({ type: "run", id: "1002", ok: true }), run.text);
check("run queues exactly one follow-up", followups.length === 1, `${followups.length}`);
const instruction = followups[0]?.content?.[0]?.text ?? "";
check("run resolves the steps against the task id",
  ["docs/1002/index.md", "docs/1002/plan.md", "docs/1002/todo/", "docs/1002/archive.md", "docs/1002/finish/", "docs/1002/plans/"]
    .every((path) => instruction.includes(path)),
  instruction.slice(0, 160));
check("run keeps the four numbered steps", (instruction.match(/^## \d\./gm) ?? []).length === 4, instruction);
check("run of a bare task adds no note", !instruction.includes("补充说明"));
check("run never carries attachments", followups[0].content.length === 1);

const noted = await command.handler({ agent, rawInput: "1001 run 先写测试再改代码", attachments: [] });
check("run forwards the extra note", noted.kind === "success" && followups[1].content[0].text.includes("补充说明：先写测试再改代码"));

// --- drive: rejections that must queue nothing ----------------------------
for (const [label, rawInput] of [
  ["a bare /build", ""],
  ["a task without run", "1002"],
  ["the removed overview subcommand", "1002 overview"],
  ["the removed commit subcommand", "1002 commit"]
]) {
  const before = followups.length;
  const rejected = await command.handler({ agent, rawInput, attachments: [] });
  check(`/build rejects ${label}`, rejected.kind === "error", rejected.text);
  check(`/build rejects ${label} without queueing`, followups.length === before, `${followups.length - before} queued`);
}

// --- teardown -------------------------------------------------------------
await fiber.dispose();
check("disposing the fiber unregisters the service", ctx.get("buildPanel") === undefined);
check("disposing the fiber unregisters the command", registered.length === 0, `${registered.length} left`);

await rm(root, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 4. Browser half: registration, then the real click path
// ---------------------------------------------------------------------------

const clientSource = readFileSync(process.env.BUILD_PANEL_CLIENT ?? join(HERE, "lib", "client.js"), "utf8");

let registration;
const loadCalls = [];
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(value) {}, appendChild() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {}
};
const fakeWindow = {
  __ModuleLoader__: {
    load(value) {
      loadCalls.push(value);
      registration = value;
    }
  }
};

// The bundle calls `window.__ModuleLoader__.load` at evaluation time; the fake
// module system is the only reason a `require` exists in this file.
new Function("window", "document", "require", clientSource)(fakeWindow, fakeDocument, (specifier) => {
  throw new Error(`unexpected top-level require(${specifier})`);
});

check("the client registers one module", loadCalls.length === 1, `${loadCalls.length}`);
check("the client module id is the package name", registration?.id === manifest.name, registration?.id);

// A miniature React: hooks are keyed by component path + call index, `useState`
// really drives a re-render, and `useEffect` really runs.
function createReact() {
  const hooks = new Map();
  const cleanups = [];
  let path = "";
  let index = 0;
  let dirty = false;

  const hookKey = () => `${path}#${index++}`;

  function useState(initial) {
    const key = hookKey();
    if (!hooks.has(key)) hooks.set(key, typeof initial === "function" ? initial() : initial);
    const set = (value) => {
      const current = hooks.get(key);
      const next = typeof value === "function" ? value(current) : value;
      if (next !== current) {
        hooks.set(key, next);
        dirty = true;
      }
    };
    return [hooks.get(key), set];
  }

  function useEffect(effect) {
    const key = `${hookKey()}$effect`;
    if (hooks.has(key)) return;
    hooks.set(key, true);
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }

  function useRef(initial) {
    const key = hookKey();
    if (!hooks.has(key)) hooks.set(key, { current: initial });
    return hooks.get(key);
  }

  function useCallback(fn) {
    hookKey();
    return fn;
  }

  // Mirror React by folding children into props as well: a component that reads
  // `props.children` would otherwise render empty and hide its own controls.
  const createElement = (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  };

  const react = {
    Fragment: Symbol("Fragment"),
    createElement,
    useState,
    useEffect,
    useLayoutEffect: useEffect,
    useRef,
    useCallback
  };

  function renderNode(node, nodePath) {
    if (node === null || node === void 0 || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) {
      return node.map((child, i) => renderNode(child, `${nodePath}.${i}`)).filter((child) => child !== null);
    }
    const { type, props, children } = node;
    if (type === react.Fragment) {
      return children.map((child, i) => renderNode(child, `${nodePath}.${i}`)).filter((child) => child !== null);
    }
    if (typeof type === "function") {
      const savedPath = path;
      const savedIndex = index;
      path = nodePath;
      index = 0;
      const out = type({ ...props, children });
      path = savedPath;
      index = savedIndex;
      return renderNode(out, nodePath);
    }
    return {
      type,
      props,
      children: children.map((child, i) => renderNode(child, `${nodePath}.${i}`)).filter((child) => child !== null)
    };
  }

  return {
    react,
    render(element) {
      path = "";
      index = 0;
      return renderNode(element, "root");
    },
    dispose() {
      while (cleanups.length > 0) cleanups.pop()();
    }
  };
}

/** All text inside a rendered node, concatenated. */
function textOf(node) {
  if (node === null || node === void 0) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
}

/** Depth-first search for the first node matching a predicate. */
function find(node, predicate) {
  if (node === null || typeof node !== "object") return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.children ?? [];
  for (const child of children) {
    const hit = find(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every node matching a predicate, in document order. */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (!Array.isArray(node) && predicate(node)) out.push(node);
  const children = Array.isArray(node) ? node : node.children ?? [];
  for (const child of children) findAll(child, predicate, out);
  return out;
}

const runtime = createReact();
const required = [];
const client = registration.factory((specifier) => {
  required.push(specifier);
  if (specifier === "react") return runtime.react;
  throw new Error(`unexpected require(${specifier})`);
});

check("the client requires only react", JSON.stringify(required) === JSON.stringify(["react"]), required.join(", "));
check("the client returns a plugin", typeof client?.apply === "function");
check("the client declares inject", JSON.stringify(client.inject) === JSON.stringify(["slots", "remote", "remote.commands"]), JSON.stringify(client.inject));

// --- the browse channel, stubbed -----------------------------------------
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, method: body.method, args: body.payload.args, rpcId: body.rpcId });
  const value = body.method === "buildPanel/list"
    ? {
        type: "list",
        tasks: [
          { id: "8978", indexExists: true, planExists: true, planMtime: Date.now(), todoCount: 1, finishCount: 0, plansCount: 0 },
          { id: "8711", indexExists: false, planExists: false, planMtime: null, todoCount: 0, finishCount: 0, plansCount: 0 }
        ]
      }
    : {
        type: "overview",
        id: body.payload.args.id,
        index: "",
        plan: "# plan for " + body.payload.args.id,
        todos: [{ file: "a.md", status: "待办" }],
        finish: [],
        plans: [],
        archiveTail: ""
      };
  return { ok: true, json: async () => ({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }) };
};

// --- the drive channel, stubbed ------------------------------------------
const commandLines = [];
const remote = {
  commands: {
    async execute(sessionId, line, images) {
      commandLines.push({ sessionId, line, images });
      return { ok: true, value: { result: { kind: "success", text: JSON.stringify({ type: "run", id: line.split(" ")[1], ok: true }) } } };
    }
  }
};

const slotRegistrations = [];
const slots = {
  inject(slotName, register) {
    check("the client injects into sidebar.footer.action", slotName === "sidebar.footer.action", slotName);
    register();
  },
  register(options, component) {
    slotRegistrations.push({ options, component });
    return () => {};
  }
};

client.apply({ slots, remote, get: (key) => (key === "slots" ? slots : key === "remote" ? remote : undefined) });

check("the client registers one slot entry", slotRegistrations.length === 1, `${slotRegistrations.length}`);
const entry = slotRegistrations[0];
check("the slot entry uses the build-panel id", entry.options.id === "build-panel", entry.options.id);
check("the slot entry injects the remote facade", typeof entry.options.inject === "function" && entry.options.inject().remote === remote);

// --- render and walk the click path --------------------------------------
// The real selector reads the Client `SessionListState` snapshot: the active
// Session is the one retained by `mainView`.
const sessionListState = {
  ids: ["session-abc"],
  byId: {
    "session-abc": { id: "session-abc", displayTitle: "abc", running: false, blank: false, updatedAt: 0, retainedBy: { mainView: 1 } },
    "session-idle": { id: "session-idle", displayTitle: "idle", running: false, blank: false, updatedAt: 0, retainedBy: {} }
  },
  phase: "ready",
  projectionsBySession: {}
};
const useSessions = (selector) => selector(sessionListState);

const badgeOf = (tree) => find(tree, (node) => node.type === "button" && textOf(node).trim().startsWith("Build 工作流"));

let tree = runtime.render(entry.component({ useSessions, remote }));
const badge = badgeOf(tree);
check("the footer badge renders", badge !== null);
// The disabled "无会话" variant is what a stale selector produces silently.
check("the badge resolves the current session", badge?.props.disabled !== true, textOf(badge));
check("the badge is not open yet", find(tree, (node) => node.type === "button" && textOf(node).trim() === "关闭") === null);

/** Re-render until the async browse promises settle. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = runtime.render(entry.component({ useSessions, remote }));
  }
}

// A disabled badge has no click handler, so the whole walk depends on the
// session resolving. Stop here with one clear failure instead of a stack trace
// from a missing handler.
if (typeof badge?.props.onClick !== "function") {
  console.log(`FAIL the badge cannot be opened — ${badge === null ? "not rendered" : textOf(badge).trim()}`);
  runtime.dispose();
  console.log(`\nfailures: ${failures + 1}`);
  console.log("SMOKE FAILED");
  process.exit(1);
}

badgeOf(tree).props.onClick();
await settle();
check("opening the panel requests the task list", fetchCalls.filter((call) => call.method === "buildPanel/list").length === 1,
  JSON.stringify(fetchCalls.map((call) => call.method)));
check("the list request carries the session id", fetchCalls[0].args.sessionId === "session-abc", JSON.stringify(fetchCalls[0].args));

const taskBadge = find(tree, (node) => node.type === "button" && textOf(node).startsWith("任务 8978"));
check("the task list renders a badge per task", taskBadge !== null);
check("the badge reports the plan and todo counts", textOf(taskBadge).includes("1 待办") && textOf(taskBadge).includes("有 plan"), textOf(taskBadge).trim());
check("a plan-less task says so", findAll(tree, (node) => node.type === "button").map(textOf).some((text) => text.includes("无 plan")));
check("the panel pages six per screen", textOf(tree).includes("共 2 个任务") || findAll(tree, (node) => node.type === "button").length >= 3);

taskBadge.props.onClick();
await settle();
check("opening a task requests its overview", fetchCalls.filter((call) => call.method === "buildPanel/overview").length === 1);
check("the overview request names the task", fetchCalls[1].args.id === "8978", JSON.stringify(fetchCalls[1].args));
check("the detail renders the plan", textOf(tree).includes("# plan for 8978"), textOf(tree).slice(0, 200));
check("the detail renders the pending todo", textOf(tree).includes("[待办] a.md"));

const runButton = find(tree, (node) => node.type === "button" && textOf(node).trim() === "执行此任务");
check("the detail offers 执行此任务", runButton !== null);
check("the removed commit button is gone", find(tree, (node) => node.type === "button" && textOf(node).includes("commit")) === null);

const actionRow = find(tree, (node) => node.props?.className === "bp_actions");
check("the action row holds only the two controls",
  (actionRow?.children ?? []).map((node) => textOf(node).trim()).join("|") === "返回列表|执行此任务",
  (actionRow?.children ?? []).map((node) => textOf(node).trim()).join("|"));

runButton.props.onClick();
await settle();
check("the run button drives exactly one command", commandLines.length === 1, JSON.stringify(commandLines));
check("the run button issues /build <task> run", commandLines[0]?.line === "/build 8978 run", commandLines[0]?.line);
check("the run button targets the panel's session", commandLines[0]?.sessionId === "session-abc", commandLines[0]?.sessionId);
check("the run button sends no attachments", commandLines[0]?.images.length === 0);
check("the panel confirms the hand-off", find(tree, (node) => node.type === "button" && textOf(node).trim() === "返回列表") !== null);
check("the settled panel names the agent", textOf(tree).includes("交给当前会话的 agent"), textOf(tree).slice(0, 200));

// Returning to the list must not re-request anything.
const backButton = find(tree, (node) => node.type === "button" && textOf(node).trim() === "返回列表");
backButton.props.onClick();
await settle(2);
check("returning to the list re-renders the tasks", find(tree, (node) => node.type === "button" && textOf(node).startsWith("任务 8978")) !== null);
check("no commit wording survives anywhere in the card", !textOf(tree).includes("commit"), textOf(tree));

runtime.dispose();

console.log(`\nfailures: ${failures}`);
console.log(failures === 0 ? "SMOKE OK" : "SMOKE FAILED");
process.exit(failures === 0 ? 0 : 1);
