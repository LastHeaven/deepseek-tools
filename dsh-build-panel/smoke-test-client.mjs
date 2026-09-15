// Client-half smoke test: load the bundle factory in a fake module-system
// environment, drive apply() through the slot registration, and then render the
// panel with a miniature stateful React so the real click path can be walked:
// open the panel → pick a task → "执行此任务" / "执行 commit".
import { readFileSync } from "node:fs";

const code = readFileSync("D:/git/deepseek-tools/dsh-build-panel/lib/client.js", "utf8");

// --- miniature React -------------------------------------------------
// Enough of the hook contract to re-render the panel on state changes: hooks
// are keyed by their component path + call index, effects run on mount only.
function createReact() {
  const Fragment = Symbol("Fragment");
  const hooks = new Map();
  const cleanups = [];
  let path = "";
  let index = 0;
  let dirty = false;

  function hookKey() {
    return path + "#" + index++;
  }

  function useState(init) {
    const key = hookKey();
    if (!hooks.has(key)) hooks.set(key, typeof init === "function" ? init() : init);
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
    const key = hookKey();
    if (hooks.has(key + "$effect")) return;
    hooks.set(key + "$effect", true);
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }

  function useRef(init) {
    const key = hookKey();
    if (!hooks.has(key)) hooks.set(key, { current: init });
    return hooks.get(key);
  }

  function useCallback(fn) {
    hookKey();
    return fn;
  }

  const impl = {
    Fragment,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState,
    useEffect,
    useLayoutEffect: useEffect,
    useRef,
    useCallback
  };

  /** Render one node tree, resolving function components and Fragments. */
  function renderNode(node, nodePath) {
    if (node === null || node === void 0 || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) {
      return node.map((child, i) => renderNode(child, nodePath + "." + i)).filter((child) => child !== null);
    }
    const { type, props, children } = node;
    if (type === Fragment) {
      return children.map((child, i) => renderNode(child, nodePath + "." + i)).filter((child) => child !== null);
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
      children: children.map((child, i) => renderNode(child, nodePath + "." + i)).filter((child) => child !== null)
    };
  }

  return {
    impl,
    render: (element) => {
      path = "";
      index = 0;
      return renderNode(element, "root");
    },
    isDirty: () => dirty,
    clearDirty: () => {
      dirty = false;
    },
    dispose: () => {
      while (cleanups.length > 0) cleanups.pop()();
    }
  };
}

/** All text inside an element, concatenated. */
function textOf(node) {
  if (node === null || node === void 0) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children || []).map(textOf).join("");
}

/** Depth-first search for the first node matching a predicate. */
function find(node, predicate) {
  if (node === null || typeof node !== "object") return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.children || [];
  for (const child of children) {
    const hit = find(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every node matching a predicate, in document order. */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== "object") return out;
  const children = Array.isArray(node) ? node : node.children || [];
  if (!Array.isArray(node) && predicate(node)) out.push(node);
  for (const child of children) findAll(child, predicate, out);
  return out;
}

const buttonNamed = (label) => (node) => node.type === "button" && textOf(node).trim() === label;
const wantsLabel = (needle) => (node) => textOf(node).includes(needle);

// --- fake environment ------------------------------------------------
let capturedRegistration = null;

const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) {}, appendChild() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {}
};

const loadCalls = [];
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      loadCalls.push(reg);
    }
  }
};
globalThis.document = fakeDocument;

// fetch stub: capture browse RPCs and answer with one task plus its overview.
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, method: body.method, args: body.payload.args, rpcId: body.rpcId });
  const value = body.method === "buildPanel/list"
    ? { type: "list", tasks: [{ id: "8978", planExists: true, planMtime: Date.now(), todoCount: 1, finishCount: 0, plansCount: 0 }] }
    : { type: "overview", id: body.payload.args.id, index: "", plan: "p", todos: [{ file: "a.md", status: "待办" }], finish: [], plans: [], archiveTail: "" };
  return {
    ok: true,
    json: async () => ({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } })
  };
};

// Evaluate the bundle: it should register via __ModuleLoader__.load
const react = createReact();
new Function("window", "document", "require", code)(window, fakeDocument, (spec) => {
  if (spec === "react") return react.impl;
  throw new Error("unexpected require: " + spec);
});

console.log("load calls:", loadCalls.length);
const reg = loadCalls[0];
console.log("bundle id:", reg.id);
const exports = reg.factory((spec) => {
  if (spec === "react") return react.impl;
  throw new Error("unexpected require: " + spec);
});

console.log("inject:", JSON.stringify(exports.inject));

// --- drive apply with a fake ctx -------------------------------------
const slotRegistrations = [];
const commandLines = [];
const remote = {
  commands: {
    async execute(sessionId, line, images) {
      commandLines.push({ sessionId, line, images });
      const [, id, sub] = /^\/build (\S+) (\S+)$/u.exec(line) ?? [];
      return { ok: true, value: { result: { kind: "success", text: JSON.stringify({ type: sub, id, ok: true }) } } };
    }
  }
};
// apply uses ctx.slots (declared inject) and ctx.remote
const slotsService = {
  inject(slotName, cb) {
    console.log("slots.inject:", slotName);
    cb();
  },
  register(opts, component) {
    slotRegistrations.push({ opts, component });
    return () => {};
  }
};
const ctx = {
  get(name) {
    if (name === "slots") return slotsService;
    if (name === "remote") return remote;
    return undefined;
  },
  slots: slotsService,
  remote
};

exports.apply(ctx);
console.log("slot registrations:", slotRegistrations.length);
const r = slotRegistrations[0];
console.log("slot name:", r.opts.name, "| id:", r.opts.id);

// --- render the registered component with a fake useSessions ----------
let tree = react.render(r.component({
  useSessions: (sel) => sel({ current: "session-abc" }),
  remote
}));
const badge = find(tree, buttonNamed("Build 工作流"));
if (badge === null) throw new Error("panel badge not rendered");
console.log("badge rendered:", textOf(badge).trim());

/** Re-render until the async browse promises settle. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    react.clearDirty();
    tree = react.render(r.component({
      useSessions: (sel) => sel({ current: "session-abc" }),
      remote
    }));
  }
}

// 1. open the panel and wait for the task list
badge.props.onClick();
await settle();
if (fetchCalls.filter((c) => c.method === "buildPanel/list").length !== 1) throw new Error("panel did not request the task list");
const taskBadge = find(tree, (node) => node.type === "button" && textOf(node).startsWith("任务 8978"));
if (taskBadge === null) throw new Error("task badge not rendered after opening the panel");
console.log("list rendered:", textOf(taskBadge).trim().replace(/\s+/gu, " "));

// 2. open the task detail and wait for the overview
taskBadge.props.onClick();
await settle();
const buttons = findAll(tree, (node) => node.type === "button").map((node) => textOf(node).trim());
console.log("detail buttons:", buttons.join(" | "));

const runButton = find(tree, buttonNamed("执行此任务"));
const commitButton = find(tree, buttonNamed("执行 commit"));
if (runButton === null) throw new Error("执行此任务 button missing");
if (commitButton === null) throw new Error("执行 commit button missing");

// the new button must sit immediately after 执行此任务 in the same action row
const actionRow = find(tree, (node) => node.props?.className === "bp_actions");
const labels = (actionRow?.children ?? []).map((node) => textOf(node).trim());
console.log("action row:", labels.join(" | "));
if (labels.indexOf("执行 commit") !== labels.indexOf("执行此任务") + 1) {
  throw new Error("执行 commit is not right after 执行此任务: " + labels.join(","));
}

// 3. clicking the commit button drives `/build <任务号> commit`
commitButton.props.onClick();
await settle();
console.log("command lines:", JSON.stringify(commandLines));
if (commandLines.length !== 1) throw new Error("expected exactly one command invocation, got " + commandLines.length);
if (commandLines[0].line !== "/build 8978 commit") throw new Error("unexpected command line: " + commandLines[0].line);
if (commandLines[0].sessionId !== "session-abc") throw new Error("wrong session id: " + commandLines[0].sessionId);
if (commandLines[0].images.length !== 0) throw new Error("command must not carry attachments");
const doneNote = find(tree, wantsLabel("commit 提交流程"));
if (doneNote === null) throw new Error("commit result note not rendered");
console.log("done note:", textOf(doneNote).trim());

react.dispose();
console.log("smoke OK");
