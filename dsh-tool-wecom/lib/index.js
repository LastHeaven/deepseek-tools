// @deepseek-ai/dsh-tool-wecom
//
// Native Cordis tool plugin exposing the official WeCom CLI (`@wecom/cli`,
// the `wecom-cli` binary) to a DSH agent.
//
// WHY A GENERIC RUNNER AND NOT ONE TOOL PER METHOD
// ------------------------------------------------
// wecom-cli is a *discovery-driven* CLI: the service catalogue and every
// method's parameter schema are fetched at runtime from the WeCom backend, so
// the command tree is not known at build time. `wecom-cli schema list` on
// 1.2.1 reports 14 services and ~100 methods across message/mail/doc/sheet/
// smartsheet/smartpage/disk/calendar/meeting/todo/contact/media/chat/identity.
// Registering one DSH tool per method would mean ~100 catalog entries that go
// stale whenever the backend adds a method. Instead this plugin exposes a
// small, stable surface:
//
//   wecom_status  prerequisite check (version + authorization + resolved CLI)
//   wecom_run     invoke ANY method: `<service> [resource...] <method>`
//   wecom_schema  discovery: service/method list, schema and TS doc text
//   wecom_auth    `auth show` and the one-time interactive `auth init` login
//
// The *business* rules for each domain (which call to make first, which IDs may
// never be shown to the user, how to match a chat target) live in the
// `wecomcli-*` Agent Skills shipped with the WeCom CLI project; the preset
// mounting this plugin ships those skills next to its composition. This plugin
// deliberately does not restate them.
//
// HOW THE CLI IS LAUNCHED (and why this is subtle on Windows)
// ----------------------------------------------------------
// The npm global install on Windows puts a `wecom-cli.CMD` shim on PATH whose
// body forwards to `node .../@wecom/cli/bin/wecom.js`. Node's `child_process`
// refuses to spawn a `.cmd` directly (EINVAL on Node >= 20 unless `shell: true`,
// and `shell: true` concatenates arguments instead of passing an argv array,
// which would corrupt the JSON payloads this plugin sends). So the CLI is
// resolved to something spaw*nable* without a shell, in this order:
//
//   1. `cliPath` from the plugin config, if set.
//   2. The platform-native binary of the npm optional-dependency package
//      (`@wecom/cli-<platform>-<arch>/bin/wecom-cli[.exe]`), located by
//      resolving `@wecom/cli/package.json` from the directory holding the
//      `wecom-cli` shim. This is the fast path on every platform.
//   3. `node <…>/@wecom/cli/bin/wecom.js` — the wrapper the shim itself runs.
//   4. Last resort on Windows: `cmd.exe /d /s /c <shim> …`.
//
// Whatever the launcher, the request body always travels as ONE argv element
// (`--json '{"...":...}'`), never re-parsed by a shell.
//
// SANDBOX POSTURE
// ---------------
// This plugin spawns through `ctx.subprocess`, the harness's *unconfined*
// process seam (the file sandbox is applied by `ctx.shell` executors, and that
// seam's spec carries no sandbox policy at all). That is intentional and
// required: wecom-cli stores its encrypted credentials in
// `~/.config/wecom/credentials.enc`, outside any workspace, and downloads media
// to its own temp root. A preset is exactly as privileged as the plugins it
// names, so the capability is granted by mounting this row — not by relaxing a
// sandbox at runtime.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-wecom";

/** Services this plugin requires; `jobs` is read optionally for background login. */
const inject = ["tools", "systemPrompt", "subprocess"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default per-stream capture budget (bytes) for a CLI invocation. */
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

/** stderr is diagnostic only; keep a smaller tail so stdout keeps the budget. */
const STDERR_MAX_OUTPUT_BYTES = 64 * 1024;

/** Smallest wecom-cli version whose command model this plugin targets. */
const MINIMUM_CLI_VERSION = [1, 2, 1];

/** Exit codes documented by wecom-cli (docs/cli-reference.md). */
const EXIT_USAGE_ERROR = 2;

/**
 * A credential REFERENCE must be a POSIX shell identifier.
 *
 * This mirrors `REF_PATTERN` in `@deepseek-ai/dsh-credentials` and is inlined
 * rather than imported on purpose: a static import would throw while LOADING
 * this plugin in a deployment that composes no credentials service, whereas
 * `ctx.get('credentials')` degrades to "no credential store" at USE time.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Default references read through `ctx.credentials` when no literal value is
 * configured. A reference resolves over the process environment, the
 * provider-managed store (`$DSH_HOME/.credentials.yaml`, 0600), and `.env`
 * files — so the secret itself never has to sit in a composition file.
 */
const DEFAULT_BOT_ID_ENV = "WECOM_CLI_BOT_ID";
const DEFAULT_BOT_SECRET_ENV = "WECOM_CLI_BOT_SECRET";

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  cliPath: z.string().default(""),
  nodePath: z.string().default(""),
  cwd: z.string().default(""),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  graceMs: z.number().default(2_000),
  configDir: z.string().default(""),
  tmpDir: z.string().default(""),
  logLevel: z.string().default(""),
  statusTool: z.boolean().default(true),
  runTool: z.boolean().default(true),
  schemaTool: z.boolean().default(true),
  authTool: z.boolean().default(true),
  allowAuthInit: z.boolean().default(true),
  prettyPrintJson: z.boolean().default(true),
  // ── credentials ──────────────────────────────────────────────────────────
  // `wecom-cli` accepts a Bot ID + Secret ONLY as hidden argv flags (it has no
  // environment-variable or config-file input for them), so this plugin reads
  // the pair here and passes it as argv on the caller's behalf.
  //
  // Precedence per field: literal `botId`/`botSecret` win when non-empty,
  // otherwise the `...Env` credential reference is resolved through
  // `ctx.credentials`. Prefer the REFERENCE form: `role("secret")` marks the
  // literal for settings UIs, but a literal still sits in cleartext in the
  // composition file, while a reference stores only a NAME there and keeps the
  // value in the 0600 credentials doc.
  botId: z.string().role("credential-ref").default(""),
  botSecret: z.string().role("secret").default(""),
  botIdEnv: z.string().role("credential-ref").default(DEFAULT_BOT_ID_ENV),
  botSecretEnv: z.string().role("credential-ref").default(DEFAULT_BOT_SECRET_ENV)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-wecom: ${label} must be a positive integer`);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function environmentValue(env, key) {
  // Windows environment names are case-insensitive; PATH/Path/PATH all occur.
  if (env[key] !== undefined) return env[key];
  const upper = key.toUpperCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === upper) return value;
  }
  return undefined;
}

/** Executable extensions to try for a bare command name in this environment. */
function executableExtensions(env) {
  if (process.platform !== "win32") return [""];
  const raw = environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** First existing `command` (+PATHEXT) entry on PATH, or undefined. */
function findOnPath(command, env) {
  const path = environmentValue(env, "PATH") ?? "";
  const extensions = executableExtensions(env);
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The explicit environment handed to `ctx.subprocess.spawn`. The seam merges
 * this after its credential scrub, so only the WeCom-specific overrides the
 * operator configured travel — never a credential-shaped `*_TOKEN` value.
 * @returns the delta object, or undefined when nothing is configured.
 */
function childEnvironment(config) {
  const env = {};
  if (config.configDir !== "") env.WECOM_CLI_CONFIG_DIR = config.configDir;
  if (config.tmpDir !== "") env.WECOM_CLI_TMP_DIR = config.tmpDir;
  if (config.logLevel !== "") env.WECOM_CLI_LOG_LEVEL = config.logLevel;
  return Object.keys(env).length > 0 ? env : undefined;
}

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

/**
 * Locate the npm-installed CLI through its shim directory.
 *
 * `createRequire` is anchored at the shim's own directory because that is the
 * only place `@wecom/cli` (and its platform package) is guaranteed to resolve
 * from — the plugin lives in the harness tree, where neither is installed.
 * @param baseDir - directory holding the `wecom-cli` shim.
 * @returns the launch plan, or undefined when the npm layout cannot be derived.
 */
function deriveFromNpmShim(baseDir) {
  let cliPackage;
  try {
    cliPackage = createRequire(join(baseDir, "__dsh_tool_wecom__.cjs")).resolve("@wecom/cli/package.json");
  } catch {
    return undefined;
  }
  const cliDir = dirname(cliPackage);

  // Fast path: the platform optional-dependency's native binary.
  const platformPackage = `@wecom/cli-${process.platform}-${process.arch}`;
  try {
    const platformJson = createRequire(join(cliDir, "__dsh_tool_wecom__.cjs")).resolve(`${platformPackage}/package.json`);
    const binary = join(dirname(platformJson), "bin", process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli");
    if (existsSync(binary)) return { executable: binary, args: [], how: "npm-native-binary" };
  } catch {
    /* fall through to the JavaScript entry */
  }

  // Portable fallback: the same entry the shim itself executes.
  const entry = join(cliDir, "bin", "wecom.js");
  if (existsSync(entry)) return { executable: process.execPath, args: [entry], how: "npm-node-entry" };
  return undefined;
}

/**
 * Resolve what to execute for `wecom-cli`, preferring a launcher the process
 * seam can spawn without a shell (see the module header).
 * @param config - normalized plugin config.
 * @returns `{ executable, args, how }`; `args` are fixed arguments preceding the CLI arguments.
 * @throws when no usable launcher exists, with the install command in the message.
 */
function resolveLaunch(config) {
  const env = process.env;
  const nodeBinary = config.nodePath !== "" ? config.nodePath : process.execPath;

  if (config.cliPath !== "") {
    const configured = isAbsolute(config.cliPath) ? config.cliPath : resolvePath(config.cwd || process.cwd(), config.cliPath);
    if (!existsSync(configured)) {
      throw new Error(`tool-wecom: the configured cliPath does not exist: ${configured}`);
    }
    if (/\.(js|mjs|cjs)$/i.test(configured)) return { executable: nodeBinary, args: [configured], how: "config-node-entry" };
    if (/\.(cmd|bat)$/i.test(configured)) return { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", configured], how: "config-cmd-shim" };
    return { executable: configured, args: [], how: "config-path" };
  }

  const shim = findOnPath("wecom-cli", env);
  if (shim === undefined) {
    throw new Error(
      "tool-wecom: cannot find `wecom-cli`. Install it with `npm install -g @wecom/cli` " +
        "(Node >= 18), or set the plugin config `cliPath` to the executable/entry point."
    );
  }

  const derived = deriveFromNpmShim(dirname(shim));
  if (derived !== undefined) return derived;

  if (/\.(cmd|bat)$/i.test(shim)) {
    return { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", shim], how: "path-cmd-shim" };
  }
  return { executable: shim, args: [], how: "path-shim" };
}

/**
 * Resolve the configured Bot credentials, if any.
 *
 * `wecom-cli` reads a Bot ID + Secret only from hidden argv flags, so the pair
 * is materialized here and handed to `auth init`. Resolution is per call (the
 * credentials seam requires that: a rotated secret must reach the next
 * operation without a plugin restart), and a literal always beats a reference.
 *
 * Nothing resolved is ever logged or returned to the model: the caller passes
 * the pair straight into an argv vector, and the tool result deliberately
 * reports only whether a credential was supplied.
 *
 * @param ctx - plugin context; `credentials` is read optionally.
 * @param config - normalized plugin config.
 * @returns `{ botId, botSecret, source }` with missing halves as `undefined`.
 */
async function resolveBotCredentials(ctx, config) {
  const credentials = ctx.get("credentials");

  /** Read one field: literal first, then its credential reference. */
  const one = async (literal, refName) => {
    if (typeof literal === "string" && literal.length > 0) {
      return { value: literal, source: "config" };
    }
    if (typeof refName !== "string" || !CREDENTIAL_REF_PATTERN.test(refName)) {
      // A non-identifier cannot be a reference; reporting it as "unset" beats
      // throwing on a config typo that would otherwise break every call.
      return { value: undefined, source: refName.length > 0 ? "invalid-ref" : "unset" };
    }
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(refName);
        if (resolved !== undefined && resolved.value.length > 0) {
          return { value: resolved.value, source: `credentials:${resolved.source}` };
        }
      } catch {
        return { value: undefined, source: "resolve-failed" };
      }
    }
    // No credentials service mounted: fall back to the ambient environment,
    // which is what the reference would have read first anyway.
    const ambient = environmentValue(process.env, refName);
    if (ambient !== undefined && ambient.length > 0) return { value: ambient, source: "environment" };
    return { value: undefined, source: "unset" };
  };

  const [id, secret] = await Promise.all([
    one(config.botId, config.botIdEnv),
    one(config.botSecret, config.botSecretEnv)
  ]);
  return {
    botId: id.value,
    botSecret: secret.value,
    botIdSource: id.source,
    botSecretSource: secret.source
  };
}

/**
 * The argv tail that supplies credentials to `auth init`, or `[]`.
 *
 * Both halves are required together: clap declares `--bot-id` and `--secret`
 * with `requires` on each other, so passing only one is a usage error. A
 * half-configured pair is therefore reported as absent rather than sent.
 * @param creds - the resolved pair.
 * @returns `["--bot-id", id, "--secret", secret]`, or `[]` when incomplete.
 */
function credentialArgs(creds) {
  if (creds.botId === undefined || creds.botSecret === undefined) return [];
  return ["--bot-id", creds.botId, "--secret", creds.botSecret];
}

/** Whether the plugin has a complete, usable Bot credential pair. */
function hasBotCredentials(creds) {
  return creds.botId !== undefined && creds.botSecret !== undefined;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

function decodeOutput(read) {
  if (read === undefined) return { text: "", truncated: false };
  return { text: read.text, truncated: read.lossy === true };
}

/**
 * Run `wecom-cli` with one argv vector and collect its output.
 *
 * Non-zero exits resolve (the CLI reports business and backend errors as JSON
 * on stdout with exit 1/2); only launch and provider failures throw.
 * @param ctx - plugin context carrying the `subprocess` service.
 * @param config - normalized plugin config.
 * @param launch - resolved launcher.
 * @param argv - CLI arguments, appended after the launcher's fixed arguments.
 * @param options - working directory and the optional cooperative abort signal.
 * @returns exit facts plus collected stdout/stderr text.
 */
async function invoke(ctx, config, launch, argv, options) {
  const cwd = options.cwd;
  const spec = {
    argv: [launch.executable, ...launch.args, ...argv],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: Math.min(config.maxOutputBytes, STDERR_MAX_OUTPUT_BYTES) }
    },
    graceMs: config.graceMs
  };
  const env = childEnvironment(config);
  if (env !== undefined) spec.env = env;
  if (options.signal !== undefined) spec.signal = options.signal;

  let handle;
  try {
    handle = ctx.subprocess.spawn(spec);
  } catch (error) {
    throw new Error(`tool-wecom: could not start wecom-cli (${launch.how}: ${launch.executable}): ${messageOf(error)}`);
  }

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    throw new Error(`tool-wecom: wecom-cli did not report an outcome (${messageOf(error)})`);
  }

  if (options.signal?.aborted === true) {
    throw new Error("tool-wecom: the tool call was aborted before wecom-cli finished");
  }

  const stdout = decodeOutput(handle.collected.stdout?.readFrom(0));
  const stderr = decodeOutput(handle.collected.stderr?.readFrom(0));
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated
  };
}

/** The working directory for one call: the session workspace, else config, else cwd. */
function workingDirectory(config, exec) {
  const headerCwd = exec.agent?.session?.header?.cwd;
  if (typeof headerCwd === "string" && headerCwd.length > 0) return headerCwd;
  if (config.cwd !== "") return config.cwd;
  return process.cwd();
}

/**
 * Try to read a CLI payload back as JSON: stdout is compact JSON for method
 * calls and for the structured error envelope.
 * @param text - raw stdout.
 * @returns the parsed value, or undefined when it is not a single JSON document.
 */
function parseJsonDocument(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Build the one-line label shown above a CLI run. The `--json` body is
 * deliberately elided: it is already rendered (prettified) in the output, and
 * echoing it here would both duplicate it and bloat the model-facing text.
 *
 * Credential flags are MASKED here rather than printed: this label is
 * model-facing text that also lands in the session transcript, so a Bot Secret
 * must never appear in it even though it is a legitimate argv element.
 * @param argv - the CLI arguments for this run.
 * @returns `wecom-cli <segments> [+flags]`.
 */
const LABEL_VALUE_FLAGS = new Set(["--json", "--set", "--output", "--output-dir", "--page-count", "--page-delay", "--output-qrcode"]);
const LABEL_MASKED_FLAGS = new Set(["--secret", "--bot-id"]);

function commandLabel(argv) {
  const head = [];
  const flags = [];
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--json") {
      flags.push("--json <body>");
      index += 1;
      continue;
    }
    if (entry === "--set") {
      flags.push(`--set ${argv[index + 1] ?? ""}`.trimEnd());
      index += 1;
      continue;
    }
    if (LABEL_MASKED_FLAGS.has(entry)) {
      flags.push(`${entry} ***`);
      index += 1;
      continue;
    }
    if (LABEL_VALUE_FLAGS.has(entry)) {
      flags.push(`${entry} ${argv[index + 1] ?? ""}`.trimEnd());
      index += 1;
      continue;
    }
    if (entry.startsWith("--")) {
      flags.push(entry);
      continue;
    }
    head.push(entry);
  }
  return `wecom-cli ${head.join(" ")}${flags.length > 0 ? ` ${flags.join(" ")}` : ""}`;
}

/**
 * Replace every configured secret in text with a marker.
 *
 * Defence in depth, not the primary control: the CLI does not echo the secret
 * on the paths exercised here, but this output is both model-facing and
 * persisted to the session log, so an unexpected echo (a future CLI version, a
 * debug log level) must not be able to leak it.
 * @param text - text about to be shown to the model.
 * @param secrets - secret values to mask; empty strings are ignored.
 * @returns the text with each secret replaced by `***`.
 */
function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** Render a parsed JSON document at a size the model can actually read. */
function renderJson(value, config) {
  if (!config.prettyPrintJson) return JSON.stringify(value);
  const pretty = JSON.stringify(value, null, 2);
  // Only prettify when it stays within the capture budget; otherwise keep compact.
  return pretty.length <= config.maxOutputBytes ? pretty : JSON.stringify(value);
}

/**
 * Shape one CLI run into model-facing text: stdout (pretty-printed when it is a
 * single JSON document), a marked stderr section, and exit-status markers.
 */
function renderRun(label, result, config) {
  const parts = [];
  const parsed = parseJsonDocument(result.stdout);
  if (parsed !== undefined) {
    parts.push(renderJson(parsed, config));
  } else if (result.stdout.trim().length > 0) {
    parts.push(result.stdout.replace(/\n+$/, ""));
  } else if (result.stderr.trim().length === 0) {
    parts.push("(no output)");
  }
  if (result.stdoutTruncated) {
    parts.push("[stdout truncated: the CLI produced more output than the configured maxOutputBytes]");
  }
  if (result.stderr.trim().length > 0) {
    parts.push(`[stderr]\n${result.stderr.replace(/\n+$/, "")}`);
  }
  if (result.stderrTruncated) parts.push("[stderr truncated]");
  if (result.signal !== null && result.signal !== undefined) parts.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
  return `${label}\n\n${parts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

/** Reject a command-path segment that cannot be a CLI resource name. */
function validateCommandPath(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("invalid command: provide at least one path segment, e.g. [\"message\",\"aibot\",\"sessions\",\"list\"]");
  }
  const segments = command.map((segment) => {
    if (typeof segment !== "string") throw new Error("invalid command: every path segment must be a string");
    const trimmed = segment.trim();
    if (trimmed.length === 0) throw new Error("invalid command: path segments must not be empty");
    if (/[\s]/.test(trimmed)) throw new Error(`invalid command: path segment ${JSON.stringify(segment)} contains whitespace; pass each segment as its own array entry`);
    if (trimmed.startsWith("-")) throw new Error(`invalid command: path segment ${JSON.stringify(segment)} looks like a flag; pass flags through the dedicated options`);
    return trimmed;
  });
  return segments;
}

function buildRunArgs(args, config) {
  const segments = validateCommandPath(args.command);
  const argv = [...segments];

  if (args.payload !== undefined) {
    if (args.payload === null || typeof args.payload !== "object" || Array.isArray(args.payload)) {
      throw new Error("invalid payload: expected a JSON object with the method's request body");
    }
    argv.push("--json", JSON.stringify(args.payload));
  }

  for (const entry of args.set ?? []) {
    if (typeof entry !== "string" || !entry.includes("=")) {
      throw new Error(`invalid set entry ${JSON.stringify(entry)}: expected "path=value"`);
    }
    argv.push("--set", entry);
  }

  if (args.dryRun === true) argv.push("--dry-run");
  if (args.pageCount !== undefined) {
    if (!Number.isInteger(args.pageCount) || args.pageCount < 1) throw new Error("invalid pageCount: expected a positive integer");
    argv.push("--page-count", String(args.pageCount));
  }
  if (args.pageDelay !== undefined) {
    if (!Number.isInteger(args.pageDelay) || args.pageDelay < 0) throw new Error("invalid pageDelay: expected a non-negative integer (milliseconds)");
    argv.push("--page-delay", String(args.pageDelay));
  }
  if (args.output !== undefined && args.output !== "") argv.push("--output", args.output);
  if (args.outputDir !== undefined && args.outputDir !== "") argv.push("--output-dir", args.outputDir);
  for (const extra of args.extraArgs ?? []) {
    if (typeof extra !== "string" || extra.length === 0) throw new Error("invalid extraArgs: every entry must be a non-empty string");
    argv.push(extra);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

/** Extract `major.minor.patch` from `wecom-cli <v> (<distribution> …)`. */
function parseCliVersion(text) {
  const match = /wecom-cli\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return undefined;
  return { text: `${match[1]}.${match[2]}.${match[3]}`, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function isOlderThan(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = version[index] ?? 0;
    if (actual < minimum[index]) return true;
    if (actual > minimum[index]) return false;
  }
  return false;
}

function applyStatusTool(ctx, config, launch) {
  ctx.tools.register(defineTool({
    name: "wecom_status",
    description:
      "Check the local WeCom CLI before any WeCom work: prints the installed wecom-cli version, whether the robot is authorized, and which executable the plugin resolved. Call this FIRST in a session — a missing or outdated CLI, or an `unauthorized` result, must be fixed (npm install -g @wecom/cli, wecom_auth init) before any business command can succeed.",
    parameters: {},
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const cwd = workingDirectory(config, exec);
      const launcher = launch();
      const [version, authorization] = await Promise.all([
        invoke(ctx, config, launcher, ["--version"], { cwd, signal: exec.signal }),
        invoke(ctx, config, launcher, ["auth", "show", "--status"], { cwd, signal: exec.signal })
      ]);

      const lines = [];
      const parsedVersion = parseCliVersion(version.stdout);
      if (version.exitCode === 0) {
        lines.push(`wecom-cli: ${version.stdout.trim()}`);
      } else {
        lines.push(`wecom-cli: --version failed (exit ${version.exitCode})`);
        if (version.stderr.trim().length > 0) lines.push(version.stderr.trim());
      }

      const status = authorization.stdout.trim();
      lines.push(`authorization: ${status.length > 0 ? status : "(no output)"}`);

      lines.push(`executable: ${launcher.executable} (${launcher.how})`);

      const notes = [];
      if (parsedVersion !== undefined && isOlderThan(parsedVersion.parts, MINIMUM_CLI_VERSION)) {
        notes.push(
          `The installed CLI is ${parsedVersion.text}, but the bundled wecomcli-* skills require >= ${MINIMUM_CLI_VERSION.join(".")}. ` +
            "Upgrade with `npm install -g @wecom/cli`."
        );
      }
      if (status === "unauthorized") {
        notes.push("The robot is not authorized. Call wecom_auth with action \"init\" to log in.");
      } else if (status !== "authorized") {
        notes.push("The authorization state could not be read from `auth show --status`; treat it as unknown and report the raw output.");
      }
      if (notes.length > 0) lines.push("", "Notes:", ...notes.map((note) => `- ${note}`));
      return lines.join("\n");
    },
    presentCall: () => ({ card: "generic", title: "WeCom CLI status", kind: "wecom-status", rawInput: "" })
  }));
}

function applyRunTool(ctx, config, launch) {
  ctx.tools.register(defineTool({
    name: "wecom_run",
    description:
      "Invoke any WeCom business method through the installed wecom-cli, e.g. command [\"message\",\"aibot\",\"sessions\",\"list\"] with no payload, or [\"message\",\"aibot\",\"send\"] with payload {\"chat_id\":\"…\",\"msg_type\":\"markdown\",\"markdown\":{\"content\":\"…\"}}. Covers every service the backend publishes (message, mail, doc, sheet, smartsheet, smartpage, disk, calendar, meeting, todo, contact, media, chat, identity). BEFORE calling: read the matching wecomcli-* skill for that domain — it holds the required call order, target-matching rules and ID-confidentiality rules (for example a send must reuse a chat_id copied from the same round's sessions list, never an invented or remembered one). Use wecom_schema to discover a method's exact parameters. Use dryRun to validate the request locally without sending it. This tool only performs the raw call; the domain skills decide what to call.",
    parameters: {
      command: {
        type: "array",
        required: true,
        items: { type: "string" },
        description: "The method path split into segments, exactly as wecom-cli spells it: [\"message\",\"aibot\",\"sessions\",\"list\"], [\"doc\",\"search\"], [\"contact\",\"users\",\"search\"], [\"identity\",\"whoami\"]. Local helpers use a leading \"+\" segment, e.g. [\"doc\",\"+…\"]."
      },
      payload: {
        type: "object",
        additionalProperties: true,
        description: "Request body as a JSON object, passed as a single `--json` argument. Omit for methods that take no parameters."
      },
      set: {
        type: "array",
        items: { type: "string" },
        description: "Deep-path overrides, each \"path=value\", e.g. [\"extra.flag=true\"]. Applied on top of payload; repeatable."
      },
      dryRun: { type: "boolean", description: "Validate locally and print the request that would be sent, without calling the backend." },
      output: { type: "string", description: "Write the response body to this file (`--output`)." },
      outputDir: { type: "string", description: "Write response and attachments into this directory (`--output-dir`)." },
      pageCount: { type: "number", description: "Auto-paginate up to N pages (`--page-count`); output becomes NDJSON, one page per line." },
      pageDelay: { type: "number", description: "Delay in milliseconds between paginated requests (default 100)." },
      extraArgs: {
        type: "array",
        items: { type: "string" },
        description: "Escape hatch: additional raw wecom-cli flags appended verbatim, each as its own array entry."
      }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    // A generic runner cannot classify a method as read-only, so concurrent
    // execution is allowed only for a request that provably has no effect.
    isConcurrencySafe: (args) => args.dryRun === true,
    async execute(args, exec) {
      const argv = buildRunArgs(args, config);
      const cwd = workingDirectory(config, exec);
      if (exec.signal.aborted) throw new Error("tool-wecom: the tool call was aborted before wecom-cli started");
      const result = await invoke(ctx, config, launch(), argv, { cwd, signal: exec.signal });
      const label = commandLabel(argv);
      const text = renderRun(label, result, config);
      if (result.exitCode === EXIT_USAGE_ERROR) {
        return `${text}\n\nHint: exit code 2 is a usage error. Call wecom_schema (kind "doc" or kind "get") for this method to read its exact parameters, or use dryRun to inspect the request.`;
      }
      return text;
    },
    presentCall: (args) => ({
      card: "generic",
      title: `wecom-cli ${Array.isArray(args.command) ? args.command.join(" ") : ""}`,
      kind: "wecom-run",
      rawInput: Array.isArray(args.command) ? args.command.join(" ") : ""
    })
  }));
}

function applySchemaTool(ctx, config, launch) {
  ctx.tools.register(defineTool({
    name: "wecom_schema",
    description:
      "Read the WeCom service catalogue and method contracts — the CLI is discovery-driven, so this is how exact parameter names, types and required fields are found instead of guessed. kind \"list\" prints every service and method; kind \"get\" with `method` (e.g. \"message.aibot.send\") prints one method's full JSON schema; kind \"doc\" prints the human/TS documentation for a service or method path; kind \"schema\" prints the service or method JSON schema. Read the matching wecomcli-* skill first for the business rules, then use this tool for the exact signature.",
    parameters: {
      kind: { type: "string", required: true, enum: ["list", "get", "doc", "schema"], description: "\"list\" all services/methods, \"get\" one method schema by dotted name, \"doc\" documentation for a command path, \"schema\" JSON schema for a command path." },
      method: { type: "string", description: "Dotted method name for kind \"get\", e.g. \"message.aibot.send\" or \"doc.search\"." },
      command: { type: "array", items: { type: "string" }, description: "Command path for kind \"doc\"/\"schema\", e.g. [\"message\"] or [\"message\",\"aibot\",\"send\"]." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = workingDirectory(config, exec);
      let argv;
      if (args.kind === "list") {
        argv = ["schema", "list"];
      } else if (args.kind === "get") {
        if (typeof args.method !== "string" || args.method.trim() === "") {
          throw new Error("kind \"get\" requires `method`, the dotted method name such as \"message.aibot.send\"");
        }
        argv = ["schema", "get", args.method.trim()];
      } else {
        const segments = validateCommandPath(args.command);
        argv = [...segments, args.kind === "doc" ? "--doc" : "--schema"];
      }
      const result = await invoke(ctx, config, launch(), argv, { cwd, signal: exec.signal });
      return renderRun(commandLabel(argv), result, config);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `wecom-cli schema ${args.kind}`,
      kind: "wecom-schema",
      rawInput: typeof args.method === "string" ? args.method : ""
    })
  }));
}

/**
 * Start `wecom-cli auth init` as a background job.
 *
 * The login is a human round-trip: the CLI prints a QR/link and then polls for
 * up to five minutes, which must not block a tool call. Registering it as a job
 * lets the model return immediately, read the login URL out of the job output
 * for the operator, and be notified when the scan completes.
 */
function startAuthJob(ctx, config, launch, argv, cwd, exec) {
  const start = () => {
    const spec = {
      argv: [launch.executable, ...launch.args, ...argv],
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: Math.min(config.maxOutputBytes, STDERR_MAX_OUTPUT_BYTES) }
      },
      graceMs: config.graceMs
    };
    const env = childEnvironment(config);
    if (env !== undefined) spec.env = env;

    const proc = ctx.subprocess.spawn(spec);
    let stdoutOffset = 0;
    let stderrOffset = 0;
    return {
      cancel: () => proc.terminate(),
      done: proc.done.then(
        (outcome) => ({
          status: outcome.exitCode === 0 ? "completed" : "failed",
          detail: outcome.signal !== null ? `signal: ${outcome.signal}` : `exit code: ${outcome.exitCode ?? "unknown"}`
        }),
        (error) => ({ status: "failed", detail: messageOf(error) })
      ),
      readOutput: () => {
        const parts = [];
        const stdout = proc.collected.stdout;
        if (stdout !== undefined) {
          const read = stdout.readFrom(stdoutOffset);
          stdoutOffset = read.nextOffset;
          if (read.text.length > 0) parts.push(read.text);
          if (read.lossy) parts.push("[some stdout was dropped from memory; the full stream is in the spill file]");
        }
        const stderr = proc.collected.stderr;
        if (stderr !== undefined) {
          const read = stderr.readFrom(stderrOffset);
          stderrOffset = read.nextOffset;
          if (read.text.length > 0) parts.push(`[stderr]\n${read.text}`);
        }
        return parts.join("");
      }
    };
  };

  const jobs = ctx.get("jobs");
  if (jobs === undefined) {
    return "Background jobs are unavailable in this composition, so the interactive login cannot run inside the session. Ask the operator to run `wecom-cli auth init` in a terminal, then call wecom_status again.";
  }
  const spec = {
    kind: "wecom-auth",
    label: "wecom-cli auth init",
    ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
    run: start
  };
  try {
    const jobId = jobs.start(spec);
    return [
      `Started the WeCom login as background job ${jobId}.`,
      "",
      "The CLI is now waiting for an operator to scan. Read the job output with job_output to the job id above — the first lines contain the login URL (https://work.weixin.qq.com/ai/qc/gen?…) — and give that URL to the operator to open and scan with 企业微信.",
      "Scanning completes on its own; you are told when the job finishes, so do not poll in a loop. Call wecom_status afterwards to confirm `authorized`. Use job_kill on this job if the operator abandons the login."
    ].join("\n");
  } catch (error) {
    return `Could not start the interactive login as a background job (${messageOf(error)}). Ask the operator to run \`wecom-cli auth init\` in a terminal instead, then call wecom_status again.`;
  }
}

function applyAuthTool(ctx, config, launch) {
  ctx.tools.register(defineTool({
    name: "wecom_auth",
    description:
      "Inspect or establish WeCom authorization. action \"show\" prints the current authorization status and robot identity. action \"init\" logs the robot in; it uses the Bot ID + Secret configured on this plugin when both are present (that path is fast and non-interactive), and otherwise starts the interactive scan login as a BACKGROUND JOB — read the job output for the login URL instead of waiting in this call. Call wecom_status first; only log in when the robot is reported unauthorized.",
    parameters: {
      action: { type: "string", required: true, enum: ["show", "init"], description: "\"show\" for the current status; \"init\" to log in (configured credentials, else the interactive scan)." },
      noBrowser: { type: "boolean", description: "For the interactive scan only: do not try to open a browser on the host (`--no-browser`)." },
      outputQrcode: { type: "string", description: "For the interactive scan only: also write the QR code as a PNG to this path (must resolve inside the CLI's working directory)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = workingDirectory(config, exec);
      if (args.action === "show") {
        const result = await invoke(ctx, config, launch(), ["auth", "show"], { cwd, signal: exec.signal });
        return renderRun("wecom-cli auth show", result, config);
      }

      if (!config.allowAuthInit) {
        throw new Error("tool-wecom: the interactive login is disabled for this deployment (allowAuthInit: false)");
      }

      // Configured Bot ID + Secret: a direct, non-interactive login. The CLI
      // takes this pair only as argv, so it is resolved here and passed through
      // — never returned, logged, or persisted by this plugin.
      const creds = await resolveBotCredentials(ctx, config);
      const credArgv = credentialArgs(creds);
      if (credArgv.length > 0) {
        const argv = ["auth", "init", ...credArgv];
        const result = await invoke(ctx, config, launch(), argv, { cwd, signal: exec.signal });
        const secrets = [creds.botSecret, creds.botId];
        if (result.exitCode === 0) {
          const verified = await invoke(ctx, config, launch(), ["auth", "show", "--status"], { cwd, signal: exec.signal });
          return redactSecrets(
            [
              "wecom-cli auth init (configured Bot ID + Secret): succeeded.",
              `authorization: ${verified.stdout.trim() || "(no output)"}`,
              "",
              `Credentials came from: botId=${creds.botIdSource}, botSecret=${creds.botSecretSource}.`,
              "No login is needed again until the token expires."
            ].join("\n"),
            secrets
          );
        }
        // A rejected pair is the common failure (errcode 853000). Report the
        // CLI's own message, then state which sources the pair came from so the
        // operator can tell a wrong secret from an unset/stale one.
        return redactSecrets(
          [
            renderRun(commandLabel(argv), result, config),
            "",
            `Credentials came from: botId=${creds.botIdSource}, botSecret=${creds.botSecretSource}.`,
            "If the CLI reported 853000 (`invalid bot_id or secret`), the value itself is wrong or has been rotated — re-check the Bot ID and Secret at https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21677 (or refresh the credential reference this plugin resolves).",
            "To fall back to the interactive scan login, clear botId/botSecret (and their ...Env references) in this plugin's config."
          ].join("\n"),
          secrets
        );
      }

      // No usable pair configured: the interactive scan, as a background job.
      const argv = ["auth", "init", "--noninteractive"];
      if (args.noBrowser === true) argv.push("--no-browser");
      if (args.outputQrcode !== undefined && args.outputQrcode !== "") argv.push("--output-qrcode", args.outputQrcode);
      const started = startAuthJob(ctx, config, launch(), argv, cwd, exec);
      // Say WHY the scan is being used, since a half-configured pair is the
      // likeliest reason and it is otherwise invisible from the tool result.
      if (creds.botIdSource === "unset" && creds.botSecretSource === "unset") return started;
      return `Bot credentials are only partially configured (botId=${creds.botIdSource}, botSecret=${creds.botSecretSource}), so the configured-credentials login was skipped (the CLI requires both together).\n\n${started}`;
    },
    presentCall: (args) => ({
      card: "generic",
      title: `wecom-cli auth ${args.action}`,
      kind: "wecom-auth",
      rawInput: args.action
    })
  }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputBytes", config.maxOutputBytes);
  assertPositiveInteger("graceMs", config.graceMs);

  // Resolution is lazy (a memoized function, not a value) so a missing CLI
  // surfaces as a tool error carrying install instructions instead of failing
  // the whole preset mount, and so a CLI installed mid-session is picked up by
  // the next call.
  let cached;
  const launch = () => {
    if (cached === undefined) cached = resolveLaunch(config);
    return cached;
  };

  ctx.systemPrompt.section({
    name: "tool:wecom",
    order: 140,
    text:
      "The wecom_* tools drive the official WeCom CLI, which covers 企业微信 messages, mail, docs, sheets, smart sheets, smart docs, 微盘 files, calendar, meetings, todos, contacts and media. " +
      "Start with wecom_status: a missing/outdated CLI or an `unauthorized` robot makes every business call fail, and wecom_auth action \"init\" fixes the latter. " +
      "Never ask the user for a Bot ID or Secret, and never pass one through a tool call: those are host credentials configured in this plugin's own config, and a value typed into the conversation would be written to the session log. If wecom_auth reports that no credentials are configured, tell the user to set them on the host (see this plugin's README) or to complete the interactive scan login the tool offers. " +
      "Before any business command, load the matching `wecomcli-*` skill (for example wecomcli-message, wecomcli-doc, wecomcli-calendar, wecomcli-shared as the shared prerequisite) and follow its call order, target-matching rules and output rules — the skills, not wecom_run's description, define the business workflow. " +
      "Method signatures are not guessable: use wecom_schema (kind \"get\" or \"doc\") to read a method's exact parameters before composing payload, and wecom_run with dryRun:true to validate a request without sending it. " +
      "Never invent, guess, or reuse a stale identifier (chat_id, userid, media_id, docid): every such value must come from this round's own response, and internal identifiers must never be shown to the user — describe the object by its readable name instead."
  });

  const resolvedLauncher = launch;
  if (config.statusTool) applyStatusTool(ctx, config, resolvedLauncher);
  if (config.runTool) applyRunTool(ctx, config, resolvedLauncher);
  if (config.schemaTool) applySchemaTool(ctx, config, resolvedLauncher);
  if (config.authTool) applyAuthTool(ctx, config, resolvedLauncher);
}
export {
  Config,
  DEFAULT_BOT_ID_ENV,
  DEFAULT_BOT_SECRET_ENV,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MINIMUM_CLI_VERSION,
  apply,
  buildRunArgs,
  commandLabel,
  credentialArgs,
  deriveFromNpmShim,
  executableExtensions,
  findOnPath,
  hasBotCredentials,
  inject,
  isOlderThan,
  name,
  parseCliVersion,
  redactSecrets,
  renderRun,
  resolveBotCredentials,
  resolveLaunch,
  validateCommandPath
};
