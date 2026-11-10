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

Open **Plugins** in the Web sidebar, expand this bundle, and select the row's
**Configure** control. The page stages edits and writes them on Save; nothing is
written while you type, and leaving the page drops the drafts.

| Field | Default | Editable on the page | Meaning |
| --- | --- | --- | --- |
| `apiUrl` | `https://context7.com/api` | ✅ live | Context7 REST API base URL. Change only for a mirror or local gateway that proxies the two endpoints above. A blank value fails at mount with the fix in the message |
| `apiKeyEnv` | `CONTEXT7_API_KEY` | ✅ live | Credential reference resolved through the harness credential store, then the process environment. The anonymous tier needs neither |
| `resolveLibraryId` | `true` | ✅ live | Expose `context7_resolve_library_id` |
| `queryDocs` | `true` | ✅ live | Expose `context7_query_docs` |
| `maxOutputChars` | `200000` | ✅ live | Hard cap on each tool's rendered output |
| `apiKey` | `""` | ❌ patch only | Literal bearer token; wins over `apiKeyEnv` when set. Prefer leaving it empty |
| `timeoutMs` | `60000` | ❌ patch only | Cooperative per-call budget attached to every tool |

**Why two fields stay out of the page.** The settings surface projects only
fields a plugin declares `.volatile()`, and a volatile field can change without
rebuilding the plugin. `timeoutMs` is baked into each tool declaration, so a new
value only applies when the definitions are rebuilt; `apiKey` is excluded so a
literal secret never rides the configuration wire — the page edits `apiKeyEnv`
instead and stores the secret itself. Edit both in `cordis.patch.yml`.

**The key is not in this file.** Paste it into the page's **New key** field. That
writes it to `$DSH_HOME/.credentials.yaml` under `refs: CONTEXT7_API_KEY: …`
through the credentials service, so the value crosses the wire in one direction
only and never enters the profile patch. The tools resolve it at call time via
`ctx.get("credentials")` — a soft dependency, so a composition without the store
falls back to the `CONTEXT7_API_KEY` environment variable. Rotating the key needs
no restart, because the store's own watcher refreshes its snapshot.

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

Open the Plugins page → this bundle → the row's **Configure** page → **New key**.
The page writes it through the credentials service, so it lands in
`$DSH_HOME/.credentials.yaml` under `refs:` and never in a patch file. Editing
that file directly works too.

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
`--dsw-alias-*` theme token, so the page follows light/dark switching and a
renamed token degrades appearance without breaking the slot.

---

## Smoke test

```powershell
cd D:/git/deepseek-tools/dsh-tool-context7

# Offline: manifest/bundle wiring, localized metadata, the browser-half
# registration contract, schema defaults, tool registration, prompt-section
# order, per-tool switches, mount guard, live-reference updates, and
# credential-seam precedence (fetch is stubbed for the last two)
node smoke-test.mjs

# Also drive both tools against the Context7 API
$env:CONTEXT7_SMOKE_LIVE = '1'
$env:CONTEXT7_API_KEY = 'ctx7sk-…'            # optional; anonymous works too
node smoke-test.mjs
```

The test imports the **installed** bundle by default
(`$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-tool-context7`), because
the `@deepseek-ai/*` peers resolve from a profile, not from this checkout. It
falls back to the checkout when nothing is installed. Overrides: `DSH_HOME`,
`CONTEXT7_PLUGIN_PROFILE`, `CONTEXT7_API_URL`, and `CONTEXT7_PLUGIN=<file:///…/lib/index.js>`.

The offline section is the packaging contract. It fails if `files` stops shipping
`cordis.patch.yml`, the locales, the icon or `lib/client.js`; if `dsh.client`
disappears or the client half starts importing a Harness Client package; if the
slot key stops matching the patch's row id; if the two dictionaries drift apart;
if a schema default disappears; if a per-tool switch stops hiding its tool; or if
the credential store stops outranking the environment. The browser half is checked
by capturing its `window.__ModuleLoader__.load` registration and rendering both
views with a stubbed React, so it needs no DOM.

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
- **`timeoutMs` needs a reload.** It is baked into each tool declaration, so the
  page cannot edit it and a patch edit applies when the plugin is rebuilt.
- **The page needs the settings composition.** It renders only where the profile
  mounts `config-editor` and `settings` and serves the entry as a volatile form;
  a headless profile keeps the plugin fully working but shows no page.
- **Rendered appearance is unverified here.** The registration, slot key,
  dictionaries, and both views were checked programmatically; the layout in a live
  browser was not, since this session has no browser control.
