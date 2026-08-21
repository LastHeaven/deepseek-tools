import { apply, name, inject } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-build-panel/lib/index.js";

const registered = [];
const followups = [];
const ctx = {
  commands: {
    register(def) {
      registered.push(def);
      return () => {};
    }
  }
};

apply(ctx);
console.log("name:", name, "| inject:", JSON.stringify(inject));
console.log("registered:", registered.map((d) => d.name).join(", "));

const def = registered.find((d) => d.name === "build");
const sessionId = "test-session";

// fake agent
const agent = {
  session: { header: { cwd: "F:/work/manager-frontend" } },
  followup(msg) { followups.push(msg); }
};

// 1. list
const list = await def.handler({ agent, rawInput: "", attachments: [] });
console.log("\n[list] kind:", list.kind);
console.log("[list] head:", list.text.slice(0, 200));

// 2. overview
const ov = await def.handler({ agent, rawInput: "8978", attachments: [] });
console.log("\n[overview] kind:", ov.kind);
const ovJson = JSON.parse(ov.text);
console.log("[overview] type:", ovJson.type, "| id:", ovJson.id, "| todos:", ovJson.todos.length, "| plan len:", ovJson.plan.length);

// 3. run
const run = await def.handler({ agent, rawInput: "8978 run", attachments: [] });
console.log("\n[run] kind:", run.kind);
console.log("[run] text:", run.text);
console.log("[followups]:", followups.length, "| head:", followups[0]?.content[0]?.text.slice(0, 120));
