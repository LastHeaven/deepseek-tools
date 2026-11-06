# @deepseek-ai/dsh-tool-gitlab

Native Cordis tool plugin exposing GitLab tools against **any** GitLab instance's
REST API (`/api/v4`), authenticated with a **fine-grained personal access
token**. Nothing about a particular deployment — instance address, token, or
filesystem path — is baked into the source: `apiUrl` is a **required** config
field, so a half-configured deployment fails loudly instead of quietly querying
whatever GitLab the plugin was developed against.

It ships as a **bundle**: `package.json` declares `dsh.bundle.patch`, and the
bundled `cordis.patch.yml` mounts the single `tool-gitlab` row, so one
`dsh plugin … add` installs and activates it. The tools register in-process
through the `tools` registry — no MCP server, no stdio bridge, no child process,
and no `mcp__gitlab__` prefix.

```yaml
- id: tool-gitlab
  name: '@deepseek-ai/dsh-tool-gitlab'
  config:
    apiUrl: https://gitlab.example.com/api/v4   # REQUIRED — yours, not ours
    tokenEnv: GITLAB_TOKEN
```

See [Configuration](#configuration) for every field and [Install](#install)
for the deployment steps.

---

## Capability matrix (measured, not assumed)

The plugin registers **only** what a fine-grained token can do. Every row below
was verified against a real GitLab instance with `curl`/`fetch`; the 403 column
quotes GitLab's own `insufficient_granular_scope` answer. Which rows your
deployment reaches depends on the scopes you grant — the tools degrade with that
same readable message rather than a bare status code, so a narrower token is
supported, it just exposes less.

| Area | Available? | Evidence |
| --- | --- | --- |
| Project metadata (`/projects/:id`) | ✅ | 200 with both numeric id and `group%2Fproject` |
| Branches / commits / commit diff | ✅ | 200; `ref_name`, `path`, `since`, `until` filters work |
| Repository tree / file content | ✅ | 200; the files endpoint *requires* `ref` (400 without) |
| Issues: list / get / notes | ✅ | 200; paging headers (`x-total`, `x-next-page`) present |
| Issues: create / update / add note / link | ✅ | 201/200 (create, close, comment, link all exercised) |
| Labels / milestones (read) | ✅ | 200 |
| Uploads (`POST /projects/:id/uploads`) | ✅ | 201, returns `/uploads/<hash>/<name>` |
| Project-scoped search (`/projects/:id/search`) | ✅ | 200 for blobs, issues, commits, notes, milestones, wiki_blobs |
| Merge requests | ❌ 403 | needs *Merge Request: Read* |
| Pipelines / jobs | ❌ 403 | needs *Pipeline: Read* |
| Tags / releases / environments / wikis | ❌ 403 | needs *Repository Tag: Read* etc. |
| Global search (`/search`) | ❌ 403 | needs *Global Search: Use* |
| Users / groups / project members | ❌ 403 | needs *User: Read* / *Group: Read* / *Member: Read* |
| Create/delete branch, create commit, write file, protect branch | ❌ 403 | needs *Branch: Create/Delete*, *Commit: Create*, *Repository: Create* |
| Create/update/delete labels | ❌ 403 | needs *Label: Create* (writing an existing label name onto an issue does work) |
| Delete issue / note / link / milestone / upload | ❌ 403 | needs *Work Item: Delete* |
| Milestone create & close | ✅ | 201 / 200 (unused by the tools) |

The ❌ rows are a **token** limit, not a plugin limit. Whatever scopes you grant,
the consequence for the agent stays the same unless you add the corresponding
tool: **labels must already exist** (look them up with `gitlab_list_labels`),
**assignees need numeric user ids** (there is no user lookup), and **nothing can
be deleted** — the tools create and close, never remove.

To unlock a missing area: add the scope at
`https://<your-gitlab>/-/user_settings/personal_access_tokens`, then re-register
the corresponding tool in `lib/index.js` and reinstall.

---

## Search-term rules (measured; the tools enforce them)

GitLab's default **basic (Postgres) search** fails *silently*: an unusable term
returns HTTP 200 with an empty list, which reads as "no such issue" when the
opposite is true. Both traps below were measured on a real instance and are
enforced in two places — the tool descriptions, and a runtime warning attached
to any matching call. An instance backed by Elasticsearch (GitLab Advanced
Search) tolerates both, so set `searchRules: false` there to drop the warnings;
the tool description changes with it, so the model is never told a rule that
does not apply.

> **Why not a system-prompt section.** The plugin used to also register one
> `ctx.systemPrompt.section()` per tool, mirroring the description text. With 17
> tools that cost **5,587 characters on every request** on top of the 18,022
> characters of tool schemas, and it duplicated guidance the model already read in
> the descriptions (`gitlab_search_project` alone carried the same rule block
> twice, 780 + 922 chars). The sections were removed and their few unique
> sentences folded into the descriptions; `inject` is now `["tools"]` only.
> Measured total dropped 23,609 → 19,140 characters (≈ −19%).

### 1. Minimum term length (CJK 3, ASCII 2)

| Term | Length | Results in one measured project |
| --- | --- | --- |
| `酒` | 1 | **0** |
| `酒店` | 2 | **0** ← silently dropped |
| `酒店预` | 3 | 20 |
| `酒店预订` | 4 | 20 |
| `h` | 1 | 0 (scope=issues) |
| `ho` | 2 | 20 |
| `hotel` | 5 | 20 |

Short terms are dropped, not rejected. A 2-character Chinese query is the single
most likely way to get a false "not found".

### 2. ASCII glued to CJK is not tokenized alone

For an issue titled `manager-frontend项目webpack升级`:

| Term | Results |
| --- | --- |
| `webpack` | **0** ← the word is glued to Chinese text |
| `pack` | 1 ← a *different* issue (matched `"package"` in a description) |
| `webpack升` | 1 ← including the adjacent CJK char fixes it |
| `项目webpack` | 1 |
| `manager` | 1 |

So `pack` "working" is a false positive, not evidence the index works. Include an
adjacent CJK character when searching an ASCII word that sits inside Chinese text.

### Where the rules apply — and where they do not

`/projects/:id/search` (scopes issues/blobs/commits/notes/milestones) and the
`/projects/:id/issues?search=` filter behave identically on both rules. Both are
warned.

The label and milestone **list filters** are ordinary substring filters, NOT the
search backend, so they are exempt — `labels?search=b` and `milestones?search=维`
both work. Do not apply the 3-character rule to them.

### What the model sees

When a search returns nothing, the tool appends a NOTE explaining that the term was
probably unusable and asking for a retry, so an empty result cannot be reported as
"does not exist" without a second attempt. When a term violates a rule it also gets
a `WARNING —` line naming the exact fix.

---

## Tools (17)

Read-only (`isConcurrencySafe: true`):

| Tool | Purpose |
| --- | --- |
| `gitlab_get_project` | Project metadata, default branch, feature flags; turns `group/project` into a numeric id |
| `gitlab_list_branches` | Branches with head commit + default/protected/merged flags; `search` filter |
| `gitlab_list_commits` | Commit list filtered by ref / path / author / since / until |
| `gitlab_get_commit` | One commit's full message, plus its diff (`diff: true`, `filePath`, `maxDiffChars`) |
| `gitlab_list_tree` | Files and directories at a ref/path; `recursive` |
| `gitlab_get_repository_file` | File text at a ref; refuses binaries and oversize files |
| `gitlab_list_issues` | Issues by state / labels / milestone / assignee / author / search |
| `gitlab_get_issue` | One issue + optional comments |
| `gitlab_list_issue_notes` | Comment thread, newest first by default |
| `gitlab_list_labels` | Label names, colors, priorities |
| `gitlab_list_milestones` | Milestone iids/titles/state/due date |
| `gitlab_search_project` | Keyword search inside one project (blobs/issues/notes/commits/milestones/wiki_blobs) |

Writes (`isConcurrencySafe: false`):

| Tool | Purpose |
| --- | --- |
| `gitlab_create_issue` | Create an issue (title, markdown description, existing labels, milestone, due date, confidentiality) |
| `gitlab_update_issue` | Update title/description/labels/milestone/assignees/due date; `stateEvent: close\|reopen` |
| `gitlab_add_issue_note` | Comment on an issue |
| `gitlab_link_issues` | `relates_to` / `blocks` / `is_blocked_by` |
| `gitlab_upload_file` | Upload a local file, return the `/uploads/...` path and markdown |

Notes on the write contract:

- `gitlab_update_issue`'s `description` **replaces** the stored text; read first
  with `gitlab_get_issue` and resend the full edited markdown.
- Comments cannot be edited or deleted; write the final text in one pass.
- Attachment descriptions must use the `/uploads/<hash>/<name>` path returned by
  `gitlab_upload_file` — never a raw branch URL.

---

## Configuration

```yaml
- id: tool-gitlab
  name: '@deepseek-ai/dsh-tool-gitlab'
  config:
    apiUrl: https://gitlab.example.com/api/v4   # REQUIRED
    tokenEnv: GITLAB_TOKEN
    searchRules: true
    timeoutMs: 60000
    maxOutputChars: 200000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | **none — required** | API root including `/api/v4`. A missing `/api/v4` is appended (the bare origin serves the web UI and answers 404 HTML). Omitting it fails the plugin at mount with an actionable message |
| `apiToken` | `""` | Literal token; wins over `tokenEnv` when set. Prefer leaving it empty |
| `tokenEnv` | `GITLAB_TOKEN` | Credential reference resolved through the harness credential store, then the process environment |
| `searchRules` | `true` | Emit the basic-search term warnings and include them in the tool description. Set `false` on an Elasticsearch-backed instance |
| `timeoutMs` | `60000` | Cooperative per-call budget attached to every tool |
| `maxOutputChars` | `200000` | Hard cap on tool output |
| `getProject` … `uploadFile` | `true` | Per-tool switches (one boolean per tool name in camelCase) |

**The token is not in this file.** It lives in `$DSH_HOME/.credentials.yaml`
under `refs: GITLAB_TOKEN: …` and is resolved at call time through
`ctx.get("credentials")` — the credential seam is a soft dependency, so a
composition without it falls back to the `GITLAB_TOKEN` environment variable.
Rotating the token needs no restart.

---

## Install

`package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` mounts the one
`tool-gitlab` row — so this installs as a bundle, not as a hand-copied module.
`dsh plugin add` picks up the bundle, adds it to `dsh.profile.bundles`, and
activates it in the same step.

### From a local checkout

```powershell
dsh plugin --profile web add <path-to-dsh-tool-gitlab>
```

### From a registry (once published)

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-tool-gitlab
```

### Then point it at your instance

The bundled patch ships the placeholder
`apiUrl: https://gitlab.example.com/api/v4`; replace it in the profile's
`cordis.patch.yml` (that file overrides bundle layers, so the placeholder stays
as packaging metadata):

```yaml
- id: tool-gitlab
  name: '@deepseek-ai/dsh-tool-gitlab'
  config:
    apiUrl: https://gitlab.example.com/api/v4   # your API root, /api/v4 included
    tokenEnv: GITLAB_TOKEN
```

…and store the token (or export it as `GITLAB_TOKEN`):

```yaml
# $DSH_HOME/.credentials.yaml
refs:
  GITLAB_TOKEN: glpat-…
```

Verify composition, then restart the profile:

```powershell
dsh --profile web --dump-config | Select-String tool-gitlab -Context 0,6
```

### Update

Re-run `add` with the new source, then restart. The bundle patch is watched, but
a restart is the reliable path.

---

## Smoke test

```powershell
cd <path-to-dsh-tool-gitlab>

# GITLAB_API_URL is required — there is no built-in instance
$env:GITLAB_API_URL = 'https://gitlab.example.com/api/v4'
$env:GITLAB_SMOKE_PROJECT = 'group/project'
node smoke-test.mjs

# also exercise the write path in a scratch project
$env:GITLAB_SMOKE_WRITE = '1'
$env:GITLAB_SMOKE_WRITE_PROJECT = 'group/scratch'
node smoke-test.mjs

# also exercise an upload
$env:GITLAB_SMOKE_UPLOAD = '<path-to-dsh-tool-gitlab>\package.json'
node smoke-test.mjs
```

The test imports the **installed** bundle (peer deps resolve from the profile's
`node_modules` and the DSH fallback layer, not from this checkout) — it defaults
to `$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-tool-gitlab`, with
`DSH_HOME`, `GITLAB_PLUGIN_PROFILE`, and `GITLAB_PLUGIN=<file:///…/lib/index.js>`
as overrides. It reads the token from `GITLAB_TOKEN` or from
`$DSH_HOME/.credentials.yaml` and never prints it.

The write path creates one issue and leaves it **closed with a comment**: a
token that cannot delete issues means the test prints the iid it left behind.
