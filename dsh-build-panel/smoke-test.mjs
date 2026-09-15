import { apply, name, inject } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-build-panel/lib/index.js";
import { remoteMethods } from "file:///C:/Users/hxy/.dsh/profiles/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js";
import { Context } from "file:///C:/Users/hxy/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Deployed package directory; the fixture lives inside it so bare `@deepseek-ai/*` imports resolve. */
const PLUGIN_DIR = "C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-build-panel";
/** Throwaway copy of the host half used to exercise its bundled commit.md. */
const FIXTURE_DIR = join(PLUGIN_DIR, ".smoke-fixture");

// --- fake environment ------------------------------------------------
const registered = [];
const followups = [];
const ctx = new Context();
ctx.provide("commands", {
  register(def) {
    registered.push(def);
    return () => {};
  }
});
ctx.provide("sessions", {
  get(id) {
    if (id !== "test-session") return undefined;
    return { header: { cwd: "F:/work/manager-frontend" } };
  }
});

apply(ctx);
console.log("name:", name, "| inject:", JSON.stringify(inject));
console.log("registered:", registered.map((d) => d.name).join(", "));

// The browse service must be live and carry its Remote markers.
const svc = ctx.get("buildPanel");
if (svc === undefined) throw new Error("buildPanel service was not registered");
const markers = remoteMethods(svc).map((m) => m.method).sort();
console.log("buildPanel Remote methods:", markers.join(", "));
if (markers.join(",") !== "list,overview") throw new Error("unexpected Remote marker set");

const def = registered.find((d) => d.name === "build");
if (def === undefined) throw new Error("/build command missing");

// fake agent
const agent = {
  session: { header: { cwd: "F:/work/manager-frontend" } },
  followup(msg) { followups.push(msg); }
};

// 1. browse list — direct service call, no session events, no followups
const list = await svc.list("test-session");
console.log("\n[list] type:", list.type, "| tasks:", list.tasks.length);
const ids = list.tasks.map((t) => t.id + "@" + Math.round(t.planMtime ?? -1));
console.log("[list] order:", ids.slice(0, 4).join(" -> "));
const firstMtime = list.tasks[0].planMtime;
for (const t of list.tasks) {
  if (t.planMtime !== null && t.planMtime > firstMtime) throw new Error("list not sorted newest-plan-first");
}
console.log("[list] tasks without plan:", list.tasks.filter((t) => t.planMtime === null).length);

// 2. browse overview
const ov = await svc.overview("test-session", "8978");
console.log("\n[overview] type:", ov.type, "| id:", ov.id, "| todos:", ov.todos.length, "| plan len:", ov.plan.length);
let overviewThrew = false;
try { await svc.overview("test-session", "no-such-dir-xyz"); } catch (e) { overviewThrew = true; console.log("[overview] missing dir fails loud:", e.message); }
if (!overviewThrew) throw new Error("overview of missing dir must throw");

// 3. drive plane: /build <id> run
const run = await def.handler({ agent, rawInput: "8978 run", attachments: [] });
console.log("\n[run] kind:", run.kind, "| text:", run.text);
console.log("[followups]:", followups.length, "| head:", followups[0]?.content[0]?.text.slice(0, 120));

// 4. drive plane rejects browse-shaped input now
const bare = await def.handler({ agent, rawInput: "", attachments: [] });
console.log("\n[bare /build] kind:", bare.kind, "| text:", bare.text);
const ovSub = await def.handler({ agent, rawInput: "8978 overview", attachments: [] });
console.log("[overview subcommand] kind:", ovSub.kind, "| text:", ovSub.text);

// 5. commit plane: the instruction body comes from the plugin's own bundled
// commit.md, resolved relative to the host module's own location.
const before = followups.length;
const commit = await def.handler({ agent, rawInput: "8978 commit", attachments: [] });
console.log("\n[commit] kind:", commit.kind, "| text:", commit.text);
if (commit.kind !== "success") throw new Error("commit plane failed: " + commit.text);
if (followups.length !== before + 1) throw new Error("commit plane queued no followup");
const commitText = followups.at(-1).content[0].text;
console.log("[commit] first line:", JSON.stringify(commitText.split("\n")[0]));
// The body is sent verbatim: it must start at the template's own opening block
// (no host-injected preamble) and already read as plain instructions.
if (commitText.startsWith("> ") || !commitText.startsWith("## 第1步：代码检查")) {
  throw new Error("template must lead, with no preamble: " + JSON.stringify(commitText.slice(0, 60)));
}
if (!commitText.includes("先执行 `git diff --cached` 和 `git diff`")) throw new Error("step 1 must tell the model to run the diffs itself");
if (commitText.includes("!`")) throw new Error("opencode inline-exec syntax must not remain in the prompt");
if (!commitText.includes("cx/trip#任务号")) throw new Error("bundled commit.md body missing from instruction");
if (commitText.includes("description: 根据 git diff")) throw new Error("frontmatter was not stripped");
if (/^## 当前任务\s*\n\s*8978\s*$/mu.exec(commitText) === null) throw new Error("$1 was not bound to the task id");
if (commitText.includes("$1")) throw new Error("$1 placeholder survived unbound");
console.log("[commit] tail:", JSON.stringify(commitText.trimEnd().split("\n").slice(-1)[0]));

// The prompt must not leak a host filesystem path: no drive letter, no user
// profile, no package directory.
for (const leak of ["C:\\", "C:/", "D:\\", "D:/", "Users\\", "Users/", "node_modules", "@deepseek-ai", "commit.md"]) {
  if (commitText.includes(leak)) throw new Error(`host path leaked into the prompt via "${leak}"`);
}
console.log("[commit] no host path in prompt: OK");

// 6. A package whose commit.md is missing reports a clear, path-free error.
mkdirSync(join(FIXTURE_DIR, "lib"), { recursive: true });
cpSync(join(PLUGIN_DIR, "lib", "index.js"), join(FIXTURE_DIR, "lib", "index.js"));
writeFileSync(join(FIXTURE_DIR, "package.json"), JSON.stringify({
  name: "@deepseek-ai/dsh-build-panel-smoke",
  type: "module",
  main: "lib/index.js"
}, null, 2), "utf8");
const fixture = await import(pathToFileURL(join(FIXTURE_DIR, "lib", "index.js")).href);
const fixtureCtx = new Context();
let fixtureDef;
fixtureCtx.provide("commands", { register(d) { fixtureDef = d; return () => {}; } });
fixtureCtx.provide("sessions", { get: () => undefined });
fixture.apply(fixtureCtx);
const missing = await fixtureDef.handler({ agent, rawInput: "8978 commit", attachments: [] });
console.log("\n[commit without commit.md] kind:", missing.kind, "| text:", missing.text);
if (missing.kind !== "error") throw new Error("a missing bundled commit.md must fail loud");
if (!missing.text.includes("无法读取插件内置的 commit.md")) throw new Error("unexpected message: " + missing.text);
if (missing.text.includes(FIXTURE_DIR.replace(/\//gu, "\\"))) throw new Error("error message leaked the package path");
if (followups.length !== before + 1) throw new Error("failed commit plane must not queue a followup");
rmSync(FIXTURE_DIR, { recursive: true, force: true });

console.log("\nsmoke OK");
