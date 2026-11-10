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
other plugin.

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

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://context7.com/api` | Context7 REST API base URL. Change only for a mirror or local gateway that proxies the two endpoints above. A blank value fails at mount with the fix in the message |
| `apiKey` | `""` | Literal bearer token; wins over `apiKeyEnv` when set. Prefer leaving it empty |
| `apiKeyEnv` | `CONTEXT7_API_KEY` | Credential reference resolved through the harness credential store, then the process environment. The anonymous tier needs neither |
| `resolveLibraryId` | `true` | Register `context7_resolve_library_id` |
| `queryDocs` | `true` | Register `context7_query_docs` |
| `timeoutMs` | `60000` | Cooperative per-call budget attached to every tool |
| `maxOutputChars` | `200000` | Hard cap on each tool's rendered output |

**The key is not in this file.** It lives in `$DSH_HOME/.credentials.yaml` under
`refs: CONTEXT7_API_KEY: …` and is resolved at call time through
`ctx.get("credentials")` — a soft dependency, so a composition without the store
falls back to the `CONTEXT7_API_KEY` environment variable. Rotating the key
needs no restart, because the store's own watcher refreshes its snapshot.

An unset key is not an error: the hosted API serves anonymous requests with
lower rate limits, and the plugin simply omits the `Authorization` header. A
`429` then surfaces the "create a free API key" hint; with a key configured it
surfaces the plan-upgrade hint instead.

### Per-tool switches vs. the bundle switch

Two independent ways to remove capacity without forking the package:

- **Turn the bundle off** (Plugins page, `plugin_manager`, or a
  `disabled: true` override row) — unloads the fiber, so both tools and their
  prompt sections disappear from the next request.
- **Turn one tool off** in `config` — keeps the fiber and drops just that tool's
  declaration and prompt section. Cheaper when a deployment wants doc lookups but
  wants to keep the model from searching the index, for example.

Both are effect-based: nothing is left registered behind.

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

```powershell
# through the harness credential store, or any editor on the file
# $DSH_HOME/.credentials.yaml -> refs: CONTEXT7_API_KEY: ctx7sk-…
```

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

## Smoke test

```powershell
cd D:/git/deepseek-tools/dsh-tool-context7

# Offline: manifest/bundle wiring, localized metadata, schema defaults,
# tool registration, prompt-section order, per-tool switches, mount guard,
# and credential-seam precedence (fetch is stubbed for that last one)
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

The offline section is the packaging contract — it fails if `files` stops
shipping `cordis.patch.yml`, the locales or the icon, if the patch row stops
naming the package, if a schema default disappears, if a per-tool switch stops
removing its tool, or if the credential store stops outranking the environment.

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
