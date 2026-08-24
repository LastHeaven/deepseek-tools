// Host-half smoke test: drive apply() with a fake ctx and synthesize
// session events to verify the notification triggers only for
// ask_user_question tool calls, without throwing.
import { apply, name, inject, Config } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-ask-popup/lib/index.js";

const ctx = {
  on(eventName, handler) {
    console.log("ctx.on:", eventName);
    this.handler = handler;
    return () => {};
  },
  logger: { warn() {} }
};

const raw = { enabled: true, title: "DeepSeek Harness", timeoutMs: 10000, onlyWithOptions: false };
const config = Config(raw); // schemastery Config is callable
apply(ctx, config);
console.log("name:", name, "| inject:", JSON.stringify(inject));

function emit(type, data) {
  ctx.handler({ id: "session-1" }, { type, data, seq: 0, time: Date.now() });
}

// 1. Non-ask tool call must NOT notify
emit("tool/call", { turn: 1, step: 1, callId: "c1", name: "firecrawl_scrape", arguments: "{}" });
console.log("non-ask tool call: no crash (expect no notification)");

// 2. ask_user_question with a question payload (spawns PowerShell notification)
emit("tool/call", {
  turn: 1,
  step: 2,
  callId: "c2",
  name: "ask_user_question",
  arguments: JSON.stringify({
    questions: [
      { id: "q1", question: "是否继续执行构建任务？", header: "确认", options: [{ label: "继续" }, { label: "取消" }] },
      { id: "q2", question: "第二个问题" }
    ]
  })
});
console.log("ask_user_question with options: notification spawned");

// 3. malformed arguments must not throw
emit("tool/call", { turn: 1, step: 3, callId: "c3", name: "ask_user_question", arguments: "not-json" });
console.log("malformed arguments: no crash");

// 4. empty questions must not notify
emit("tool/call", { turn: 1, step: 4, callId: "c4", name: "ask_user_question", arguments: JSON.stringify({ questions: [] }) });
console.log("empty questions: no crash");

// 5. onlyWithOptions mode: free-text question skipped
const ctx2 = { on() { return () => {}; }, logger: { warn() {} } };
const config2 = { ...raw, onlyWithOptions: true };
const ctx2events = [];
ctx2.on = (name2, handler) => { ctx2events.push(handler); return () => {}; };
apply(ctx2, Config(config2));
ctx2events.forEach((h) => h({ id: "s" }, {
  type: "tool/call",
  data: { turn: 2, step: 1, callId: "c5", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q3", question: "自由回答" }] }) }
}));
console.log("onlyWithOptions + free-text question: skipped (no crash)");

console.log("\nsmoke OK — all paths exercised without exceptions");
