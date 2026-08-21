// Client-half smoke test: load the bundle factory in a fake module-system
// environment and drive apply() + the slot registration to verify the panel
// wiring, without a real browser.
import { readFileSync } from "node:fs";

const code = readFileSync("D:/git/deepseek-tools/dsh-build-panel/lib/client.js", "utf8");

// --- fake environment ------------------------------------------------
let capturedRegistration = null;

function fakeReact() {
  const createElement = (type, props, ...children) => {
    return { type, props: props ?? {}, children };
  };
  const Fragment = Symbol("Fragment");
  return {
    createElement,
    Fragment,
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn
  };
}

const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) {}, appendChild() {} }),
  head: { appendChild() {} }
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

// fetch stub: capture browse RPCs and answer with a minimal list payload.
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, method: body.method, args: body.payload.args, rpcId: body.rpcId });
  const value = body.method === "buildPanel/list"
    ? { type: "list", tasks: [] }
    : { type: "overview", id: body.payload.args.id, index: "", plan: "p", todos: [], finish: [], plans: [], archiveTail: "" };
  return {
    ok: true,
    json: async () => ({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } })
  };
};

// Evaluate the bundle: it should register via __ModuleLoader__.load
new Function("window", "document", "require", code)(window, fakeDocument, (spec) => {
  if (spec === "react") return fakeReact();
  throw new Error("unexpected require: " + spec);
});

console.log("load calls:", loadCalls.length);
const reg = loadCalls[0];
console.log("bundle id:", reg.id);
const exports = reg.factory((spec) => {
  if (spec === "react") return fakeReact();
  throw new Error("unexpected require: " + spec);
});

console.log("inject:", JSON.stringify(exports.inject));

// --- drive apply with a fake ctx -------------------------------------
const slotRegistrations = [];
const remote = {
  commands: {
    async execute(sessionId, line, images) {
      return { ok: true, value: { result: { kind: "success", text: JSON.stringify({ type: "run", id: "8978", ok: true }) } } };
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
const el = fakeReact().createElement;
const rendered = r.component({
  useSessions: (sel) => sel({ current: "session-abc" }),
  remote
});
console.log("rendered type:", typeof rendered.type === "function" ? "function" : String(rendered.type));
console.log("smoke OK");
