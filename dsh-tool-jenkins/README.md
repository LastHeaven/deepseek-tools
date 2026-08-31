# @deepseek-ai/dsh-tool-jenkins

Model-facing Jenkins CI tools as a **native Cordis tool plugin** (same pattern
as `dsh-tool-firecrawl` / `dsh-tool-context7` in this repo): it registers the
tools in-process through the `tools` registry and calls the Jenkins REST API
with `fetch` — no MCP layer, no child process.

## Deployment (scoped to the `jenkins-ci` agent preset)

This plugin is **not** wired into any profile's `cordis.patch.yml`. It is
installed into the profile's `node_modules` and mounted only by the
`jenkins-ci` **agent preset**, so only sessions running that preset see the
tools.

- Plugin install (方式 A copy): `C:\Users\hxy\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-tool-jenkins\`
- Agent preset: `C:\Users\hxy\.dsh\.agent-presets\jenkins-ci\`
  - `preset.yml` — display metadata
  - `agent.cordis.yml` — composition rows (persona, pwsh/fs/jobs/todo/ask-user
    follow-up tools, and the `tool-jenkins` row with its config)

Preset discovery requires the plugin to resolve from the profile's base URL —
verified with `scanRoot` against `C:/Users/hxy/.dsh/profiles/web/` (healthy, no
`broken` marker).

## Target controller

Jenkins **2.150.2** at `http://192.168.2.203:8080/jenkins` (sub-path deploy,
security enabled: anonymous `/api/json` reads return **403**).

## Tools

| Tool | Endpoint(s) | Auth needed |
| --- | --- | --- |
| `jenkins_list_jobs` | `GET /api/json?tree=jobs[…]` (root or folder) | read |
| `jenkins_get_job` | `GET /job/<path>/api/json?tree=…` — params, health, last builds | read |
| `jenkins_build_status` | `GET /job/<path>/<n>/api/json?tree=…` (`lastBuild` default) | read |
| `jenkins_console_output` | `GET /job/<path>/<n>/logText/progressiveText?start=<offset>` with `tail` | read |
| `jenkins_trigger_build` | `POST /job/<path>/build` or `/buildWithParameters` (crumb + Basic auth) | **write** |
| `jenkins_queue_item` | `GET /queue/item/<id>/api/json?tree=…` | read |
| `jenkins_nodes` | `GET /computer/api/json?tree=…` | read |

Folder jobs use slash-joined paths (`folder/subjob`); the plugin maps them to
`/job/folder/job/subjob` itself.

## Parameterized builds

`jenkins_trigger_build` fully supports parameterized jobs (e.g. `test-sub-module`
taking `module` and `option`):

1. It first fetches the job's declared parameter definitions
   (`property[parameterDefinitions[…]]` — the Jenkins field is `property`,
   **singular**; a `properties` payload shape is also tolerated).
2. Validation before queueing:
   - **unknown parameter names** are rejected, listing the valid ones (with
     their defaults) — no silent default-value builds from typos;
   - **choice parameters** reject values outside `choices` (with the allowed
     list in the error);
   - **required parameters** (no default) missing from the call are rejected;
   - calling a parameterized job with all-default parameters and no
     `parameters` is allowed and still routed through `buildWithParameters`
     (plain `POST /build` is rejected by Jenkins for parameterized jobs).
3. Values are submitted as `application/x-www-form-urlencoded` form fields to
   `buildWithParameters`; non-string values are stringified.

Example — trigger `test-sub-module` with both parameters:

```
jenkins_trigger_build(job="test-sub-module", parameters={"module": "user-service", "option": "rebuild"})
```

`jenkins_get_job` shows the declared parameters (names, types, defaults,
choices) so the exact names can be confirmed before triggering; the
`actions[parameters]` in `jenkins_build_status` reports what a past build
actually received.

## Config (the `tool-jenkins` row in `agent.cordis.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `http://192.168.2.203:8080/jenkins` | Controller base URL **including** context path |
| `username` | `''` | Jenkins user for Basic auth (empty = anonymous) |
| `apiToken` | `''` | **API token OR the account's real login password** — Jenkins 2.150.2 Basic auth accepts both; token recommended (revocable, no password reuse) |
| per-tool toggles | `true` | `listJobs`/`getJob`/`buildStatus`/`consoleOutput`/`triggerBuild`/`queueItem`/`nodes` |
| `timeoutMs` | `60000` | Per-call cooperative timeout |
| `maxOutputChars` | `200000` | Output truncation cap |

`jenkins_trigger_build` refuses to run without credentials and throws a
pointed error instead of an opaque 403. CSRF crumbs are fetched from
`/crumbIssuer/api/json` per POST and merged into the headers.

## Verification

`smoke-test.mjs` imports the **installed** copy (peer deps resolve only there),
registers all 7 tools with a fake ctx, and exercises them against the live
controller. Anonymous run expectations: reads fail with the 403 guidance
message, `jenkins_trigger_build` fails with the dedicated credentials error,
and every registered tool survives a no-crash `execute()` round trip. Set
`JENKINS_USER` / `JENKINS_TOKEN` env vars before running it to also exercise
authenticated reads.

```powershell
node D:\git\deepseek-tools\dsh-tool-jenkins\smoke-test.mjs
```
