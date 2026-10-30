# @local/dsh-tool-gitlab

Native Cordis tool plugin exposing GitLab tools against a self-hosted GitLab
REST API (`/api/v4`), authenticated with a **fine-grained personal access
token**. It replaces the `mcp-gitlab` MCP-client row that used to run the
official MCP server through a stdio OAuth bridge: these tools register
in-process, carry no `mcp__gitlab__` prefix, and need no child process.

- Instance: `http://192.168.2.204` (API root `http://192.168.2.204/api/v4`)
- Installed as: `C:\Users\hxy\.dsh\profiles\web\node_modules\@local\dsh-tool-gitlab`
- Mounted by: `D:/git/deepseek-tools/dsh-gitlab-mcp/cordis.patch.yml` (row `tool-gitlab`, inside `preset-gitlab`)

---

## Capability matrix (measured, not assumed)

The plugin registers **only** what the token can actually do. Every row below was
verified against the live instance with `curl`/`fetch` on 2026-10-29; the 403
column quotes GitLab's own `insufficient_granular_scope` answer.

| Area | Available? | Evidence |
| --- | --- | --- |
| Project metadata (`/projects/:id`) | ✅ | 200 with both numeric id and `cx%2Ftrip` |
| Branches / commits / commit diff | ✅ | 200; `ref_name`, `path`, `since`, `until` filters work |
| Repository tree / file content | ✅ | 200; the files endpoint *requires* `ref` (400 without) |
| Issues: list / get / notes | ✅ | 200; `x-total` 9878 issues on `cx/trip` |
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

Consequence for the agent: **labels must already exist** (look them up with
`gitlab_list_labels`), **assignees need numeric user ids** (there is no user
lookup), and **nothing can be deleted** — the tools create and close, never
remove.

To unlock a missing area, edit the token at
`http://192.168.2.204/-/user_settings/personal_access_tokens`, add the scope,
then re-register the corresponding tool in `lib/index.js`.

---

## Search-term rules (measured; the tools enforce them)

This instance runs GitLab's **basic (Postgres) search**, not Elasticsearch, and it
fails *silently*: an unusable term returns HTTP 200 with an empty list, which reads
as "no such issue" when the opposite is true. Both traps below were measured on the
live instance and are enforced in three places — the tool descriptions, the
system-prompt section, and a runtime warning attached to any matching call.

### 1. Minimum term length (CJK 3, ASCII 2)

| Term | Length | Results on cx/trip |
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

For the issue titled `manager-frontend项目webpack升级` (cx/order-frontend-m #16):

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
  name: '@local/dsh-tool-gitlab'
  config:
    apiUrl: http://192.168.2.204/api/v4
    tokenEnv: GITLAB_TOKEN
    timeoutMs: 60000
    maxOutputChars: 200000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `http://192.168.2.204/api/v4` | API root. A missing `/api/v4` is appended (the bare origin serves the web UI and answers 404 HTML) |
| `apiToken` | `""` | Literal token; wins over `tokenEnv` when set. Prefer leaving it empty |
| `tokenEnv` | `GITLAB_TOKEN` | Credential reference resolved through the harness credential store, then the process environment |
| `timeoutMs` | `60000` | Cooperative per-call budget attached to every tool |
| `maxOutputChars` | `200000` | Hard cap on tool output |
| `getProject` … `uploadFile` | `true` | Per-tool switches (one boolean per tool name in camelCase) |

**The token is not in this file.** It lives in `$DSH_HOME/.credentials.yaml`
under `refs: GITLAB_TOKEN: …` and is resolved at call time through
`ctx.get("credentials")` — the credential seam is a soft dependency, so a
composition without it falls back to the `GITLAB_TOKEN` environment variable.
Rotating the token needs no restart.

---

## Install / update

The plugin imports only `@deepseek-ai/*` peer packages and Node builtins, so it
installs as a plain copy — no pnpm step, no link:

```powershell
$src = "D:\git\deepseek-tools\dsh-tool-gitlab"
$dst = "C:\Users\hxy\.dsh\profiles\web\node_modules\@local\dsh-tool-gitlab"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
```

Then reload the profile (the patch file is watched; a restart is the reliable
fallback):

```powershell
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config | Select-String tool-gitlab
```

---

## Smoke test

```powershell
cd D:\git\deepseek-tools\dsh-tool-gitlab

# read-only checks against cx/trip
node smoke-test.mjs

# also exercise the write path in a scratch project
$env:GITLAB_SMOKE_WRITE = '1'
$env:GITLAB_SMOKE_WRITE_PROJECT = 'hexingyu/test-merge'
node smoke-test.mjs

# also exercise an upload
$env:GITLAB_SMOKE_UPLOAD = 'D:\git\deepseek-tools\dsh-tool-gitlab\package.json'
node smoke-test.mjs
```

The test imports the **installed** copy (peer deps resolve there, not in this
checkout) — override with `GITLAB_PLUGIN=<file:///…/lib/index.js>`. It reads the
token from `GITLAB_TOKEN` or from `$DSH_HOME/.credentials.yaml` and never prints
it.

The write path creates one issue and leaves it **closed with a comment**: this
token cannot delete issues, so the test prints the iid it left behind.
