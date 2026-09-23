// Smoke test for @deepseek-ai/dsh-tool-wecom.
//
// Drives the plugin's real `apply()` with a fake ctx whose `subprocess` service
// shells out to the real local wecom-cli, then exercises every tool's
// `execute()`. This validates plugin logic (argv construction, resolution,
// credential handling, rendering, exit classification) without restarting DSH.
//
// Usage: node smoke-test.mjs [path-to-lib-index.js]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] ?? join(here, "lib", "index.js");

const mod = await import(pathToFileURL(entry).href);
const { apply, name, inject } = mod;

console.log("plugin name:", name);
console.log("inject:", JSON.stringify(inject));

// ---------------------------------------------------------------------------
// Fake ctx factory: a real subprocess seam, an optional fake credentials
// service, and an optional fake jobs registry.
// ---------------------------------------------------------------------------

function makeHarness({ credentials, jobsEnabled = true } = {}) {
  const spawned = [];
  const children = new Set();
  const subprocess = {
    spawn(spec) {
      spawned.push(spec);
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.add(child);
      child.on("close", () => children.delete(child));
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const done = new Promise((res, rej) => {
        child.on("error", rej);
        child.on("close", (code, signal) => res({ exitCode: code, signal }));
      });
      const reader = (get) => ({ readFrom: (from) => ({ text: get().slice(from), lossy: false, nextOffset: get().length }) });
      return {
        done,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        terminate: () => child.kill()
      };
    }
  };

  const registered = new Map();
  const sections = [];
  const startedJobs = [];
  let authHooks;
  const ctx = {
    tools: { register(def) { registered.set(def.name, def); return () => {}; } },
    systemPrompt: { section(s) { sections.push(s); return () => {}; }, getSectionOrder: () => 140 },
    subprocess,
    get(key) {
      if (key === "credentials") return credentials;
      if (key === "jobs" && jobsEnabled) {
        return {
          start(spec) {
            const jobId = `wecom-auth-${startedJobs.length + 1}`;
            startedJobs.push({ jobId, spec });
            authHooks = spec.run();
            return jobId;
          }
        };
      }
      return undefined;
    }
  };
  const exec = { signal: AbortSignal.timeout(60_000), agent: { session: { header: { cwd: process.cwd() } } } };
  const call = async (tool, args) => {
    const def = registered.get(tool);
    if (!def) throw new Error(`tool ${tool} is not registered`);
    const value = await def.execute(args, exec);
    return def.output.render(args, value)[0].text;
  };
  return { ctx, registered, sections, spawned, startedJobs, call, authHooks: () => authHooks, killAll: () => { for (const c of children) { try { c.kill(); } catch {} } children.clear(); } };
}

// Config defaults are applied by the loader, not by apply(); mirror them here.
const baseConfig = {
  cliPath: "", nodePath: "", cwd: "",
  timeoutMs: 60000, maxOutputBytes: 512 * 1024, graceMs: 2000,
  configDir: "", tmpDir: "", logLevel: "",
  statusTool: true, runTool: true, schemaTool: true, authTool: true,
  allowAuthInit: true, prettyPrintJson: true,
  botId: "", botSecret: "", botIdEnv: "WECOM_CLI_BOT_ID", botSecretEnv: "WECOM_CLI_BOT_SECRET"
};

const show = (label, text) => console.log(`\n===== ${label} =====\n${String(text).slice(0, 1100)}`);
const expectThrow = async (label, fn) => {
  try {
    await fn();
    console.log(`\n!! ${label}: expected a throw, got success`);
  } catch (error) {
    console.log(`\n${label}: threw as expected -> ${error.message}`);
  }
};

// ===========================================================================
// Scenario 1: no credentials configured -> interactive scan path
// ===========================================================================
console.log("\n########## SCENARIO 1: no credentials configured ##########");
const h1 = makeHarness({ credentials: undefined });
apply(h1.ctx, { ...baseConfig });
console.log("tools registered:", [...h1.registered.keys()].join(", "));
console.log("systemPrompt sections:", h1.sections.map((s) => s.name).join(", "));

show("wecom_status", await h1.call("wecom_status", {}));
show("wecom_schema get identity.whoami", await h1.call("wecom_schema", { kind: "get", method: "identity.whoami" }));
show("wecom_run sessions list", await h1.call("wecom_run", { command: ["message", "aibot", "sessions", "list"] }));
show("wecom_run dry-run complex payload", await h1.call("wecom_run", {
  command: ["contact", "users", "search"],
  payload: { keywords: ["周报", 'a"b', "c&d|e", "f g"], limit: 3, search_mode: "list" },
  dryRun: true
}));
show("wecom_run usage error", await h1.call("wecom_run", { command: ["nosuch", "method"] }));
show("wecom_auth show", await h1.call("wecom_auth", { action: "show" }));
show("wecom_auth init (no creds -> background scan job)", await h1.call("wecom_auth", { action: "init", noBrowser: true }));
console.log("jobs started:", h1.startedJobs.length, h1.startedJobs.map((j) => j.jobId).join(","));
// The scan job's CLI polls for up to 5 minutes; kill it so the test can exit.
h1.killAll();

// Validation failures must throw before any process is spawned.
await expectThrow("empty command", () => h1.call("wecom_run", { command: [] }));
await expectThrow("whitespace segment", () => h1.call("wecom_run", { command: ["message aibot"] }));
await expectThrow("flag-like segment", () => h1.call("wecom_run", { command: ["--json"] }));
await expectThrow("array payload", () => h1.call("wecom_run", { command: ["doc", "search"], payload: [1, 2] }));
await expectThrow("bad set entry", () => h1.call("wecom_run", { command: ["doc", "search"], set: ["nope"] }));
await expectThrow("schema get without method", () => h1.call("wecom_schema", { kind: "get" }));

// ===========================================================================
// Scenario 2: LITERAL credentials in config -> direct non-interactive login
// ===========================================================================
console.log("\n########## SCENARIO 2: literal botId/botSecret in config ##########");
const LITERAL_SECRET = "literal-secret-abc123";
const h2 = makeHarness({ credentials: undefined });
apply(h2.ctx, { ...baseConfig, botId: "literal-bot-id", botSecret: LITERAL_SECRET });

const r2 = await h2.call("wecom_auth", { action: "init" });
show("wecom_auth init (literal creds)", r2);
console.log("\n!! secret leaked into output?", r2.includes(LITERAL_SECRET) ? "YES — BUG" : "no");
console.log("!! secret leaked into spawned argv (expected: yes, argv is the only channel)?",
  h2.spawned.some((s) => s.argv.includes(LITERAL_SECRET)) ? "yes (by design)" : "NO");
console.log("argv vectors:");
for (const s of h2.spawned) console.log("  ", JSON.stringify(s.argv.slice(1)));
console.log("jobs started (expect 0, no scan needed):", h2.startedJobs.length);

// ===========================================================================
// Scenario 3: credential REFERENCE resolved through ctx.credentials
// ===========================================================================
console.log("\n########## SCENARIO 3: credential reference via ctx.credentials ##########");
const REF_SECRET = "ref-secret-xyz789";
const resolvedRefs = [];
const fakeCredentials = {
  async resolve(ref) {
    resolvedRefs.push(String(ref));
    if (ref === "WECOM_CLI_BOT_ID") return { value: "ref-bot-id", source: "file" };
    if (ref === "WECOM_CLI_BOT_SECRET") return { value: REF_SECRET, source: "file" };
    return undefined;
  }
};
const h3 = makeHarness({ credentials: fakeCredentials });
apply(h3.ctx, baseConfig);
const r3 = await h3.call("wecom_auth", { action: "init" });
show("wecom_auth init (reference creds)", r3);
console.log("\nrefs resolved:", JSON.stringify(resolvedRefs));
console.log("!! secret leaked into output?", r3.includes(REF_SECRET) ? "YES — BUG" : "no");
console.log("argv vectors:");
for (const s of h3.spawned) console.log("  ", JSON.stringify(s.argv.slice(1)));

// ===========================================================================
// Scenario 4: HALF-configured pair -> must NOT pass a lone flag, falls back
// ===========================================================================
console.log("\n########## SCENARIO 4: only botId configured (incomplete pair) ##########");
const h4 = makeHarness({ credentials: undefined });
apply(h4.ctx, { ...baseConfig, botId: "only-id", botSecret: "" });
const r4 = await h4.call("wecom_auth", { action: "init" });
show("wecom_auth init (half pair)", r4);
const sentLoneBotId = h4.spawned.some((s) => s.argv.includes("--bot-id"));
console.log("!! sent a lone --bot-id (clap would reject: needs --secret)?", sentLoneBotId ? "YES — BUG" : "no");
console.log("jobs started (expect 1 fallback scan):", h4.startedJobs.length);
h4.killAll();

// ===========================================================================
// Scenario 5: credentials service absent but env var set -> ambient fallback
// ===========================================================================
console.log("\n########## SCENARIO 5: no credentials service, ambient env fallback ##########");
process.env.WECOM_CLI_BOT_ID = "env-bot-id";
process.env.WECOM_CLI_BOT_SECRET = "env-secret-env123";
const h5 = makeHarness({ credentials: undefined });
apply(h5.ctx, baseConfig);
const r5 = await h5.call("wecom_auth", { action: "init" });
show("wecom_auth init (ambient env)", r5);
console.log("!! secret leaked into output?", r5.includes("env-secret-env123") ? "YES — BUG" : "no");
console.log("argv vectors:");
for (const s of h5.spawned) console.log("  ", JSON.stringify(s.argv.slice(1)));
delete process.env.WECOM_CLI_BOT_ID;
delete process.env.WECOM_CLI_BOT_SECRET;

// ===========================================================================
// Unit checks on the pure helpers
// ===========================================================================
console.log("\n########## pure helper checks ##########");
const { commandLabel, credentialArgs, redactSecrets, buildRunArgs } = mod;
console.log("commandLabel masks secret:",
  JSON.stringify(commandLabel(["auth", "init", "--bot-id", "b1", "--secret", "sup3r"])));
console.log("credentialArgs complete:", JSON.stringify(credentialArgs({ botId: "a", botSecret: "b" })));
console.log("credentialArgs half:", JSON.stringify(credentialArgs({ botId: "a", botSecret: undefined })));
console.log("credentialArgs none:", JSON.stringify(credentialArgs({ botId: undefined, botSecret: undefined })));
console.log("redactSecrets:", JSON.stringify(redactSecrets("token=abc and abc again", ["abc"])));
console.log("redactSecrets empty ignored:", JSON.stringify(redactSecrets("keep me", ["", undefined])));
console.log("buildRunArgs:", JSON.stringify(buildRunArgs({ command: ["doc", "search"], payload: { keywords: ["x"] }, pageCount: 2 }, baseConfig)));
await expectThrow("pageCount non-positive", () => h1.call("wecom_run", { command: ["doc", "search"], pageCount: 0 }));

console.log("\nOK: smoke test completed");
// Nothing should keep the event loop alive; exit explicitly so a stray child
// cannot hang the run.
process.exit(0);
