import { apply, name, inject } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-build-panel/lib/index.js";
import { remoteMethods } from "file:///C:/Users/hxy/.dsh/profiles/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js";
import { Context } from "file:///C:/Users/hxy/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js";

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

console.log("\nsmoke OK");
