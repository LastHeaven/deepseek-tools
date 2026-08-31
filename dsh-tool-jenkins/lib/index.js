// @deepseek-ai/dsh-tool-jenkins
//
// Native Cordis tool plugin exposing Jenkins CI tools against a Jenkins
// controller's REST API. Read tools work anonymously when the controller
// allows it; any tool can also run authenticated (username + API token,
// HTTP Basic) by setting `username` + `apiToken` in the plugin config.
//
// Target controller: Jenkins 2.150.2 at http://192.168.2.203:8080/jenkins
// (sub-path deploy, security enabled — anonymous API reads return 403).
//
// REST endpoints used (base url must include the context path, e.g.
// http://host:8080/jenkins):
//   GET  /api/json?tree=...                          -> controller info / job tree
//   GET  /job/<path>/api/json?tree=...               -> job detail
//   GET  /job/<path>/<n>/api/json?tree=...           -> build detail
//   GET  /job/<path>/<n>/logText/progressiveText?start=<offset> -> console log
//   GET  /queue/item/<id>/api/json                   -> queue item status
//   GET  /computer/api/json                          -> nodes/agents
//   GET  /crumbIssuer/api/json                       -> CSRF crumb (POST)
//   POST /job/<path>/build[WithParameters]           -> trigger a build
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-jenkins";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;

/** Hard cap on console text pulled per call (characters). */
const MAX_LOG_CHARS = 100000;

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default("http://192.168.2.203:8080/jenkins"),
  username: z.string().default(""),
  apiToken: z.string().default(""),
  listJobs: z.boolean().default(true),
  getJob: z.boolean().default(true),
  buildStatus: z.boolean().default(true),
  consoleOutput: z.boolean().default(true),
  triggerBuild: z.boolean().default(true),
  queueItem: z.boolean().default(true),
  nodes: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-jenkins: ${label} must be a positive integer`);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  return String(config.apiUrl || "").replace(/\/+$/, "");
}

function makeHeaders(config, extra) {
  const headers = { ...extra };
  // Jenkins API token auth is HTTP Basic; the password alone also works but
  // an API token must be used for the crumb to validate in older versions.
  if (config.username && config.apiToken) {
    const basic = Buffer.from(`${config.username}:${config.apiToken}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  return headers;
}

function hasAuth(config) {
  return Boolean(config.username && config.apiToken);
}

async function request(config, method, path, extraHeaders, signal) {
  const res = await fetch(baseUrl(config) + path, {
    method,
    headers: makeHeaders(config, extraHeaders),
    signal
  });
  return res;
}

async function getJson(config, path, signal) {
  const res = await request(config, "GET", path, undefined, signal);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let hasCrumbHint = false;
    try {
      const text = await res.text();
      // Jenkins HTML error pages embed a readable reason in the <body>; grab a slice.
      const m = text.match(/<h1[^>]*>([^<]+)<\/h1>/);
      if (m) detail = `HTTP ${res.status}: ${m[1].trim()}`;
      if (res.status === 403) hasCrumbHint = true;
    } catch { /* keep status fallback */ }
    if (res.status === 403 && !hasAuth(config)) {
      detail = "HTTP 403 — this Jenkins requires authentication. Set the plugin config `username` + `apiToken` (Jenkins -> user -> Security -> API Token).";
    } else if (hasCrumbHint && !hasAuth(config)) {
      detail += " — authentication is required for this endpoint.";
    } else if (res.status === 404) {
      detail = "HTTP 404 — no such job/build/node (check the exact job path; folder jobs use nested paths).";
    }
    throw new Error(`jenkins GET ${path} failed (${detail})`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Split a job path into /job/<seg>/job/<seg> URL form ("a/b" -> /job/a/job/b). */
function jobUrlPath(job) {
  const segments = String(job).split("/").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) throw new Error("jenkins: job path must not be empty");
  return "/" + segments.map((s) => `job/${encodeURIComponent(s)}`).join("/");
}

// ---------------------------------------------------------------------------
// Crumb (CSRF) handling — required by Jenkins 2.x for POST with session auth,
// harmless-but-needed for Basic auth on versions without the crumb exemption.
// ---------------------------------------------------------------------------

async function crumbHeaders(config, signal) {
  try {
    const crumb = await getJson(config, "/crumbIssuer/api/json", signal);
    if (crumb && crumb.crumbRequestField && crumb.crumb) {
      return { [crumb.crumbRequestField]: crumb.crumb };
    }
  } catch { /* crumb optional on some setups; POST will fail loudly if needed */ }
  return {};
}

// ---------------------------------------------------------------------------
// Formatters (model-facing text)
// ---------------------------------------------------------------------------

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
}

const BUILD_RESULT_ICON = {
  SUCCESS: "✅",
  UNSTABLE: "⚠️",
  FAILURE: "❌",
  ABORTED: "⏹",
  NOT_BUILT: "➖"
};

function fmtDuration(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m${rest ? ` ${rest}s` : ""}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtBuild(b) {
  const icon = b.building ? "🔄" : (BUILD_RESULT_ICON[b.result] || "❔");
  const when = b.timestamp ? new Date(b.timestamp).toISOString().replace("T", " ").slice(0, 19) : "?";
  const parts = [`#${b.number} ${icon} ${b.building ? "BUILDING" : (b.result || "UNKNOWN")} (${when}, ${fmtDuration(b.duration)})`];
  if (b.url) parts.push(`  ${b.url}`);
  return parts.join("\n");
}

function fmtJob(j) {
  const color = j.color || "";
  const building = color.endsWith("_anime");
  const base = color.replace(/_anime$/, "");
  const icon = building ? "🔄" : ({
    blue: "✅", green: "✅", yellow: "⚠️", red: "❌", aborted: "⏹", disabled: "⏸", notbuilt: "➖", grey: "❔"
  }[base] || "❔");
  return `${icon} ${j.name}${j.displayName && j.displayName !== j.name ? ` (${j.displayName})` : ""}${building ? " [building]" : ""}${j.url ? `\n   ${j.url}` : ""}`;
}

function fmtHealth(hb) {
  if (!Array.isArray(hb) || !hb.length) return "";
  return hb.map((h) => `- ${h.score != null ? `${h.score}%` : "?"}: ${h.description}`).join("\n");
}

/** Collect parameter definitions from a job's `property` (Jenkins spelling) or
 *  `properties` payload; returns [] when the job declares none. */
function collectParameterDefinitions(jobData) {
  const props = [].concat(jobData?.property ?? [], jobData?.properties ?? []);
  return props.flatMap((p) => Array.isArray(p?.parameterDefinitions) ? p.parameterDefinitions : []);
}

function fmtParameters(params) {
  if (!Array.isArray(params) || !params.length) return "This job declares no build parameters (plain `build` trigger).";
  const lines = params.map((p) => {
    const bits = [`name=${p.name}`, `type=${p.type || p._class?.split(".").pop()}`];
    if (p.defaultParameterValue?.value !== undefined) bits.push(`default=${JSON.stringify(p.defaultParameterValue.value)}`);
    if (p.choices?.length) bits.push(`choices=[${p.choices.join(", ")}]`);
    if (p.description) bits.push(`desc=${p.description}`);
    return `- ${bits.join("; ")}`;
  });
  return "Build parameters (use jenkins_trigger_build with `parameters` for these):\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

function applyListJobsTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_list_jobs",
    order: 130,
    text: "Use the jenkins_list_jobs tool to discover jobs (and folders) on the Jenkins controller before other jenkins_* calls. Folder jobs return nested `jobs` arrays; job paths you pass to other tools are slash-joined names like `folder/jobname`."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_list_jobs",
    description: "Lists jobs on the Jenkins controller, including folders (which contain nested `jobs`). Read-only. Returns each job's name, full display name, color/state, and URL. Call this first to discover exact job paths before jenkins_get_job / jenkins_build_status / jenkins_trigger_build.",
    parameters: {
      folder: { type: "string", description: "Optional folder path to list inside (e.g. 'myfolder'). Omit to list the controller root." },
      recursive: { type: "boolean", description: "Also return nested jobs inside folders in one flat list (default false)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tree = "jobs[name,displayName,url,color,jobs[name,displayName,url,color]]";
      const base = args.folder ? jobUrlPath(args.folder) : "";
      const data = await getJson(config, `${base}/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      if (!jobs.length) return args.folder ? `No jobs found inside folder '${args.folder}'.` : "No jobs found on this controller.";
      const lines = [];
      const walk = (list, prefix, depth) => {
        for (const j of list) {
          lines.push(`${"  ".repeat(depth)}${fmtJob(j)}`);
          if (args.recursive && Array.isArray(j.jobs) && j.jobs.length) {
            walk(j.jobs, `${prefix}${j.name}/`, depth + 1);
          }
        }
      };
      walk(jobs, "", 0);
      return `Jenkins jobs${args.folder ? ` in folder '${args.folder}'` : ""}${args.recursive ? " (recursive)" : ""}:\n\n${lines.join("\n")}`;
    },
    presentCall: (args) => ({ card: "generic", title: args.folder || "Jenkins jobs", kind: "jenkins-list", rawInput: args.folder || "" })
  }));
}

function applyGetJobTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_get_job",
    order: 131,
    text: "Use the jenkins_get_job tool to inspect one job: its health, build parameters, and recent builds. Read the parameters list before triggering a parameterized build."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_get_job",
    description: "Returns one Jenkins job's details: health report, declared build parameters (with defaults and choices), last successful/failed/completed builds, and the recent build list. Use slash-joined paths for folder jobs (e.g. 'myfolder/myjob').",
    parameters: {
      job: { type: "string", required: true, description: "Job path, slash-joined for folders (e.g. 'backend/api-service')." },
      buildsLimit: { type: "number", description: "How many recent builds to list (default 10, max 50)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = Math.min(Math.max(1, Number(args.buildsLimit) || 10), 50);
      // NOTE: the Jenkins job field is `property` (singular).
      const tree = `property[parameterDefinitions[name,type,defaultParameterValue[value],choices,description]],lastSuccessfulBuild[number,result,url],lastFailedBuild[number,result,url],lastCompletedBuild[number,result,url],lastBuild[number,building],healthReport[score,description],builds[number,result,building,timestamp,duration,url]{0,${limit}}`;
      const data = await getJson(config, `${jobUrlPath(args.job)}/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
      const sections = [];
      sections.push(`Job: ${args.job}${data.displayName && data.displayName !== args.job ? ` (${data.displayName})` : ""}`);
      const health = fmtHealth(data.healthReport);
      if (health) sections.push(`Health:\n${health}`);
      const last = data.lastBuild ? fmtBuild(data.lastBuild) : "never built";
      sections.push(`Last build: ${last}`);
      for (const [label, b] of [["Last successful", data.lastSuccessfulBuild], ["Last failed", data.lastFailedBuild], ["Last completed", data.lastCompletedBuild]]) {
        if (b) sections.push(`${label}: #${b.number} (${b.result || "?"})`);
      }
      sections.push(fmtParameters(collectParameterDefinitions(data)));
      const builds = Array.isArray(data.builds) ? data.builds : [];
      if (builds.length) sections.push(`Recent builds:\n${builds.map(fmtBuild).join("\n")}`);
      return sections.join("\n\n");
    },
    presentCall: (args) => ({ card: "generic", title: args.job, kind: "jenkins-job", rawInput: args.job })
  }));
}

function applyBuildStatusTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_build_status",
    order: 132,
    text: "Use the jenkins_build_status tool to check one build's state and result. Omit `number` to inspect the latest build. Follow jenkins_trigger_build with jenkins_queue_item, then jenkins_build_status once the queue item reports an executable number."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_build_status",
    description: "Returns one Jenkins build's status: building/finished, result (SUCCESS/UNSTABLE/FAILURE/ABORTED), duration, timestamp, and change set summary. Omit `number` for the latest build.",
    parameters: {
      job: { type: "string", required: true, description: "Job path, slash-joined for folders." },
      number: { type: "number", description: "Build number. Omit for the latest build." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const n = args.number != null ? args.number : "lastBuild";
      const tree = "number,building,result,timestamp,duration,url,actions[parameters[name,value]],changeSet[items[commitId,msg,author[fullName]]]";
      const data = await getJson(config, `${jobUrlPath(args.job)}/${n}/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
      const lines = [fmtBuild(data)];
      const params = data.actions?.flatMap((a) => a.parameters || []) || [];
      if (params.length) lines.push(`Parameters: ${params.map((p) => `${p.name}=${JSON.stringify(p.value)}`).join(", ")}`);
      const items = data.changeSet?.items || [];
      if (items.length) {
        lines.push(`Changes (${items.length}):`);
        for (const c of items.slice(0, 20)) lines.push(`  - ${c.commitId ? `${String(c.commitId).slice(0, 8)} ` : ""}${c.msg}${c.author?.fullName ? ` — ${c.author.fullName}` : ""}`);
      }
      return lines.join("\n");
    },
    presentCall: (args) => ({ card: "generic", title: `${args.job}${args.number ? ` #${args.number}` : " (last)"}`, kind: "jenkins-build", rawInput: String(args.number ?? "") })
  }));
}

function applyConsoleOutputTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_console_output",
    order: 133,
    text: "Use the jenkins_console_output tool to read a build's console log, especially to diagnose a FAILURE. Use `tail` and `startOffset` to page through long logs."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_console_output",
    description: "Fetches a Jenkins build's console output (log). Supports `tail` (last N characters) and `startOffset` (byte offset for paging) so long logs stay manageable. Works on running builds (log grows live).",
    parameters: {
      job: { type: "string", required: true, description: "Job path, slash-joined for folders." },
      number: { type: "number", description: "Build number. Omit for the latest build." },
      tail: { type: "number", description: "Return only the last N characters of the log." },
      startOffset: { type: "number", description: "Byte offset to start reading from (progressive paging)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const n = args.number != null ? args.number : "lastBuild";
      const start = Math.max(0, Number(args.startOffset) || 0);
      const res = await request(config, "GET", `${jobUrlPath(args.job)}/${n}/logText/progressiveText?start=${start}`, undefined, exec.signal);
      if (!res.ok) {
        if (res.status === 404) throw new Error(`jenkins console: build #${n} of '${args.job}' does not exist (HTTP 404)`);
        throw new Error(`jenkins console failed (HTTP ${res.status})`);
      }
      const text = await res.text();
      const more = res.headers.get("x-more-data") === "true";
      let out = text;
      let note = "";
      if (more) note = "\n\n(…more data available — call again with startOffset=<new offset>.)";
      if (args.tail != null && args.tail > 0) {
        const t = Number(args.tail);
        out = out.length > t ? out.slice(-t) : out;
        note = note || (out.length === t ? "" : "");
      }
      const header = `Console output for ${args.job} #${n}${start ? ` (from byte ${start})` : ""}:\n\n`;
      return truncate(header + out + note, config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.job}${args.number ? ` #${args.number}` : " (last)"} log`, kind: "jenkins-log", rawInput: String(args.number ?? "") })
  }));
}

function applyTriggerBuildTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_trigger_build",
    order: 134,
    text: "Use the jenkins_trigger_build tool to queue a Jenkins build. Authentication (username + apiToken in the plugin config) is required. For parameterized jobs pass `parameters` (e.g. {\"module\": \"user-service\", \"option\": \"rebuild\"} for a job like test-sub-module); the tool fetches the job's parameter definitions first and rejects unknown names, bad choices, or missing required parameters before queueing. Discover names/types/choices with jenkins_get_job. Follow up with jenkins_queue_item."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_trigger_build",
    description: "Triggers (queues) a Jenkins build and returns the queue item URL for tracking. Requires authenticated plugin config (username + apiToken). For parameterized jobs pass a `parameters` object — e.g. for job 'test-sub-module' pass {\"module\": \"...\", \"option\": \"...\"}; the tool validates names/choices/required-ness against the job's declared parameters before queueing. Check jenkins_get_job first for exact parameter names, types, and choices. Marked non-concurrent-safe: builds are sequential side effects.",
    parameters: {
      job: { type: "string", required: true, description: "Job path, slash-joined for folders (e.g. 'test-sub-module')." },
      parameters: { type: "object", additionalProperties: true, description: "Parameter values for parameterized jobs, e.g. {\"module\": \"user-service\", \"option\": \"rebuild\"}. Omit only when the job has no parameters or all parameters have defaults." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!hasAuth(config)) {
        throw new Error("jenkins_trigger_build requires authentication: set the plugin config `username` + `apiToken` (Jenkins -> your user -> Security -> API Token), then reload.");
      }
      const path = jobUrlPath(args.job);
      const hasParams = args.parameters != null && typeof args.parameters === "object" && Object.keys(args.parameters).length > 0;

      // Pre-flight: fetch the job's declared parameter definitions so a typo'd
      // parameter name fails HERE with the valid names instead of silently
      // building with defaults, and a missing required parameter fails instead
      // of building with the wrong input.
      let declared = [];
      try {
        const tree = "property[parameterDefinitions[name,type,defaultParameterValue[value],choices,description]]";
        const job = await getJson(config, `${path}/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
        declared = collectParameterDefinitions(job);
      } catch { /* keep declared = [] — POST will surface the real error */ }

      if (declared.length > 0) {
        const byName = new Map(declared.map((p) => [p.name, p]));
        const unknown = Object.keys(args.parameters || {}).filter((k) => !byName.has(k));
        if (unknown.length) {
          const valid = declared.map((p) => {
            const def = p.defaultParameterValue?.value;
            return `${p.name}${def !== undefined ? `=${JSON.stringify(def)}` : ""}`;
          }).join(", ");
          throw new Error(`Unknown build parameter(s) for '${args.job}': ${unknown.join(", ")}. Valid parameters: ${valid}`);
        }
        // Choice-type parameters: warn-and-accept? No — fail early with the choices,
        // because a wrong choice usually builds the wrong artifact.
        for (const [k, v] of Object.entries(args.parameters || {})) {
          const p = byName.get(k);
          if (p && Array.isArray(p.choices) && p.choices.length > 0 && !p.choices.includes(String(v))) {
            throw new Error(`Parameter '${k}' value '${v}' is not one of the allowed choices [${p.choices.join(", ")}]`);
          }
        }
        // Required = a parameter with no default value that was not supplied.
        const missing = declared.filter((p) => p.defaultParameterValue?.value === undefined && !(p.name in (args.parameters || {})));
        if (missing.length) {
          throw new Error(`Missing required build parameter(s) for '${args.job}': ${missing.map((p) => p.name).join(", ")} (no default value declared). Pass them in \`parameters\`.`);
        }
        if (!hasParams) {
          const hasAnyRequired = declared.some((p) => p.defaultParameterValue?.value === undefined);
          if (hasAnyRequired) {
            const required = declared.filter((p) => p.defaultParameterValue?.value === undefined).map((p) => p.name).join(", ");
            throw new Error(`'${args.job}' is parameterized and requires: ${required}. Pass them via \`parameters\` (see jenkins_get_job for types/choices).`);
          }
          // All parameters have defaults: build proceeds with them, but say so.
        }
      }

      let endpoint;
      let body;
      let contentType;
      // A parameterized job must go through buildWithParameters even when we
      // send no explicit values (POST /build is rejected for parameterized
      // jobs): defaults are then applied server-side.
      const useBuildWithParameters = hasParams || declared.length > 0;
      if (useBuildWithParameters) {
        endpoint = `${path}/buildWithParameters`;
        if (hasParams) {
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(args.parameters)) form.append(k, String(v));
          body = form.toString();
          contentType = "application/x-www-form-urlencoded";
        }
      } else {
        endpoint = `${path}/build`;
      }
      const crumb = await crumbHeaders(config, exec.signal);
      const headers = { ...crumb };
      if (body !== undefined) {
        headers["content-type"] = contentType;
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      const res = await fetch(baseUrl(config) + endpoint, {
        method: "POST",
        headers: makeHeaders(config, headers),
        body,
        signal: exec.signal
      });
      if (res.status === 201 || res.status === 200) {
        const location = res.headers.get("location") || "";
        const queueUrl = location || "(no queue location returned — check the job's build history)";
        return `Build queued for '${args.job}'.\nQueue item: ${queueUrl}\nTrack it with jenkins_queue_item (queue id = the number after /queue/item/), then jenkins_build_status once the build starts.`;
      }
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        const m = text.match(/<h1[^>]*>([^<]+)<\/h1>/);
        if (m) detail = `HTTP ${res.status}: ${m[1].trim()}`;
      } catch { /* keep fallback */ }
      if (res.status === 403) detail += " — check the API token, its permissions, and whether the crumb was accepted.";
      if (res.status === 400 && hasParams) detail += " — a parameter name/value may be wrong (verify with jenkins_get_job).";
      throw new Error(`jenkins trigger ${args.job} failed (${detail})`);
    },
    presentCall: (args) => ({ card: "generic", title: `Build ${args.job}`, kind: "jenkins-trigger", rawInput: args.job })
  }));
}

function applyQueueItemTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_queue_item",
    order: 135,
    text: "Use the jenkins_queue_item tool after jenkins_trigger_build to follow a queued build: `in queue since` while waiting, `executable.number` once a build starts."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_queue_item",
    description: "Returns a Jenkins queue item's status: why/where it waits (blocked, stuck, pending), and — once scheduled — the build number and URL it became. Use the queue id from jenkins_trigger_build.",
    parameters: {
      id: { type: "number", required: true, description: "Queue item id (the number after /queue/item/ in the URL returned by jenkins_trigger_build)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tree = "id,inQueueSince,blocked,stuck,buildable,why,task[name,url],executable[number,url],cancelled";
      const data = await getJson(config, `/queue/item/${Number(args.id)}/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
      if (data.cancelled) return `Queue item #${args.id} was cancelled.`;
      const lines = [`Queue item #${args.id}: task=${data.task?.name || "?"}`];
      lines.push(`Waiting since ${data.inQueueSince ? new Date(data.inQueueSince).toISOString().replace("T", " ").slice(0, 19) : "?"}${data.blocked ? " [blocked]" : ""}${data.stuck ? " [stuck]" : ""}${data.buildable ? " [buildable]" : ""}`);
      if (data.why) lines.push(`Why: ${data.why}`);
      if (data.executable?.number != null) {
        lines.push(`→ Build started: #${data.executable.number}${data.executable.url ? ` (${data.executable.url})` : ""}`);
        lines.push("Check it with jenkins_build_status / jenkins_console_output.");
      }
      return lines.join("\n");
    },
    presentCall: (args) => ({ card: "generic", title: `Queue #${args.id}`, kind: "jenkins-queue", rawInput: String(args.id) })
  }));
}

function applyNodesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:jenkins_nodes",
    order: 136,
    text: "Use the jenkins_nodes tool to check which Jenkins controller/agent nodes are online before debugging executor or capacity issues."
  });
  ctx.tools.register(defineTool({
    name: "jenkins_nodes",
    description: "Lists Jenkins nodes (built-in controller + agents) with online/offline state, executor counts, and current executor activity. Useful to diagnose queued builds waiting for executors.",
    parameters: {},
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tree = "computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,executors[currentExecutable[url]],oneOffExecutors[currentExecutable[url]],monitorData[hudson.node_monitors.AbstractDiskMonitor,hudson.node_monitors.SwapSpaceMonitor]]";
      const data = await getJson(config, `/computer/api/json?tree=${encodeURIComponent(tree)}`, exec.signal);
      const list = Array.isArray(data.computer) ? data.computer : [];
      if (!list.length) return "No nodes returned by /computer (unusual — the controller itself should always be listed).";
      const lines = list.map((c) => {
        const busy = (c.executors || []).filter((e) => e.currentExecutable).length + (c.oneOffExecutors || []).length;
        const total = c.numExecutors ?? (c.executors || []).length;
        const state = c.offline ? (c.temporarilyOffline ? "OFFLINE (temp)" : "OFFLINE") : "online";
        const icon = c.offline ? "🔴" : "🟢";
        const cause = c.offline && c.offlineCauseReason ? ` — ${c.offlineCauseReason}` : "";
        return `${icon} ${c.displayName} — ${state}, executors ${busy}/${total}${cause}`;
      });
      return `Jenkins nodes:\n\n${lines.join("\n")}`;
    },
    presentCall: () => ({ card: "generic", title: "Jenkins nodes", kind: "jenkins-nodes", rawInput: "" })
  }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);

  if (config.listJobs) applyListJobsTool(ctx, config);
  if (config.getJob) applyGetJobTool(ctx, config);
  if (config.buildStatus) applyBuildStatusTool(ctx, config);
  if (config.consoleOutput) applyConsoleOutputTool(ctx, config);
  if (config.triggerBuild) applyTriggerBuildTool(ctx, config);
  if (config.queueItem) applyQueueItemTool(ctx, config);
  if (config.nodes) applyNodesTool(ctx, config);
}

export { Config, DEFAULT_TIMEOUT_MS, apply, collectParameterDefinitions, hasAuth, inject, jobUrlPath, name };
