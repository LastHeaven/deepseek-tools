# @deepseek-ai/dsh-tool-firecrawl

Native [Cordis](https://github.com/cordiverse/cordis) tool plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that exposes
the Firecrawl tools in-process against a **self-hosted** Firecrawl instance.

It replaces the `firecrawl-mcp` + `firecrawl-filter.mjs` stdio proxy: the same
seven model-facing tools are registered directly through the `tools` registry
and call the Firecrawl REST API with the built-in `fetch`, so there is no child
process, no MCP JSON-RPC layer, and no `@mendable/firecrawl-js` dependency.

## Tools

| Tool | Firecrawl endpoint |
| --- | --- |
| `firecrawl_scrape` | `POST /v1/scrape` |
| `firecrawl_search` | `POST /v2/search` |
| `firecrawl_developer_search` | `GET /v2/search/developer` (falls back to `/v2/search?categories=developer` on 404) |
| `firecrawl_map` | `POST /v1/map` |
| `firecrawl_parse` | `POST /v2/parse` (multipart local file upload) |
| `firecrawl_crawl` | `POST /v1/crawl` |
| `firecrawl_check_crawl_status` | `GET /v1/crawl/{id}` |

## Install

The plugin has no runtime npm dependencies; its `@deepseek-ai/*` peers resolve
through DSH's maintained module fallback. Drop the package into the profile's
`node_modules` and add a loader entry to `cordis.patch.yml`:

```yaml
- insert:
    - id: tool-firecrawl
      name: '@deepseek-ai/dsh-tool-firecrawl'
      config:
        apiUrl: http://firecrawl.localhost   # self-hosted instance
        # apiKey: ''                         # omit/empty when auth is disabled
```

## Config

| Field | Default | Description |
| --- | --- | --- |
| `apiUrl` | `http://firecrawl.localhost` | Self-hosted Firecrawl base URL. |
| `apiKey` | `""` | Bearer token; empty disables the `Authorization` header. |
| `scrape` / `search` / `developerSearch` / `map` / `parse` / `crawl` / `checkCrawlStatus` | `true` | Per-tool enable flags. |
| `timeoutMs` | `60000` | Cooperative tool-call budget attached to each tool. |
| `searchMaxResults` | `8` | Default `firecrawl_search` result cap. |
| `mapMaxResults` | `100` | Default `firecrawl_map` URL cap. |
| `crawlMaxResults` | `50` | Default `firecrawl_crawl` page cap. |
| `maxOutputChars` | `200000` | Cap on each tool's rendered model-facing output. |

## Test

`smoke-test.mjs` drives `apply()` with a fake context and runs every tool's
`execute()` against the live instance (it imports the *installed* copy under
`profiles/web/node_modules`). Run it after installing:

```sh
node dsh-tool-firecrawl/smoke-test.mjs
```
