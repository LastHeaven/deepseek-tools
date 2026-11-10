---
description: "Scrape, search, map, crawl and parse through a Firecrawl instance from the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-firecrawl

Native Cordis tool plugin exposing the Firecrawl tools against a **Firecrawl
instance** — self-hosted by default, cloud with `apiUrl: https://api.firecrawl.dev`.
The tools register in-process through the `tools` registry and call the REST API
with the built-in `fetch`, so there is no MCP server, no stdio bridge, no child
process, and no `@mendable/firecrawl-js` dependency.

It ships as a **bundle**: `package.json` declares `dsh.bundle.patch`, the bundled
`cordis.patch.yml` mounts the single `tool-firecrawl` row, and the package
carries its own locales and icon. One `dsh plugin --profile <name> add` installs
and activates it; the profile's Plugins page then turns it on and off like any
other plugin, and edits its parameters on the row's own configuration page.

```yaml
- id: tool-firecrawl
  name: '@deepseek-ai/dsh-tool-firecrawl'
  config:
    apiUrl: http://firecrawl.localhost   # REQUIRED in practice — yours, not ours
```

---

## Tools

| Tool | Firecrawl endpoint | Concurrent |
| --- | --- | --- |
| `firecrawl_scrape` | `POST /v1/scrape` | ✅ |
| `firecrawl_search` | `POST /v2/search` | ✅ |
| `firecrawl_developer_search` | `GET /v2/search/developer` (falls back to `/v2/search?categories=developer` on 404) | ✅ |
| `firecrawl_map` | `POST /v1/map` | ✅ |
| `firecrawl_parse` | `POST /v2/parse` (multipart local file upload) | ✅ |
| `firecrawl_crawl` | `POST /v1/crawl` | ❌ (starts work) |
| `firecrawl_check_crawl_status` | `GET /v1/crawl/{id}` | ✅ |

Every tool returns one canonical string; `output.render` turns it into the single
model-facing text block. Each tool also declares a `presentCall` card
(`kind: scrape | search | map | parse | crawl`) and honours `exec.signal`.

`firecrawl_parse` reads a **local** path, so it needs the file to be readable by
the Host process. Remote URLs belong in `firecrawl_scrape`.

`firecrawl_developer_search` targets the developer index that only the cloud
service answers; on a self-hosted instance the 404 degradation turns it into an
ordinary developer-category web search, so the tool never fails because of the
deployment.

---

## Configuration

Open **Plugins** in the Web sidebar, expand the **Firecrawl** card, then select
the row's **Configure** control: the row title itself is the button, with a `›`
chevron once the row has a page. The page stages text and boolean edits and
writes them on **Save**; nothing is written while you type, and leaving the page
drops the drafts. The API key is the one exception — it has its own **Save key**
control and writes immediately.

| Field | Default | Editable on the page | Meaning |
| --- | --- | --- | --- |
| `apiUrl` | `http://firecrawl.localhost` | ✅ live | Firecrawl base URL. The default matches the bundled patch, so **a deployment that forgets to set it talks to the author's assumed host** — replace it. A blank value fails at mount with the fix in the message |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | ✅ live | Credential reference resolved through the harness credential store, then the process environment. An instance with authentication disabled needs neither |
| `scrape` | `true` | ✅ live | Expose `firecrawl_scrape` |
| `search` | `true` | ✅ live | Expose `firecrawl_search` |
| `developerSearch` | `true` | ✅ live | Expose `firecrawl_developer_search` |
| `map` | `true` | ✅ live | Expose `firecrawl_map` |
| `parse` | `true` | ✅ live | Expose `firecrawl_parse` |
| `crawl` | `true` | ✅ live | Expose `firecrawl_crawl` |
| `checkCrawlStatus` | `true` | ✅ live | Expose `firecrawl_check_crawl_status` |
| `searchMaxResults` | `8` | ✅ live | Default `firecrawl_search` result cap, used when the model omits `limit` |
| `mapMaxResults` | `100` | ✅ live | Default `firecrawl_map` URL cap |
| `crawlMaxResults` | `50` | ✅ live | Default `firecrawl_crawl` page cap |
| `maxOutputChars` | `200000` | ✅ live | Hard cap on each tool's rendered output |
| `apiKey` | `""` | ❌ patch only | Literal bearer token; wins over `apiKeyEnv` when set. Prefer leaving it empty |
| `timeoutMs` | `60000` | ❌ patch only | Cooperative per-call budget attached to every tool |

**Why two fields stay out of the page.** The settings surface projects only
fields a plugin declares `.volatile()`, and a volatile field can change without
rebuilding the plugin. `timeoutMs` is baked into each tool declaration, so a new
value only applies when the definitions are rebuilt; `apiKey` is excluded so a
literal secret never rides the configuration wire — the page edits `apiKeyEnv`
instead and stores the secret itself. Edit both in `cordis.patch.yml`.

**Why the count defaults are read per call.** `searchMaxResults`,
`mapMaxResults`, `crawlMaxResults` and `maxOutputChars` are not frozen into the
registered tool schemas: the schema is built once, at mount, while the page can
change a count at any time. Each call re-reads the live reference and validates
it, so an edited value reaches the very next request and a blanked one fails with
a message naming the configuration page. The price is that a tool description
cannot advertise the current default; it says "the plugin's own default applies"
instead of quoting a number that would go stale.

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
| **Not set** | Neither source has a value; the tools send no `Authorization` header |
| **Unavailable** / **Checking…** | The store was not read (not composed, or still loading) |

**Remove key** deletes the stored value and the badge returns to **Not set**. If
the store reports the reference as read-only, the field is replaced by an
explanation naming the environment variable to set instead — a key that arrives
from the process environment cannot be overwritten from a page.

The tools resolve the key at call time through `ctx.get("credentials")` — a soft
dependency, so a composition without the store falls back to the environment.
Rotating the key needs no restart.

A self-hosted instance with authentication disabled needs no key at all: the
plugin simply omits the `Authorization` header, and that is the normal case for
`http://firecrawl.localhost`.

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
  `disabled: true` override row) — unloads the fiber, so every tool, its prompt
  section, and its tool declaration disappear from the next request.
- **Turn one tool off** on the configuration page — the plugin stays mounted and
  the tool drops out of the model's schema list for the next step, along with its
  system-prompt section. Cheaper when a deployment wants searches but forbids
  crawling, for example.

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
dsh plugin --profile web add D:/git/deepseek-tools/dsh-tool-firecrawl
```

### From a registry (once published)

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-tool-firecrawl
```

### Then point it at your instance

The bundle patch ships `apiUrl: http://firecrawl.localhost` as a placeholder.
Set the real value either on the configuration page, or by overriding the row in
the profile's own `cordis.patch.yml` (that layer applies after every bundle layer,
and a patch replaces the row's **whole** `config`, so restate what you want to
keep):

```yaml
- id: tool-firecrawl
  name: '@deepseek-ai/dsh-tool-firecrawl'
  config:
    apiUrl: http://firecrawl.localhost   # your base URL
    apiKeyEnv: FIRECRAWL_API_KEY
```

Verify composition before booting:

```powershell
dsh --profile web --dump-config   # shows a "# == @deepseek-ai/dsh-tool-firecrawl" layer
```

### Update

Re-run `add` with the new source, then restart the profile. The patch layer is
watched, but a restart is the reliable path for a new `lib/index.js`.

### Remove

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-tool-firecrawl
```

---

## Enable and disable

The bundle is a normal profile entry once installed. All three paths are
equivalent and reversible:

| Surface | How |
| --- | --- |
| Web sidebar → **Plugins** | Toggle the row; the Plugins page writes `disabled` into the profile patch |
| Agent `plugin_manager` tool | Same operation from a conversation (needs `danger-full-access` or approval) |
| Profile `cordis.patch.yml` | Add `- id: tool-firecrawl` with `disabled: true` |

Disabling keeps the package and its configuration, so re-enabling restores the
exact same settings. With HMR enabled in the profile the change applies without a
restart; otherwise it lands on the next boot.

The package is displayed with its own title, description, and icon from
`locale/en.json`, `locale/zh.json`, and `icon.svg`, so an operator can tell the
Firecrawl plugin apart from other tools in the list.

---

## How the configuration page works

The package carries a browser half (`lib/client.js`) beside the Host half. It
registers into the Plugins page's `plugins.row.config` slot under the key
`@deepseek-ai/dsh-tool-firecrawl#tool-firecrawl` — the bundle's package name plus
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
3. `lib/client.js` registers the slot with `locale: "toolFirecrawl"` and declares
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
`useEffect` that never runs would hide every bug inside an effect. Its element
walker also expands function components, because a tree of unrendered
`h(ToggleRow, …)` elements would report zero switches and pass a check that means
to count them.

---

## Checks

Two scripts, neither of which needs the DSH runtime:

```powershell
cd D:/git/deepseek-tools/dsh-tool-firecrawl

# Behaviour and packaging contract: manifest/bundle wiring, localized metadata,
# the browser-half registration contract and render, schema defaults, tool
# registration, prompt-section order, per-tool switches, mount guard,
# live-reference updates, and credential-seam precedence (fetch is stubbed)
node smoke-test.mjs

# Prose contract: re-derives the README's claims from the code and fails when
# they drift — versions, the slot key, which fields are page-editable, the
# credential wire shape, the styling tokens, dictionary duplicates
node doc-check.mjs

# Also drive every tool against the instance
$env:FIRECRAWL_SMOKE_LIVE = '1'
$env:FIRECRAWL_API_URL = 'http://firecrawl.localhost'   # optional override
node smoke-test.mjs
```

`smoke-test.mjs` imports the **installed** bundle by default
(`$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-tool-firecrawl`), because
the `@deepseek-ai/*` peers resolve from a profile, not from this checkout. It
falls back to the checkout when nothing is installed. Overrides: `DSH_HOME`,
`FIRECRAWL_PLUGIN_PROFILE`, `FIRECRAWL_API_URL`, and
`FIRECRAWL_PLUGIN=<file:///…/lib/index.js>`.

The offline section is the packaging contract. It fails if `files` stops shipping
`cordis.patch.yml`, the locales, the icon or `lib/client.js`; if `dsh.client`
disappears or the client half starts importing a Harness Client package; if the
slot key stops matching the patch's row id; if a field the form edits loses its
label in one language; if a schema default disappears; if a per-tool switch stops
hiding its tool; or if the credential store stops outranking the environment.

The browser half is checked by capturing its `window.__ModuleLoader__.load`
registration and rendering both views, so it needs no DOM. The render runs hooks
for real against a ctx that raises the Cordis inject trap and a credential
service that answers the real `RemoteResult` envelope; the assertions also fail
if the key input disappears, if fewer than seven switches render, or if a count
field loses its accepted value.

---

## Known limitations

- **A starter `apiUrl` is a real default, not a placeholder the schema enforces.**
  The bundle has to stay mountable out of the box, so the loud failure lives in
  `apply()` (a blank value) and in this README (a wrong host). Set it.
- **`firecrawl_crawl` starts work and returns only an id.** Polling is a separate
  tool, so a crawl that outlives the tool budget still completes server-side.
- **`firecrawl_parse` uploads a local file**, so it is bounded by the Host's own
  read permissions and by `maxOutputChars` on the way back.
- **The developer index is cloud-only.** A self-hosted instance silently answers
  the category fallback instead of 404-ing to the model.
- **Screenshots and JSON extraction pass through as returned.** The tools do not
  post-process binaries; a `screenshot` format returns whatever the instance
  answers.
- **`timeoutMs` needs a reload.** It is baked into each tool declaration, so the
  page cannot edit it and a patch edit applies when the plugin is rebuilt.
- **The count defaults may lag one step behind the scroll.** A crawl or search
  already in flight keeps the count it started with; the next call picks up the
  new value.
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
  dictionaries, both views, the styling metrics, and every theme token were
  checked programmatically; layout and colour in a live browser were confirmed
  from the running Web UI, not from an automated screenshot.

---

## Version history

| Version | Change |
| --- | --- |
| 1.0.0 | Ships as an installable, toggleable bundle: `dsh.bundle.patch`, locales, icon, `engines.dsh` |
| 1.1.0 | Adds the browser half and the row configuration page. Thirteen `Config` fields become `.volatile()`; all seven tools now register unconditionally and gate on a step-time `when`, and the count defaults are read per call, so a page edit reaches the next request without a reload |
