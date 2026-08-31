// Smoke test for dsh-tool-jenkins.
// Imports the INSTALLED copy from the profile node_modules (peer deps resolve
// there), drives apply() with a fake ctx, and runs each tool's execute()
// against the live Jenkins at http://192.168.2.203:8080/jenkins (2.150.2,
// security enabled; anonymous reads return 403, so authed paths need
// JENKINS_USER/JENKINS_TOKEN env credentials).
const PLUGIN = "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-jenkins/lib/index.js";
const { apply, name, inject, hasAuth } = await import(PLUGIN);

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
};

const username = process.env.JENKINS_USER || "";
const apiToken = process.env.JENKINS_TOKEN || "";

const config = {
  apiUrl: process.env.JENKINS_URL || "http://192.168.2.203:0/jenkins".replace(":0", ":8080"),
  username,
  apiToken,
  listJobs: true, getJob: true, buildStatus: true, consoleOutput: true,
  triggerBuild: true, queueItem: true, nodes: true,
  timeoutMs: 30000, maxOutputChars: 200000,
};

apply(ctx, config);
console.log("plugin name:", name, "| inject:", JSON.stringify(inject), "| auth:", hasAuth(config) ? "yes" : "anonymous");
console.log("registered tools:", registered.map((t) => t.name).join(", "));

const signal = AbortSignal.timeout(45000);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

async function run(label, toolName, args) {
  const def = byName[toolName];
  if (!def) { console.log(`FAIL ${label}: ${toolName} not registered`); return; }
  try {
    const out = await def.execute(args, { signal });
    console.log(`\n=== ${label} OK ===`);
    console.log(String(out).slice(0, 900));
  } catch (e) {
    console.log(`\n=== ${label} FAIL: ${e.message} ===`);
  }
}

await run("nodes", "jenkins_nodes", {});
await run("list_jobs", "jenkins_list_jobs", { recursive: false });
await run("list_jobs_recursive", "jenkins_list_jobs", { recursive: true });
await run("get_job (no such job -> expect 404 error)", "jenkins_get_job", { job: "definitely-not-a-job-xyz" });
await run("build_status (no such job -> expect 404 error)", "jenkins_build_status", { job: "definitely-not-a-job-xyz" });
await run("console_output (no such job -> expect 404 error)", "jenkins_console_output", { job: "definitely-not-a-job-xyz" });
await run("trigger_build (anonymous -> expect clear auth error)", "jenkins_trigger_build", { job: "definitely-not-a-job-xyz" });
await run("queue_item (bogus id)", "jenkins_queue_item", { id: 999999999 });

console.log("\nDone. Authed paths (list/get/status/console/trigger) will pass only with JENKINS_USER/JENKINS_TOKEN set.");
