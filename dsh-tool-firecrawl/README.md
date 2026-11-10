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
other plugin.

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

```yaml
- id: tool-firecrawl
  name: '@deepseek-ai/dsh-tool-firecrawl'
  config:
    apiUrl: http://firecrawl.localhost
    apiKeyEnv: FIRECRAWL_API_KEY
    timeoutMs: 60000
    maxOutputChars: 200000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `http://firecrawl.localhost` | Firecrawl base URL. The default matches the bundled patch, so **a deployment that forgets to set it talks to the author's assumed host** — replace it. A blank value fails at mount with the fix in the message |
| `apiKey` | `""` | Literal bearer token; wins over `apiKeyEnv` when set. Prefer leaving it empty |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | Credential reference resolved through the harness credential store, then the process environment. An instance with authentication disabled needs neither |
| `scrape` … `checkCrawlStatus` | `true` | Per-tool switches (one boolean per tool: `scrape`, `search`, `developerSearch`, `map`, `parse`, `crawl`, `checkCrawlStatus`) |
| `timeoutMs` | `60000` | Cooperative per-call budget attached to every tool |
| `searchMaxResults` | `8` | Default `firecrawl_search` result cap |
| `mapMaxResults` | `100` | Default `firecrawl_map` URL cap |
| `crawlMaxResults` | `50` | Default `firecrawl_crawl` page cap |
| `maxOutputChars` | `200000` | Hard cap on each tool's rendered output |

**The key is not in this file.** It lives in `$DSH_HOME/.credentials.yaml` under
`refs: FIRECRAWL_API_KEY: …` and is resolved at call time through
`ctx.get("credentials")` — a soft dependency, so a composition without the store
falls back to the `FIRECRAWL_API_KEY` environment variable. Rotating the key
needs no restart.

### Per-tool switches vs. the bundle switch

Two independent ways to remove capacity without forking the package:

- **Turn the bundle off** (Plugins page, `plugin_manager`, or a
  `disabled: true` override row) — unloads the fiber, so every tool, its prompt
  section, and its tool declaration disappear from the next request.
- **Turn one tool off** in `config` — keeps the fiber and drops just that tool's
  declaration and prompt section. Cheaper when a deployment wants searches but
  forbids crawling, for example.

Both are effect-based: nothing is left registered behind.

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
Override the row in the profile's own `cordis.patch.yml` (that layer applies
after every bundle layer, and a patch replaces the row's **whole** `config`, so
restate what you want to keep):

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

## Smoke test

```powershell
cd D:/git/deepseek-tools/dsh-tool-firecrawl

# Offline: manifest/bundle wiring, schema defaults, tool registration, switches
node smoke-test.mjs

# Also drive every tool against the instance
$env:FIRECRAWL_SMOKE_LIVE = '1'
$env:FIRECRAWL_API_URL = 'http://firecrawl.localhost'   # optional override
node smoke-test.mjs
```

The test imports the **installed** bundle by default
(`$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-tool-firecrawl`), because
the `@deepseek-ai/*` peers resolve from a profile, not from this checkout. It
falls back to the checkout when nothing is installed. Overrides:
`DSH_HOME`, `FIRECRAWL_PLUGIN_PROFILE`, and `FIRECRAWL_PLUGIN=<file:///…/lib/index.js>`.

The offline section is the packaging contract — it fails if `files` stops
shipping `cordis.patch.yml` or the locales, if the patch row stops naming the
package, if a schema default disappears, or if a per-tool switch stops removing
its tool.

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
