---
description: "Resolve Context7 library IDs and read up-to-date library documentation from the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-context7

Native Cordis tool plugin exposing the Context7 documentation tools against the
**hosted Context7 API**. The two tools register in-process through the `tools`
registry and call the REST API with the built-in `fetch`, so there is no MCP
server, no stdio bridge, no child process and no client dependency. It replaces
the older `mcp-context7` MCP client entry with the same two model-facing tools.

It ships as a **bundle**: `package.json` declares `dsh.bundle.patch`, the bundled
`cordis.patch.yml` mounts the single `tool-context7` row, and the package
carries its own locales and icon. One `dsh plugin --profile <name> add` installs
and activates it; the profile's Plugins page then turns it on and off like any
other plugin, and edits its parameters on the row's own configuration page.

```yaml
- id: tool-context7
  name: '@deepseek-ai/dsh-tool-context7'
  config:
    apiUrl: https://context7.com/api
    apiKeyEnv: CONTEXT7_API_KEY
```

---

## Tools

| Tool | Context7 endpoint | Concurrent |
| --- | --- | --- |
| `context7_resolve_library_id` | `GET /v2/libs/search` | ✅ |
| `context7_query_docs` | `GET /v2/context` | ✅ |

Every tool returns one canonical string; `output.render` turns it into the single
model-facing text block. Each tool also declares a `presentCall` card
(`kind: context7-resolve | context7-docs`) and honours `exec.signal`.

`context7_resolve_library_id` maps a package/product name to a
Context7-compatible library ID such as `/mongodb/docs`, reporting snippet count,
source reputation, benchmark score and available versions. `context7_query_docs`
takes that exact ID and returns the documentation text for one concept.

Both tools keep the harness's own guidance phrasing — resolve first, one concept
per query, at most three calls per question — so the model-facing protocol is the
one readers of the stock Context7 tools already expect.

---

## Configuration

Open **Plugins** in the Web sidebar, expand the **Context7 documentation** card,
then select the row's **Configure** control: the row title itself is the button,
with a `›` chevron once the row has a page. The page stages text and boolean
edits and writes them on **Save**; nothing is written while you type, and leaving
the page drops the drafts. The API key is the one exception — it has its own
**Save key** control and writes immediately.

| Field | Default | Editable on the page | Meaning |
| --- | --- | --- | --- |
| `apiUrl` | `https://context7.com/api` | ✅ live | Context7 REST API base URL. Change only for a mirror or local gateway that proxies the two endpoints above. A blank value fails at mount with the fix in the message |
| `apiKeyEnv` | `CONTEXT7_API_KEY` | ✅ live | Credential reference resolved through the harness credential store, then the process environment. The anonymous tier needs neither |
| `resolveLibraryId` | `true` | ✅ live | Expose `context7_resolve_library_id` |
| `queryDocs` | `true` | ✅ live | Expose `context7_query_docs` |
| `maxOutputChars` | `200000` | ✅ live | Hard cap on each tool's rendered output |
| `timeoutMs` | `60000` | ✅ live | Cooperative per-call deadline. A call that reaches it is cancelled. The schema caps it at `2147483647`, the largest delay a timer accepts |
| `apiKey` | `""` | ❌ patch only | Literal bearer token; wins over `apiKeyEnv` when set. Prefer leaving it empty |

**Why one field stays out of the page.** The settings surface projects only
fields a plugin declares `.volatile()`. `apiKey` is excluded so a literal secret
never rides the configuration wire — the page edits `apiKeyEnv` instead and stores
the secret through the credential store. Set it in `cordis.patch.yml`.

### Why `timeoutMs` needs more than `.volatile()`

The timeout is enforced outside this plugin, by
`@deepseek-ai/dsh-tool-call-timeout-policy`, which reads **the definition** on
every dispatch:

```js
// dsh-tool-call-timeout-policy/lib/index.js
const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs;
if (timeoutMs === void 0) return next();
const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT);
```

`defineTool` copies the number it is handed into that definition, so a plain
config field would freeze at mount — the marker alone is not enough. The
definition itself is not frozen (`Object.isFrozen()` is `false`), so
`withLiveTimeout()` redefines `definition.timeoutMs` as a getter over the live
reference:

```js
Object.defineProperty(definition, "timeoutMs", {
  configurable: true,
  enumerable: true,
  get: () => timeoutOf(config)
});
```

Three consequences worth knowing:

- **It is genuinely live.** No rebuild, no second source of truth: the getter is
  what the policy reads, so a page edit arms the next call's deadline.
- **A bad value cannot take the tools down.** `deadline()` throws on a
  non-positive or non-finite timeout, and that throw lands inside the tool-call
  wrapper, so one bad number would fail *every* call rather than one. `timeoutOf()`
  falls back to `DEFAULT_TIMEOUT_MS` for anything unusable, and the schema's
  `min(1).max(2147483647)` plus the loader's re-validation keep the page from
  writing one in the first place. The fallback covers a hand-written patch or an
  `!!js` expression, which the loader does not re-validate.
- **The property keeps its flags**, so `timeoutMs` stays enumerable to anything
  that introspects the definition, and stays configurable so a rebuild can
  redefine it.

### The API key

The key is entered on the page, in the **New key** password field, and written
through the credentials service. It lands in `$DSH_HOME/.credentials.yaml` under
`refs:` and never in a patch file or a settings document; the value crosses the
wire in one direction only, so no read path can return it.

The section header reports the current state:

| Badge | Meaning |
| --- | --- |
| **Configured** + `Source: file` | A key is stored in the credentials file |
| **Configured** + `Source: env` | No stored key, but the named environment variable holds one |
| **Not set** | Neither source has a value; the tools run on the anonymous tier |
| **Unavailable** / **Checking…** | The store was not read (not composed, or still loading) |

**Remove key** deletes the stored value and the badge returns to **Not set**. If
the store reports the reference as read-only, the field is replaced by an
explanation naming the environment variable to set instead — a key that arrives
from the process environment cannot be overwritten from a page.

The tools resolve the key at call time through `ctx.get("credentials")` — a soft
dependency, so a composition without the store falls back to the environment.
Rotating the key needs no restart, because the store's own watcher refreshes its
snapshot.

An unset key is not an error: the hosted API serves anonymous requests with
lower rate limits, and the plugin simply omits the `Authorization` header. A
`429` then surfaces the "create a free API key" hint; with a key configured it
surfaces the plan-upgrade hint instead.

### Where a page edit lands

The page writes through the profile's config editor, so an edit becomes an
override row in the profile's `cordis.patch.yml` — the bundle's own
`cordis.patch.yml` is never touched, and it keeps matching the shipped defaults.
A field set back to the bundle's value is written as a removal, so the profile
patch keeps recording only real departures. **Reset** beside an overridden field
clears that override immediately, without waiting for Save.

### Per-tool switches vs. the bundle switch

Two independent ways to remove capacity without forking the package:

- **Turn the bundle off** (Plugins page, `plugin_manager`, or a
  `disabled: true` override row) — unloads the fiber, so both tools and their
  prompt sections disappear from the next request.
- **Turn one tool off** on the configuration page — the plugin stays mounted and
  the tool drops out of the model's schema list for the next step, along with its
  system-prompt section. Cheaper when a deployment wants doc lookups but wants to
  keep the model from searching the index, for example.

Both are effect-based: nothing is left registered behind. The per-tool switch is a
step-time condition (`tools.register(..., { when })`) reading a live reference, so
flipping it needs no reload — the very next request sees it.

---

## Install

`dsh plugin --profile <name> add <spec>` forwards to pnpm in the profile
directory, links the bundle, and appends it to `dsh.profile.bundles` because the
package declares `dsh.bundle`.

### From this checkout

```powershell
dsh plugin --profile web add D:/git/deepseek-tools/dsh-tool-context7
```

### From a registry (once published)

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-tool-context7
```

### Store the API key (optional)

Open the Plugins page → the **Context7 documentation** card → the row's
**Configure** page → paste into **New key** → **Save key**. The page writes it
through the credentials service, so it lands in `$DSH_HOME/.credentials.yaml`
under `refs:` and never in a patch file. Editing that file directly works too.

Verify composition before booting:

```powershell
dsh --profile web --dump-config   # shows a "# == @deepseek-ai/dsh-tool-context7" layer
```

### Update

Re-run `add` with the new source, then restart the profile. The patch layer is
watched, but a restart is the reliable path for a new `lib/index.js`.

### Remove

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-tool-context7
```

---

## Enable and disable

The bundle is a normal profile entry once installed. All three paths are
equivalent and reversible:

| Surface | How |
| --- | --- |
| Web sidebar → **Plugins** | Toggle the row; the Plugins page writes `disabled` into the profile patch |
| Agent `plugin_manager` tool | Same operation from a conversation (needs `danger-full-access` or approval) |
| Profile `cordis.patch.yml` | Add `- id: tool-context7` with `disabled: true` |

Disabling keeps the package and its configuration, so re-enabling restores the
exact same settings. With HMR enabled in the profile the change applies without a
restart; otherwise it lands on the next boot.

The package is displayed with its own title, description, and icon from
`locale/en.json`, `locale/zh.json`, and `icon.svg`, so an operator can tell the
Context7 plugin apart from other tools in the list.

---

## How the configuration page works

The package carries a browser half (`lib/client.js`) beside the Host half. It
registers into the Plugins page's `plugins.row.config` slot under the key
`@deepseek-ai/dsh-tool-context7#tool-context7` — the bundle's package name plus
the row id its patch declares, which is how the page keys a row's own form. With
that entry present, the row gains a **Configure** control; without it, the row is
read-only.

Three pieces have to line up, and the smoke test asserts all three:

1. `package.json` declares `dsh.client` with `platform: web`, exports
   `./client`, and ships `lib/client.js` in `files`. Without this the browser
   never loads the bundle.
2. The Host half declares the page-editable fields `.volatile()`. That is what
   makes `dsh-settings` project them, and what hands `apply()` live references
   instead of snapshots. Non-volatile fields simply do not appear.
3. `lib/client.js` registers the slot with `locale: "toolContext7"` and declares
   its own `en`/`zh` dictionaries.

The form is plain JavaScript and does not import `@deepseek-ai/dsh-client-ui-primitives`:
all elements are built with `React.createElement`, and every style resolves to a
theme token (`--dsw-alias-*`, `--dsw-radius-*`), so the page follows light/dark
switching and a renamed token degrades appearance without breaking the slot.
Control metrics copy the host's own `sm` size — 28px tall, 12px/18px text,
`border-radius: var(--dsw-radius-sm)` — so the form sits beside host controls
without looking foreign.

### Three things that bite when writing a row-config page

Each of these produced a blank or wrong page during development, so they are
worth knowing before copying this bundle:

- **A thrown component blanks the whole entry.** The slot logs
  `slot entry crashed in '<slot>'` to the browser console and renders nothing
  else, so a broken form looks like an empty page rather than an error. Check the
  console first.
- **Never reach through `ctx.get("remote")` for a namespace.** The value is the
  remote facade's traceable proxy; asking it for `.credentials` re-enters service
  resolution with the dotted key and throws
  `cannot get property "remote.credentials" without inject`. Read the namespace
  by its full name instead: `ctx.get("remote.credentials")` returns `undefined`
  for a name nobody provided, which degrades instead of throwing.
- **`credentials.describe` returns a `RemoteResult` envelope** — `{ ok, value }`
  — not the ref-to-view mapping. Reading it as the mapping yields `undefined` for
  every field, which renders as "not set" *and* "read-only" simultaneously.
  `set` and `unset` are plain promises that reject instead.

The smoke test guards all three: it renders against a ctx whose facade raises the
same trap, unwraps the envelope in its fixture, and runs hooks for real — a stub
`useEffect` that never runs would hide every bug inside an effect.

---

## Checks

Two scripts, neither of which needs the DSH runtime:

```powershell
cd D:/git/deepseek-tools/dsh-tool-context7

# Behaviour and packaging contract: manifest/bundle wiring, localized metadata,
# the browser-half registration contract and render, schema defaults, tool
# registration, prompt-section order, per-tool switches, mount guard,
# live-reference updates, and credential-seam precedence (fetch is stubbed)
node smoke-test.mjs

# Prose contract: re-derives the README's claims from the code and fails when
# they drift — versions, the slot key, which fields are page-editable, the
# credential wire shape, the styling tokens, dictionary duplicates
node doc-check.mjs

# Also drive both tools against the Context7 API
$env:CONTEXT7_SMOKE_LIVE = '1'
$env:CONTEXT7_API_KEY = 'ctx7sk-…'            # optional; anonymous works too
node smoke-test.mjs
```

`smoke-test.mjs` imports the **installed** bundle by default
(`$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-tool-context7`), because
the `@deepseek-ai/*` peers resolve from a profile, not from this checkout. It
falls back to the checkout when nothing is installed. Overrides: `DSH_HOME`,
`CONTEXT7_PLUGIN_PROFILE`, `CONTEXT7_API_URL`, and `CONTEXT7_PLUGIN=<file:///…/lib/index.js>`.

The offline section is the packaging contract. It fails if `files` stops shipping
`cordis.patch.yml`, the locales, the icon or `lib/client.js`; if `dsh.client`
disappears or the client half starts importing a Harness Client package; if the
slot key stops matching the patch's row id; if the two dictionaries drift apart
or a dictionary repeats a key; if a schema default disappears; if a per-tool
switch stops hiding its tool; or if the credential store stops outranking the
environment.

The browser half is checked by capturing its `window.__ModuleLoader__.load`
registration and rendering both views, so it needs no DOM. The render runs hooks
for real against a ctx that raises the Cordis inject trap and a credential
service that answers the real `RemoteResult` envelope; two assertions also fail
if the key input disappears, which is the state the page must never be in.

---

## Known limitations

- **The anonymous tier is rate limited.** That is a property of the service, not
  of the plugin; configure `CONTEXT7_API_KEY` for headroom.
- **`context7_query_docs` needs an exact library ID.** A wrong ID returns the
  "documentation not found" explanation rather than a fuzzy match; call
  `context7_resolve_library_id` first.
- **Doc text is passed through and truncated, not summarised.** A very large
  response is cut at `maxOutputChars` with an explicit truncation note.
- **`apiUrl` cannot be verified at mount.** The default is the hosted service, so
  only a blanked value is rejected eagerly; a wrong mirror surfaces on the first
  call.
- **A value already in flight keeps the old setting.** A request that started
  before a page edit finishes under the value it started with; the next call picks
  up the new one. That is how a cooperative budget works, not a cache.
- **An unusable `timeoutMs` silently falls back.** A value the page cannot write
  (the schema and the loader both refuse it) but a hand-written patch can reaches
  `timeoutOf()` and becomes `DEFAULT_TIMEOUT_MS`. The alternative — letting
  `deadline()` throw — would fail every tool call, so the fallback is deliberate;
  it is also why nothing in the normal path can reach it.
- **The page needs the settings composition.** It renders only where the profile
  mounts `config-editor` and `settings` and serves the entry as a volatile form;
  a headless profile keeps the plugin fully working but shows no page.
- **The key cannot be read back.** There is no "show key" control and no path
  that returns the stored value, by design: the credential seam exposes presence,
  source, and writability only. Re-paste to change it, or **Remove key** to clear.
- **A page edit pins the field at the profile layer.** Config-editor writes a
  complete override, so once a field is edited on the page its value no longer
  follows the bundle's shipped default. **Reset** clears that override.
- **Rendered appearance is unverified in-repo.** The registration, slot key,
  dictionaries, both views, the styling metrics, and all 14 theme tokens were
  checked programmatically; layout and colour in a live browser were confirmed
  from the running Web UI, not from an automated screenshot.

---

## Version history

| Version | Change |
| --- | --- |
| 1.0.0 | Ships as an installable, toggleable bundle: `dsh.bundle.patch`, locales, icon, `engines.dsh` |
| 1.1.0 | Adds the browser half and the row configuration page. Six `Config` fields become `.volatile()`; both tools now register unconditionally and gate on a step-time `when`, so a page edit reaches the next request without a reload. `timeoutMs` becomes live through `withLiveTimeout()`, which installs a getter over the volatile reference because `defineTool` copies the number and the timeout policy reads the definition per dispatch |

The credential fixes and the styling pass since 1.1.0 are internal corrections —
the wire shapes they addressed never worked, so no behaviour changed for anyone
who had not opened the page yet.
