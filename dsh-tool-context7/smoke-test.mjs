// Smoke test for the installed dsh-tool-context7 plugin.
// Imports the installed copy by absolute path, drives apply() with a fake ctx,
// and runs each tool's execute() against the live Context7 REST API.
const PLUGIN = "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-context7/lib/index.js";
const { apply, name, inject } = await import(PLUGIN);

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
};

const config = {
  apiUrl: "https://context7.com/api",
  apiKey: "ctx7sk-90fc9345-ecb1-4c89-9470-d4d3684b0c0e",
  resolveLibraryId: true, queryDocs: true,
  timeoutMs: 60000, maxOutputChars: 200000,
};

apply(ctx, config);
console.log("plugin name:", name, "| inject:", JSON.stringify(inject));
console.log("registered tools:", registered.map((t) => t.name).join(", "));

const signal = AbortSignal.timeout(30000);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

async function run(label, toolName, args) {
  const def = byName[toolName];
  if (!def) { console.log(`FAIL ${label}: ${toolName} not registered`); return; }
  try {
    const out = await def.execute(args, { signal });
    console.log(`\n=== ${label} OK ===`);
    console.log(String(out).slice(0, 700));
  } catch (e) {
    console.log(`\n=== ${label} FAIL: ${e.message} ===`);
  }
}

await run("resolve_library_id", "context7_resolve_library_id", { query: "react hooks", libraryName: "React" });
await run("query_docs", "context7_query_docs", { libraryId: "/vercel/next.js", query: "useEffect cleanup function examples" });
