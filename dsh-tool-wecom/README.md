# @deepseek-ai/dsh-tool-wecom

Model-facing **企业微信 (WeCom)** tools for DSH, driving the official
[`@wecom/cli`](https://www.npmjs.com/package/@wecom/cli) (`wecom-cli`).

A native Cordis Host plugin: it registers tools into `ctx.tools` and spawns the
CLI through the harness's `ctx.subprocess` seam. No MCP child process, no
`mcp__` prefix, no third-party npm dependency.

---

## Why one generic runner instead of one tool per method

`wecom-cli` is **discovery-driven**: the service catalogue and every method's
parameter schema are fetched from the WeCom backend at runtime, so the command
tree does not exist at build time. On CLI `1.2.1`:

```
14 services, ~100 methods
  message  mail  doc  sheet  smartsheet  smartpage
  disk  calendar  meeting  todo  contact  media  chat  identity
```

Registering one DSH tool per method would add ~100 catalog entries that go stale
the moment the backend adds a method — and a stale, silently wrong tool schema
is worse than none. So this plugin exposes a small **stable** surface and leaves
the per-domain business rules where they already live: the `wecomcli-*` Agent
Skills.

## Tools

| Tool | Purpose |
| --- | --- |
| `wecom_status` | Preflight. CLI version, authorization state, resolved executable. **Call first.** |
| `wecom_run` | Invoke any method: `command: ["message","aibot","sessions","list"]`. |
| `wecom_schema` | Discovery. `kind: list \| get \| doc \| schema` — read a method's exact parameters instead of guessing. |
| `wecom_auth` | `action: "show"` for status; `action: "init"` to start the interactive login. |

### `wecom_run`

```jsonc
{
  "command": ["contact", "users", "search"],   // method path, one array entry per segment
  "payload": { "keywords": ["周报"], "limit": 10 }, // -> --json '<payload>'
  "set": ["extra.flag=true"],                  // -> --set path=value (repeatable)
  "dryRun": true,                              // validate locally, send nothing
  "pageCount": 5,                              // -> --page-count 5 (NDJSON output)
  "outputDir": "./out"                         // -> --output-dir ./out
}
```

The method path is passed as **separate argv elements** and the body as a single
`--json` element, so no shell ever re-parses it. A payload containing quotes,
`&`, `|`, spaces or CJK text round-trips byte-exact (verified with `--dry-run`).

`exit code 2` is wecom-cli's usage-error signal; the rendered result then appends
a hint pointing at `wecom_schema` / `dryRun`.

### `wecom_auth init`

Two paths, chosen automatically:

**A. Configured Bot ID + Secret** — if the plugin has a complete credential
pair, `init` logs in directly and non-interactively. This is the fast path.

**B. Interactive scan** — with no credentials configured, `init` registers a
**background job** and returns immediately, because the CLI prints a QR code and
then polls for up to 5 minutes, and blocking a tool call on that would be
useless:

```
Started the WeCom login as background job wecom-auth-1.
... read the job output with job_output for the login URL ...
```

The operator scans; the job settles; the model is notified and re-checks with
`wecom_status`. Disable login entirely with `allowAuthInit: false`.

> A *half*-configured pair (only one of the two) does not attempt path A:
> `wecom-cli` declares `--bot-id` and `--secret` with `requires` on each other,
> so a lone flag is a usage error. The tool says which half is missing and falls
> back to the scan.

## Configuring the Bot ID and Secret

`wecom-cli` accepts a Bot ID + Secret **only** as hidden argv flags — it has no
environment-variable or config-file input for them (verified: with only env vars
set, `auth init` falls through to the QR flow). So this plugin reads the pair
from its own config and passes it to the CLI on your behalf.

Get the Bot ID and Secret from
<https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21677>.

### Recommended: credential references

Leave `botId`/`botSecret` empty and let the defaults resolve
`WECOM_CLI_BOT_ID` / `WECOM_CLI_BOT_SECRET`. Only a **name** lives in the
composition file; the value lives in DSH's credential store
(`$DSH_HOME/.credentials.yaml`, mode 0600). Either route works with no edit to
the preset:

```yaml
# $DSH_HOME/.credentials.yaml  (0600)
refs:
  WECOM_CLI_BOT_ID: "<your bot id>"
  WECOM_CLI_BOT_SECRET: "<your secret>"
```

```powershell
# …or plain environment variables, exported before DSH starts
setx WECOM_CLI_BOT_ID     "<your bot id>"
setx WECOM_CLI_BOT_SECRET "<your secret>"
```

Resolution order is process environment → provider-managed store → `.env`
files. It is per call, so a rotated secret reaches the next tool call without a
plugin restart.

Point the plugin at different names if you prefer:

```yaml
- id: tool-wecom
  name: '@deepseek-ai/dsh-tool-wecom'
  config:
    botIdEnv: MY_WECOM_BOT_ID
    botSecretEnv: MY_WECOM_BOT_SECRET
```

### Alternative: literal values

```yaml
- id: tool-wecom
  name: '@deepseek-ai/dsh-tool-wecom'
  config:
    botId: '<your bot id>'
    botSecret: '<your secret>'
```

`botSecret` carries `role("secret")` in the schema, which marks it for settings
UIs — but be aware of what a literal in a composition file actually means:

- The file is cleartext, and on Windows its inherited ACL grants
  `BUILTIN\Administrators` plus your user account.
- `dsh --dump-config` prints config values verbatim.
- `agentPresets.copy()` copies the whole preset directory, secret included.

Use the reference form unless you have a specific reason not to.

### What this plugin does and does not do with the secret

| | |
| --- | --- |
| Logged / returned / persisted by the plugin? | **No.** It goes from config straight into the child argv. |
| Masked in tool output? | **Yes** — `--bot-id *** --secret ***`, and `redactSecrets()` strips any accidental echo from the model-facing result. |
| Written to the session log? | **Not by this plugin.** This is why the tools take no credential parameters: a secret passed through a tool call *would* be persisted (DSH records tool-call arguments verbatim in `session.jsonl`), which would defeat the point of an encrypted credential store. |
| Visible on the host process list? | **Yes.** argv is the only channel `wecom-cli` offers, so another process on the same machine can read the secret from the command line while `auth init` runs. The credential-reference route keeps the value out of the composition file and the session log; it cannot change this. |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `cliPath` | `""` | Explicit CLI path. Empty = auto-detect. A `.js` entry runs under `nodePath`; a `.cmd`/`.bat` runs via `cmd.exe`. |
| `nodePath` | `""` | Node binary for a JS entry point. Default: the harness's own `process.execPath`. |
| `cwd` | `""` | Fallback working directory when the session has none. |
| `timeoutMs` | `60000` | Cooperative per-call budget. Raise for large media transfers. |
| `maxOutputBytes` | `524288` | Per-stream capture cap (overflow keeps the tail and is reported). |
| `graceMs` | `2000` | Termination grace period for the process range. |
| `configDir` | `""` | `WECOM_CLI_CONFIG_DIR` override. |
| `tmpDir` | `""` | `WECOM_CLI_TMP_DIR` override. |
| `logLevel` | `""` | `WECOM_CLI_LOG_LEVEL` (e.g. `debug`). |
| `statusTool` / `runTool` / `schemaTool` / `authTool` | `true` | Enable each tool individually. |
| `allowAuthInit` | `true` | Permit `wecom_auth init`. |
| `prettyPrintJson` | `true` | Pretty-print JSON responses within the capture budget. |
| `botId` / `botSecret` | `""` | Literal credentials. Prefer the references below. |
| `botIdEnv` | `WECOM_CLI_BOT_ID` | Credential reference for the Bot ID. |
| `botSecretEnv` | `WECOM_CLI_BOT_SECRET` | Credential reference for the Secret. |

## How the CLI is launched (the non-obvious part)

On Windows, `npm install -g` puts a **`wecom-cli.CMD`** shim on `PATH` which
forwards to `node .../@wecom/cli/bin/wecom.js`. That is a problem:

- Node refuses to spawn a `.cmd` directly (it throws `EINVAL` on Node ≥ 20).
- The usual workaround, `shell: true`, **concatenates arguments instead of
  passing an argv array** — which corrupts exactly the JSON payloads this
  plugin sends.

So the plugin resolves to something spawnable *without a shell*, in order:

1. `cliPath` from config.
2. The platform-native binary of the npm optional-dependency package
   (`@wecom/cli-<platform>-<arch>/bin/wecom-cli[.exe]`), found by resolving
   `@wecom/cli/package.json` **from the shim's own directory** — the only place
   it is guaranteed to resolve from, since the plugin lives in the harness tree.
3. `node <…>/@wecom/cli/bin/wecom.js` (the entry the shim itself runs).
4. Last resort on Windows: `cmd.exe /d /s /c <shim> …`, with each CLI argument
   still passed as a **separate** `/c` argument (no re-parsing of the payload).

## Sandbox posture

This plugin spawns through **`ctx.subprocess`**, the harness's *unconfined*
process seam — the file sandbox is applied by `ctx.shell` executors, and that
seam's spec carries no sandbox policy at all.

That is deliberate and required: `wecom-cli` keeps its encrypted credentials in
`~/.config/wecom/credentials.enc` and downloads media to its own temp root,
outside any workspace. A preset is exactly as privileged as the plugins it
names, so the capability is granted **by mounting this row**, never by relaxing
a sandbox at runtime.

For the same reason the plugin row must **not** sit inside an `isolate` realm.
It publishes no service; it consumes the host's single `subprocess` (and
`tools` / `systemPrompt`) instance. A realm hides those host services and the
row parks forever on `waiting for subprocess` — verified against the real
loader:

```
1 row(s) did not activate:
tool-wecom (@deepseek-ai/dsh-tool-wecom): waiting for subprocess
```

`jobs` is read optionally via `ctx.get('jobs')`, so a composition without it
degrades only the `auth init` branch.

## Install

```powershell
$src = "D:\git\deepseek-tools\dsh-tool-wecom"
$dst = "$env:DSH_HOME\profiles\web\node_modules\@deepseek-ai\dsh-tool-wecom"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
```

Then add the row to a preset composition (see
`~/.dsh/.agent-presets/wecom/agent.cordis.yml` for the working example), and
mount-validate it.

## Prerequisite

```powershell
npm install -g @wecom/cli   # Node >= 18
```

Then log in **either** by configuring a Bot ID + Secret (see above, which makes
`wecom_auth action:"init"` non-interactive) **or** by running the interactive
scan once:

```powershell
wecom-cli auth init
```

The scan cannot be driven from inside a DSH session — `--manual` requires a real
TTY (else `893001 手动输入需要终端`), and a `.CMD`-wrapped interactive prompt is
not scriptable. Agents should use `wecom_auth action:"init"` and hand the login
URL to a human instead.

`wecom_status` reports the CLI version, the authorization state, and which
executable was resolved; it fails with the install command when the CLI is
absent.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Zero-runtime-dependency ESM package; `@deepseek-ai/*` are peers. |
| `lib/index.js` | `name` / `inject` / `Config` / `apply` plus the four tool registrations. |
| `smoke-test.mjs` | Drives the real `apply()` with a fake ctx backed by the real CLI. |
| `verify-skills.mjs` | Validates that every bundled `wecomcli-*` skill satisfies DSH's skill contract. |

Both scripts must run from a directory where `@deepseek-ai/*` resolves — i.e.
from the profile's `node_modules/@deepseek-ai/dsh-tool-wecom`, or any tree with
those packages above it:

```powershell
cd "$env:DSH_HOME\profiles\web\node_modules\@deepseek-ai\dsh-tool-wecom"
Copy-Item D:\git\deepseek-tools\dsh-tool-wecom\*.mjs .
node smoke-test.mjs                                     # plugin logic
node verify-skills.mjs "$env:DSH_HOME\.agent-presets\wecom\skills"
```
