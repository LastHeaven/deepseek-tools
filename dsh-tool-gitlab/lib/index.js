// @local/dsh-tool-gitlab
//
// Native Cordis tool plugin exposing GitLab tools against a self-hosted GitLab
// instance's REST API, authenticated with a *fine-grained* personal access
// token. This is the in-process replacement for the `mcp-gitlab` MCP client
// entry (which needed an OAuth `mcp`-scope token and a stdio bridge): the tools
// are registered directly through the `tools` registry, no child process and no
// JSON-RPC layer are involved.
//
// Target instance: http://192.168.2.204 (GitLab with granular-scope PATs).
//
// ┌── WHY SOME TOOLS ARE MISSING ────────────────────────────────────────────┐
// │ The token this plugin ships for carries only a SUBSET of granular scopes. │
// │ Everything registered here was verified against the live instance.       │
// │ Merge requests, pipelines, tags, releases, wikis, users/groups/members,  │
// │ global search, branch/commit/file WRITES and label writes all answer     │
// │ 403 insufficient_granular_scope with this token, so no tool is          │
// │ registered for them: a tool that always fails is worse than no tool.     │
// │ See README.md for the measured matrix and the scopes to add.             │
// └──────────────────────────────────────────────────────────────────────────┘
//
// REST endpoints used (base url has no trailing slash):
//   GET  /projects/:id                                     project metadata
//   GET  /projects/:id/repository/branches                 branch list
//   GET  /projects/:id/repository/commits                  commit list
//   GET  /projects/:id/repository/commits/:sha             commit + diff
//   GET  /projects/:id/repository/tree                     file tree
//   GET  /projects/:id/repository/files/:path[/raw]        file content
//   GET  /projects/:id/issues                              issue list
//   GET  /projects/:id/issues/:iid                         issue detail
//   GET  /projects/:id/issues/:iid/notes                   notes (comments)
//   GET  /projects/:id/labels                              label list
//   GET  /projects/:id/milestones                          milestone list
//   GET  /projects/:id/search?scope=...                    project-scoped search
//   POST /projects/:id/issues                              create issue
//   PUT  /projects/:id/issues/:iid                         update issue
//   POST /projects/:id/issues/:iid/notes                   add note
//   POST /projects/:id/issues/:iid/links                   link two issues
//   POST /projects/:id/uploads                             upload an attachment
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-gitlab";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;

/** Default credential reference resolved through `ctx.credentials` / env. */
const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";

/**
 * API root used when config omits `apiUrl` (the workspace's private GitLab).
 *
 * It MUST include the `/api/v4` prefix: the instance serves the web UI from the
 * bare origin, so `http://host/projects/1` answers 404 HTML. Verified.
 */
const DEFAULT_API_URL = "http://192.168.2.204/api/v4";

/** Hard cap on tool output (characters). */
const DEFAULT_MAX_OUTPUT_CHARS = 200000;

/** Search scopes this token was verified to reach on a project. */
const SEARCH_SCOPES = ["blobs", "issues", "commits", "notes", "milestones", "wiki_blobs"];

/**
 * Minimum usable search-term length, MEASURED against the live instance.
 *
 * This instance runs GitLab's basic (Postgres) search, not Elasticsearch, and
 * it silently DROPS terms below the minimum instead of erroring — a query of
 * `酒店` returns HTTP 200 with an empty list, which reads as "no such issue"
 * when the opposite is true (`酒店预` returns 20). Measured on cx/trip:
 *
 *   "酒"     -> 0    "酒店"   -> 0    "酒店预" -> 20   "酒店预订" -> 20
 *   "h"      -> 0    "ho"     -> 20   "hot"   -> 20   "hotel"    -> 20
 *
 * So a CJK term needs at least 3 characters and an ASCII term at least 2. Both
 * bounds are flagged BEFORE the request, and a zero-result answer repeats the
 * caveat — the failure mode is invisible otherwise.
 */
const MIN_SEARCH_CHARS_CJK = 3;
const MIN_SEARCH_CHARS_LATIN = 2;

/** CJK ranges: Han, kana, and hangul — the scripts GitLab's basic search splits per character. */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

function countChars(text) {
  return [...String(text ?? "")].length;
}

/**
 * Explain why a search term is likely to match nothing, or "" when it is fine.
 *
 * Two independent traps are encoded, both measured on the live instance:
 *   1. a too-short term is dropped entirely (returns 0, not an error);
 *   2. a Latin word glued to CJK is not tokenized on its own, so looking up
 *      `webpack` misses the issue titled `manager-frontend项目webpack升级`
 *      while `webpack升` and `项目webpack` both hit it.
 */
function describeSearchTermRisk(term) {
  const text = String(term ?? "").trim();
  if (!text) return "";
  const cjkCount = (text.match(CJK_PATTERN) ?? []).length;
  const length = countChars(text);
  const notes = [];
  if (cjkCount > 0 && length < MIN_SEARCH_CHARS_CJK) {
    notes.push(
      `"${text}" is ${length} character(s). This instance silently drops search terms shorter than ${MIN_SEARCH_CHARS_CJK} CJK characters, so it returns ZERO results even when matches exist — add characters (e.g. "酒店" -> "酒店预").`
    );
  } else if (cjkCount === 0 && length < MIN_SEARCH_CHARS_LATIN) {
    notes.push(`"${text}" is shorter than the ${MIN_SEARCH_CHARS_LATIN}-character minimum for this search backend and will match nothing.`);
  }
  if (cjkCount === 0 && /^[A-Za-z0-9_.-]+$/.test(text)) {
    notes.push(
      `A pure-ASCII term does not match when it sits glued to CJK text in the title (e.g. searching "webpack" misses "manager-frontend项目webpack升级"). If you expect a hit and get none, retry with the adjacent CJK character included ("webpack升" or "项目webpack").`
    );
  }
  return notes.join(" ");
}

/** The caveat appended to an empty result set, so a tokenization miss is never read as "absent". */
function emptyResultHint(term) {
  const text = String(term ?? "").trim();
  return (
    `\n\nNOTE: an empty result set from this instance often means the TERM was unusable, not that nothing matches. ` +
    `Search rules measured here: CJK terms need >= ${MIN_SEARCH_CHARS_CJK} characters (2-char terms are silently dropped); ` +
    `an ASCII word glued to CJK in the title is not tokenized alone (search "webpack升", not "webpack"). ` +
    `Retry "${text}" with a longer or more distinctive fragment before reporting that nothing exists.`
  );
}

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default(DEFAULT_API_URL),
  // A literal token wins over the reference; leave it empty to keep the secret
  // out of configuration and let `tokenEnv` resolve it through the credential
  // store instead.
  apiToken: z.string().default(""),
  tokenEnv: z.string().default(DEFAULT_TOKEN_ENV),
  getProject: z.boolean().default(true),
  listBranches: z.boolean().default(true),
  listCommits: z.boolean().default(true),
  getCommit: z.boolean().default(true),
  listTree: z.boolean().default(true),
  getFile: z.boolean().default(true),
  listIssues: z.boolean().default(true),
  getIssue: z.boolean().default(true),
  listIssueNotes: z.boolean().default(true),
  listLabels: z.boolean().default(true),
  listMilestones: z.boolean().default(true),
  searchProject: z.boolean().default(true),
  createIssue: z.boolean().default(true),
  updateIssue: z.boolean().default(true),
  addIssueNote: z.boolean().default(true),
  linkIssues: z.boolean().default(true),
  uploadFile: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(DEFAULT_MAX_OUTPUT_CHARS)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-gitlab: ${label} must be a positive integer`);
}

// ---------------------------------------------------------------------------
// Auth: literal config token, else the credential store, else the environment
// ---------------------------------------------------------------------------

/**
 * Resolve the PAT for one request.
 *
 * `ctx.credentials` is the harness credential seam (a host-plane service, so a
 * preset row reaches it with `ctx.get`). It is optional on purpose: a
 * composition without the store must still work off a config literal or the
 * process environment, so this is a soft dependency, not an `inject` entry.
 *
 * Deliberately NOT memoised: the store is an in-memory map, so a per-call read
 * costs nothing, and it is what makes a rotated token reach the very next call
 * without a restart.
 */
async function resolveToken(ctx, config) {
  if (config.apiToken) return config.apiToken;
  const ref = String(config.tokenEnv || DEFAULT_TOKEN_ENV);
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(ref);
      if (hit && hit.value) return hit.value;
    } catch {
      /* a malformed reference must not fail the plugin; fall through */
    }
  }
  const fromEnv = process.env[ref];
  if (fromEnv) return fromEnv;
  throw new Error(
    `tool-gitlab: no GitLab token available. Set \`apiToken\` in the plugin config, or store a credential named ${ref} (harness credential store, or the ${ref} environment variable).`
  );
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  const root = String(config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  // Tolerate `apiUrl: http://host` (a plausible config mistake): every request
  // path below is written relative to the API root, so append it once here
  // rather than 404-ing against the web UI on the bare origin.
  return /\/api\/v\d+$/.test(root) ? root : `${root}/api/v4`;
}

/**
 * Encode a project reference for the REST path.
 *
 * GitLab accepts either the numeric id or the URL-encoded `namespace/project`
 * path, and refuses a bare `ns/project` (the slash would be read as a new path
 * segment), so a non-numeric reference is encoded wholesale.
 */
function encodeProject(project) {
  const raw = String(project ?? "").trim();
  if (!raw) throw new Error("tool-gitlab: a project is required (numeric id or 'group/project' path)");
  if (/^\d+$/.test(raw)) return raw;
  return encodeURIComponent(raw);
}

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
}

/** Map a GitLab API failure to an actionable message; 403 is always a scope gap. */
function describeFailure(res, body, path) {
  let detail = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error_description ?? parsed?.message ?? parsed?.error;
    if (message) detail = `HTTP ${res.status}: ${message}`;
    if (parsed?.error === "insufficient_granular_scope") {
      const needed = /\[([^\]]+)\]/.exec(String(parsed.error_description ?? ""))?.[1];
      detail =
        `HTTP 403 insufficient_granular_scope${needed ? ` — this token needs "${needed}"` : ""}. ` +
        `The fine-grained PAT configured for this plugin does not cover ${path}. ` +
        `Add the scope at the instance's personal access token settings, or use a capability the token does cover.`;
    }
  } catch {
    /* non-JSON error body: keep the status fallback */
  }
  if (res.status === 404) detail = "HTTP 404 — no such project/issue/ref/path (check the numeric id or 'group/project' path and the ref name)";
  return detail;
}

async function request(ctx, config, method, path, options = {}) {
  const { signal, json, form, accept } = options;
  const token = await resolveToken(ctx, config);
  const headers = { authorization: `Bearer ${token}` };
  /** @type {BodyInit | undefined} */
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form;
  }
  if (accept) headers.accept = accept;
  const res = await fetch(baseUrl(config) + path, { method, headers, body, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`gitlab ${method} ${path} failed (${describeFailure(res, text, path)})`);
  return { res, text };
}

async function getJson(ctx, config, path, signal) {
  const { res, text } = await request(ctx, config, "GET", path, { signal, accept: "application/json" });
  if (!text.trim()) return { data: null, res };
  try {
    return { data: JSON.parse(text), res };
  } catch {
    throw new Error(`gitlab GET ${path} returned a non-JSON body (first 200 chars: ${text.slice(0, 200)})`);
  }
}

/** Read one page plus its `x-total`/`x-next-page` headers for the model. */
async function getPage(ctx, config, path, signal) {
  const { data, res } = await getJson(ctx, config, path, signal);
  return {
    data,
    total: res.headers.get("x-total"),
    nextPage: res.headers.get("x-next-page")
  };
}

function pageQuery(args, defaultPerPage = 20) {
  const perPage = Math.min(Math.max(1, Number(args.perPage) || defaultPerPage), 100);
  const page = Math.max(1, Number(args.page) || 1);
  return { perPage, page };
}

// ---------------------------------------------------------------------------
// Formatters (model-facing text)
// ---------------------------------------------------------------------------

function fmtUser(user) {
  if (!user) return "?";
  const label = user.name && user.name !== user.username ? `${user.name} (@${user.username})` : `@${user.username}`;
  return user.id != null ? `${label} id=${user.id}` : label;
}

function fmtUsers(list) {
  if (!Array.isArray(list) || list.length === 0) return "none";
  return list.map(fmtUser).join(", ");
}

function fmtDate(iso) {
  if (!iso) return "?";
  return String(iso).replace("T", " ").slice(0, 19);
}

function fmtProject(p) {
  const lines = [
    `${p.path_with_namespace} (id=${p.id}) — ${p.visibility ?? "?"}${p.archived ? " [archived]" : ""}`,
    `name: ${p.name}${p.description ? ` — ${p.description.split("\n")[0]}` : ""}`,
    `default branch: ${p.default_branch ?? "?"}`,
    `web: ${p.web_url ?? "?"}`,
    `issues: ${p.issues_enabled === false ? "disabled" : "enabled"}${p.open_issues_count != null ? ` (open: ${p.open_issues_count})` : ""}, merge requests: ${p.merge_requests_enabled === false ? "disabled" : "enabled"}, wiki: ${p.wiki_enabled === false ? "disabled" : "enabled"}`,
    `created: ${fmtDate(p.created_at)} | last activity: ${fmtDate(p.last_activity_at)}`
  ];
  return lines.join("\n");
}

function fmtBranch(b, showCommit = true) {
  const flags = [b.default ? "default" : "", b.protected ? "protected" : "", b.merged ? "merged" : ""].filter(Boolean).join(", ");
  const head = `${b.name}${flags ? ` [${flags}]` : ""}`;
  if (!showCommit || !b.commit) return head;
  return `${head}\n   ${b.commit.short_id ?? String(b.commit.id).slice(0, 8)} ${fmtDate(b.commit.committed_date ?? b.commit.created_at)} ${b.commit.author_name ?? ""} — ${String(b.commit.title ?? "").split("\n")[0]}`;
}

function fmtCommit(c, showBody = false) {
  const line = `${c.short_id ?? String(c.id).slice(0, 8)} ${fmtDate(c.committed_date ?? c.created_at)} ${c.author_name ?? "?"} — ${String(c.title ?? c.message ?? "").split("\n")[0]}`;
  if (showBody) {
    const body = String(c.message ?? "").split("\n").slice(1).join("\n").trim();
    return body ? `${line}\n   ${body.replace(/\n/g, "\n   ")}` : line;
  }
  return line;
}

function fmtIssue(i) {
  const labels = Array.isArray(i.labels) && i.labels.length ? i.labels.join(", ") : "none";
  const state = i.state ?? "?";
  const lines = [
    `#${i.iid} [${state}] ${i.title}`,
    `   author: ${fmtUser(i.author)} | assignees: ${fmtUsers(i.assignees ?? (i.assignee ? [i.assignee] : []))}`,
    `   labels: ${labels} | milestone: ${i.milestone?.title ?? "none"}`,
    `   updated: ${fmtDate(i.updated_at)}${i.user_notes_count != null ? ` | comments: ${i.user_notes_count}` : ""}`,
    `   ${i.web_url ?? ""}`
  ];
  return lines.join("\n");
}

function fmtIssueDetail(i, notes) {
  const parts = [fmtIssue(i)];
  if (i.description) parts.push(`\ndescription:\n${i.description}`);
  else parts.push("\ndescription: (empty)");
  if (Array.isArray(notes) && notes.length) {
    parts.push(`\ncomments (${notes.length} shown):`);
    for (const n of notes) {
      const system = n.system ? " [system]" : "";
      parts.push(`- ${n.id} ${fmtDate(n.created_at)} ${fmtUser(n.author)}${system}\n   ${String(n.body ?? "").replace(/\n/g, "\n   ")}`);
    }
  }
  return parts.join("\n");
}

function fmtNote(n) {
  return `${n.id} ${fmtDate(n.created_at)} ${fmtUser(n.author)}${n.system ? " [system]" : ""}\n   ${String(n.body ?? "").replace(/\n/g, "\n   ")}`;
}

function fmtLabel(l) {
  return `${l.name}${l.description ? ` — ${l.description}` : ""} (color ${l.color ?? "?"}${l.priority != null ? `, priority ${l.priority}` : ""})`;
}

function fmtMilestone(m) {
  return `#${m.iid} ${m.title} — ${m.state}${m.due_date ? `, due ${m.due_date}` : ""}${m.description ? `\n   ${String(m.description).split("\n")[0]}` : ""}`;
}

/** Render one page of list output plus a paging hint. */
function fmtList(header, items, page, total) {
  if (!items.length) return `${header}\n\n(no results)`;
  const lines = items.join("\n");
  const paging = total != null ? `\n(${items.length} of ${total}${page.nextPage ? `; more available — call again with page=${page.nextPage}` : ""})` : `\n(${items.length} shown${page.nextPage ? `; more available — call again with page=${page.nextPage}` : ""})`;
  return `${header}\n\n${lines}\n${paging}`;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

/** Shared `project` parameter description. */
const PROJECT_PARAM = {
  type: "string",
  required: true,
  description: "Project reference: numeric id (e.g. '1') or full path (e.g. 'cx/trip'). Listing projects is not permitted for this token, so pass the path you already know."
};

function applyGetProjectTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_get_project",
    order: 120,
    text: "Use gitlab_get_project to confirm a project's numeric id, default branch, and feature flags before other gitlab_* calls. The token cannot list projects or groups, so pass a 'group/project' path (e.g. 'cx/trip') you already know."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_get_project",
    description: "Returns one GitLab project's metadata: numeric id, full path, default branch, visibility, web URL, feature flags (issues / merge requests / wiki), and open issue count. Use this to turn a 'group/project' path into a numeric id, or to read the default branch. Listing projects, groups, users, and members is NOT available with this token.",
    parameters: { project: PROJECT_PARAM },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { data } = await getJson(ctx, config, `/projects/${encodeProject(args.project)}`, exec.signal);
      return truncate(fmtProject(data), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.project, kind: "gitlab-project", rawInput: args.project })
  }));
}

function applyListBranchesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_branches",
    order: 121,
    text: "Use gitlab_list_branches to discover branch names (and the default branch) in a project. Creating, deleting, or protecting branches is NOT permitted for this token."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_branches",
    description: "Lists a GitLab project's repository branches with their head commit (short id, date, author, title), default/protected/merged flags. Supports `search` to filter by name. Read-only: this token cannot create, delete, or protect branches.",
    parameters: {
      project: PROJECT_PARAM,
      search: { type: "string", description: "Return only branches whose name contains this string." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 20, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args);
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (args.search) params.set("search", args.search);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/repository/branches?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((b) => fmtBranch(b));
      return truncate(fmtList(`Branches of ${args.project}${args.search ? ` matching '${args.search}'` : ""}:`, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.project, kind: "gitlab-branches", rawInput: args.project })
  }));
}

function applyListCommitsTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_commits",
    order: 122,
    text: "Use gitlab_list_commits to inspect commit history, optionally narrowed by ref (branch/tag/sha), file path, author, or date range. Follow with gitlab_get_commit when you need the diff. This token cannot create commits or write repository files."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_commits",
    description: "Lists commits in a GitLab project's repository, newest first, filtered by ref/branch, path, author, or date range. Returns short id, committed date, author, and the first line of the message. Use `path` to see the history of a single file, and `ref` to pick the branch (empty means the default branch).",
    parameters: {
      project: PROJECT_PARAM,
      ref: { type: "string", description: "Branch, tag, or commit SHA to list from (default: the project's default branch)." },
      path: { type: "string", description: "Only commits touching this repository path (file or directory)." },
      since: { type: "string", description: "ISO 8601 lower bound on committed date, e.g. '2026-10-01T00:00:00Z'." },
      until: { type: "string", description: "ISO 8601 upper bound on committed date." },
      author: { type: "string", description: "Only commits by this author name or e-mail." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 20, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args);
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (args.ref) params.set("ref_name", args.ref);
      if (args.path) params.set("path", args.path);
      if (args.since) params.set("since", args.since);
      if (args.until) params.set("until", args.until);
      if (args.author) params.set("author", args.author);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/repository/commits?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((c) => fmtCommit(c));
      const scope = [args.ref ? `ref ${args.ref}` : "default branch", args.path ? `path ${args.path}` : ""].filter(Boolean).join(", ");
      return truncate(fmtList(`Commits in ${args.project} (${scope}):`, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.project, kind: "gitlab-commits", rawInput: args.ref || "" })
  }));
}

function applyGetCommitTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_get_commit",
    order: 123,
    text: "Use gitlab_get_commit to read one commit's full message and its diff (pass `diff: true`). Use the short id from gitlab_list_commits, or a full SHA."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_get_commit",
    description: "Returns one commit's full metadata (message body, author, committer, parents, stats) and — with `diff: true` — the file-level diff. Diffs can be large; pass `filePath` to narrow one file, or `maxDiffChars` to bound the output.",
    parameters: {
      project: PROJECT_PARAM,
      sha: { type: "string", required: true, description: "Commit SHA or short id (e.g. 'd55ff6d')." },
      diff: { type: "boolean", description: "Also return the diff (default false)." },
      filePath: { type: "string", description: "When diffing, only include the hunks for this repository path." },
      maxDiffChars: { type: "number", description: "Cap on the diff text returned (default 40000)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const encoded = encodeURIComponent(args.sha);
      const projectPath = `/projects/${encodeProject(args.project)}/repository/commits/${encoded}`;
      const { data } = await getJson(ctx, config, projectPath, exec.signal);
      const parts = [
        `Commit ${data.short_id ?? String(data.id).slice(0, 8)} in ${args.project}`,
        `author: ${data.author_name ?? "?"} <${data.author_email ?? "?"}> ${fmtDate(data.authored_date ?? data.created_at)}`,
        `committer: ${data.committer_name ?? "?"} ${fmtDate(data.committed_date ?? data.created_at)}`,
        `parents: ${(data.parent_ids ?? []).map((p) => String(p).slice(0, 8)).join(", ") || "none (root commit)"}`,
        `web: ${data.web_url ?? "?"}`,
        `\nmessage:\n${data.message ?? ""}`
      ];
      if (args.diff) {
        const maxDiff = Math.max(1000, Number(args.maxDiffChars) || 40000);
        const { data: diffs } = await getJson(ctx, config, `${projectPath}/diff`, exec.signal);
        const list = (Array.isArray(diffs) ? diffs : []).filter((d) => !args.filePath || d.new_path === args.filePath || d.old_path === args.filePath);
        if (!list.length) parts.push(`\ndiff: (none${args.filePath ? ` for ${args.filePath}` : ""})`);
        else {
          let budget = maxDiff;
          const chunks = [];
          for (const d of list) {
            const head = `\n--- ${d.old_path ?? "?"} -> ${d.new_path ?? "?"}${d.new_file ? " [new]" : ""}${d.deleted_file ? " [deleted]" : ""}${d.renamed_file ? " [renamed]" : ""}`;
            const body = String(d.diff ?? "");
            const slice = body.length > budget ? body.slice(0, budget) : body;
            chunks.push(`${head}\n${slice}`);
            budget -= slice.length;
            if (budget <= 0) {
              chunks.push("\n(diff truncated — pass filePath to inspect one file)");
              break;
            }
          }
          parts.push(`\ndiff (${list.length} file${list.length === 1 ? "" : "s"}):${chunks.join("\n")}`);
        }
      }
      return truncate(parts.join("\n"), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project}@${args.sha}`, kind: "gitlab-commit", rawInput: args.sha })
  }));
}

function applyListTreeTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_tree",
    order: 124,
    text: "Use gitlab_list_tree to browse a repository at a ref: pass `path` to descend into a directory and `recursive: true` to list everything below it. Read the model-facing output for the exact file paths to pass to gitlab_get_repository_file."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_tree",
    description: "Lists files and directories in a GitLab repository at a ref (branch/tag/SHA) and path. Returns each entry's type (blob/tree), path, and mode. Use `recursive: true` to list a whole subtree in one call (bounded by `perPage`).",
    parameters: {
      project: PROJECT_PARAM,
      path: { type: "string", description: "Directory path inside the repository; omit for the root." },
      ref: { type: "string", description: "Branch, tag, or commit SHA (default: the project's default branch)." },
      recursive: { type: "boolean", description: "List the whole subtree below `path` (default false)." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 100, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args, 100);
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (args.path) params.set("path", args.path);
      if (args.ref) params.set("ref", args.ref);
      if (args.recursive) params.set("recursive", "true");
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/repository/tree?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((e) => `${e.type === "tree" ? "dir " : "file"} ${e.path}`);
      const header = `Tree of ${args.project}${args.ref ? `@${args.ref}` : ""}${args.path ? ` /${args.path}` : ""}${args.recursive ? " (recursive)" : ""}:`;
      return truncate(fmtList(header, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project}/${args.path ?? ""}`, kind: "gitlab-tree", rawInput: args.path || "" })
  }));
}

function applyGetFileTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_get_repository_file",
    order: 125,
    text: "Use gitlab_get_repository_file to read one file's content at a ref. Binary files (images, archives) must not be fetched: this tool refuses them and reports the size instead. Writing files is NOT permitted for this token — changes go through a local checkout and a normal git push."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_get_repository_file",
    description: "Reads one file from a GitLab repository at a ref and returns its text. Refuses binary files (images/archives/binaries) and files above `maxBytes`, reporting their size instead. Read-only: this token has no permission to write repository files.",
    parameters: {
      project: PROJECT_PARAM,
      filePath: { type: "string", required: true, description: "Repository path of the file, e.g. 'docs/hotel/expedia-region-hotel-cityId'." },
      ref: { type: "string", description: "Branch, tag, or commit SHA (default: the project's default branch)." },
      maxBytes: { type: "number", description: "Refuse files larger than this (default 262144)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const maxBytes = Math.max(1024, Number(args.maxBytes) || 262144);
      const projectPath = `/projects/${encodeProject(args.project)}`;
      // The files endpoint REQUIRES `ref` (it answers 400 "ref is missing"
      // otherwise), so fall back to the project's own default branch — verified.
      let ref = args.ref;
      let refNote = "";
      if (!ref) {
        const { data: project } = await getJson(ctx, config, projectPath, exec.signal);
        ref = project?.default_branch;
        if (!ref) throw new Error(`tool-gitlab: ${args.project} has no default branch; pass \`ref\` explicitly`);
        refNote = ` (default branch)`;
      }
      const encodedRef = encodeURIComponent(ref);
      const filePath = `${projectPath}/repository/files/${encodeURIComponent(args.filePath)}`;
      const { data } = await getJson(ctx, config, `${filePath}?ref=${encodedRef}`, exec.signal);
      if (data.size != null && data.size > maxBytes) {
        return `File ${data.file_path} is ${data.size} bytes at ${ref}, above the ${maxBytes}-byte limit; not fetched. Raise \`maxBytes\` to read it.`;
      }
      const buf = Buffer.from(data.content ?? "", data.encoding === "base64" ? "base64" : "utf8");
      if (buf.subarray(0, 8000).includes(0)) {
        return `File ${data.file_path} looks binary (${data.size} bytes at ${ref}); not rendered. Fetch it from ${baseUrl(config)}${filePath}/raw?ref=${encodedRef} instead.`;
      }
      const text = buf.toString("utf8");
      return truncate(`File ${data.file_path} (${data.size} bytes) at ${ref}${refNote}:\n\n${text}`, config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.filePath, kind: "gitlab-file", rawInput: args.filePath })
  }));
}

function applyListIssuesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_issues",
    order: 126,
    text: `Use gitlab_list_issues to find issues by state, labels, milestone, assignee, or free-text search. Issues are the work-item surface this token can read and write: merge requests and pipelines are NOT available. Prefer \`labels\` and \`search\` filters over paging through everything.

The \`search\` filter follows the same instance rules as gitlab_search_project: a CJK term needs >= ${MIN_SEARCH_CHARS_CJK} characters (shorter terms are silently dropped and return an empty list) and an ASCII word glued to CJK is not tokenized alone. A zero-result search usually means the TERM was unusable, not that the issue does not exist.`
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_issues",
    description: `Lists a project's issues with state/label/milestone/assignee/search filters, ordered by creation or update time. Returns iid, title, state, author, assignees, labels, milestone, last update, comment count, and web URL. Merge requests are not included: they are a separate resource this token cannot read.

The free-text \`search\` filter needs >= ${MIN_SEARCH_CHARS_CJK} characters for CJK terms (1-2 character Chinese terms are silently dropped and return an empty list) and >= ${MIN_SEARCH_CHARS_LATIN} for ASCII; an ASCII word adjacent to CJK is not matched on its own.`,
    parameters: {
      project: PROJECT_PARAM,
      state: { type: "string", enum: ["opened", "closed", "all"], description: "Issue state (default 'opened')." },
      labels: { type: "string", description: "Comma-separated label names; an issue must carry ALL of them." },
      milestone: { type: "string", description: "Milestone title, or 'none' for issues without one." },
      assignee: { type: "string", description: "Assignee username, or 'none' for unassigned issues." },
      author: { type: "string", description: "Author username." },
      search: { type: "string", description: `Free-text search over title and description. MUST be >= ${MIN_SEARCH_CHARS_CJK} characters for CJK (2-character Chinese terms are silently dropped and return nothing) and >= ${MIN_SEARCH_CHARS_LATIN} for ASCII.` },
      orderBy: { type: "string", enum: ["created_at", "updated_at"], description: "Sort field (default 'updated_at')." },
      sort: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default 'desc')." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 20, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args);
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        order_by: args.orderBy || "updated_at",
        sort: args.sort || "desc"
      });
      if (args.state) params.set("state", args.state);
      if (args.labels) params.set("labels", args.labels);
      if (args.milestone) params.set("milestone", args.milestone);
      if (args.assignee) params.set("assignee_username", args.assignee);
      if (args.author) params.set("author_username", args.author);
      if (args.search) params.set("search", args.search);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/issues?${params}`, exec.signal);
      const issues = Array.isArray(data) ? data : [];
      const lines = issues.map((i) => fmtIssue(i));
      const filters = [
        `state ${args.state ?? "opened"}`,
        args.labels ? `labels ${args.labels}` : "",
        args.milestone ? `milestone ${args.milestone}` : "",
        args.search ? `search '${args.search}'` : ""
      ].filter(Boolean).join(", ");
      const header = `Issues in ${args.project} (${filters}):`;
      // Only a search-filtered empty list is ambiguous; an unfiltered empty list
      // genuinely means the project has no issues in that state.
      const body =
        issues.length === 0 && args.search
          ? `${header}\n\n(no results)${emptyResultHint(args.search)}`
          : fmtList(header, lines, { nextPage }, total);
      const risk = args.search ? describeSearchTermRisk(args.search) : "";
      return truncate(body + (risk ? `\n\nWARNING — ${risk}` : ""), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.project, kind: "gitlab-issues", rawInput: args.labels || args.search || "" })
  }));
}

function applyGetIssueTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_get_issue",
    order: 127,
    text: "Use gitlab_get_issue to read one issue's full description and, with `includeNotes: true`, its comments. Read the description before editing it: gitlab_update_issue replaces the whole description when one is supplied."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_get_issue",
    description: "Returns one issue's full record: title, state, description (markdown as stored), author, assignees, labels, milestone, dates, web URL, and — with `includeNotes: true` — its comments (system notes included, oldest first).",
    parameters: {
      project: PROJECT_PARAM,
      iid: { type: "number", required: true, description: "Issue iid (the number in '#123', not the global id)." },
      includeNotes: { type: "boolean", description: "Also return the issue's comments (default false)." },
      notesLimit: { type: "number", description: "How many comments to include when `includeNotes` is set (default 30, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const projectPath = `/projects/${encodeProject(args.project)}/issues/${Number(args.iid)}`;
      const { data } = await getJson(ctx, config, projectPath, exec.signal);
      let notes;
      if (args.includeNotes) {
        const limit = Math.min(Math.max(1, Number(args.notesLimit) || 30), 100);
        const { data: notesData } = await getJson(ctx, config, `${projectPath}/notes?per_page=${limit}&sort=asc&order_by=created_at`, exec.signal);
        notes = Array.isArray(notesData) ? notesData : [];
      }
      return truncate(fmtIssueDetail(data, notes), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project}#${args.iid}`, kind: "gitlab-issue", rawInput: String(args.iid) })
  }));
}

function applyListIssueNotesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_issue_notes",
    order: 128,
    text: "Use gitlab_list_issue_notes to page through an issue's comment thread newest-first, e.g. to find the latest status update. System notes record label/assignee changes made by GitLab itself."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_issue_notes",
    description: "Lists an issue's comments (notes) with author, timestamp, and body; `system` notes are GitLab's own change records. Newest first by default.",
    parameters: {
      project: PROJECT_PARAM,
      iid: { type: "number", required: true, description: "Issue iid." },
      sort: { type: "string", enum: ["asc", "desc"], description: "Chronological order (default 'desc' — newest first)." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 30, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args, 30);
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        sort: args.sort || "desc",
        order_by: "created_at"
      });
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/issues/${Number(args.iid)}/notes?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((n) => fmtNote(n));
      return truncate(fmtList(`Comments on ${args.project}#${args.iid}:`, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project}#${args.iid}`, kind: "gitlab-notes", rawInput: String(args.iid) })
  }));
}

function applyListLabelsTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_labels",
    order: 129,
    text: "Use gitlab_list_labels to discover the exact label names a project uses before setting `labels` on an issue — a misspelled label creates noise. Creating, renaming, and deleting labels is NOT permitted for this token, so only use names this tool returns."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_labels",
    description: "Lists a project's labels with their colors and descriptions, optionally filtered by a search term. Use it to look up exact label names before writing them to an issue. Label writes (create/update/delete) are not permitted for this token.",
    parameters: {
      project: PROJECT_PARAM,
      search: { type: "string", description: "Only labels whose name contains this string." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 100, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args, 100);
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (args.search) params.set("search", args.search);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/labels?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((l) => fmtLabel(l));
      return truncate(fmtList(`Labels in ${args.project}${args.search ? ` matching '${args.search}'` : ""}:`, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project} labels`, kind: "gitlab-labels", rawInput: args.search || "" })
  }));
}

function applyListMilestonesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_list_milestones",
    order: 130,
    text: "Use gitlab_list_milestones to discover milestone titles and iids before assigning one to an issue (gitlab_update_issue takes `milestoneId` = the milestone's `iid`)."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_list_milestones",
    description: "Lists a project's milestones with their iid, title, state, due date, and description headline. Pass the returned `iid` as `milestoneId` to gitlab_update_issue.",
    parameters: {
      project: PROJECT_PARAM,
      state: { type: "string", enum: ["active", "closed", "all"], description: "Milestone state (default 'active')." },
      search: { type: "string", description: "Only milestones whose title contains this string." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 30, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args, 30);
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (args.state) params.set("state", args.state);
      if (args.search) params.set("search", args.search);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/milestones?${params}`, exec.signal);
      const lines = (Array.isArray(data) ? data : []).map((m) => fmtMilestone(m));
      return truncate(fmtList(`Milestones in ${args.project}${args.state ? ` (${args.state})` : ""}:`, lines, { nextPage }, total), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.project} milestones`, kind: "gitlab-milestones", rawInput: args.search || "" })
  }));
}

function applySearchProjectTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_search_project",
    order: 131,
    text: `Use gitlab_search_project for keyword search INSIDE one project: scope 'blobs' searches file content, 'issues' and 'notes' search issue text and comments, 'commits' searches commit messages, 'milestones' searches milestones. It works on EVERY project this token can see, not only a particular one — pass the 'group/project' path you need.

SEARCH-TERM RULES (measured on this instance, which runs basic search, not Elasticsearch) — ignore them and you will wrongly report "nothing found":
  * A CJK term needs at least ${MIN_SEARCH_CHARS_CJK} characters. Shorter terms are SILENTLY DROPPED and return HTTP 200 with zero results: "${"酒店"}" finds nothing while "${"酒店预"}" finds 20. Never search a 2-character Chinese word and conclude the issue does not exist.
  * ASCII terms need at least ${MIN_SEARCH_CHARS_LATIN} characters.
  * An ASCII word glued to CJK text is not tokenized on its own: "webpack" misses the issue titled "manager-frontend项目webpack升级", while "webpack升" and "项目webpack" both find it.
  * An empty result therefore means "try a different term" far more often than "absent". Re-run with a longer, more distinctive fragment before saying something does not exist.

Instance-wide global search (across projects, groups, users) is NOT permitted for this token via REST — always scope to a known project.`
  });
  ctx.tools.register(defineTool({
    name: "gitlab_search_project",
    description: `Keyword search scoped to ONE project (works on every project this token can see). Scopes: 'blobs' (file contents), 'issues' (issue title/description), 'notes' (issue comments), 'commits' (commit messages), 'milestones', 'wiki_blobs'. Results are limited to the first 6 matching lines of each blob.

CRITICAL SEARCH-TERM RULES for this instance (basic search, not Elasticsearch). Violating them makes you report "not found" for things that DO exist:
- CJK terms need >= ${MIN_SEARCH_CHARS_CJK} characters. 1-2 character Chinese terms are SILENTLY DROPPED and return zero results with HTTP 200: "酒店" -> 0 results, "酒店预" -> 20 results.
- ASCII terms need >= ${MIN_SEARCH_CHARS_LATIN} characters ("ho" works, "h" does not).
- An ASCII word adjacent to CJK is not tokenized alone: "webpack" misses "manager-frontend项目webpack升级"; use "webpack升" or "项目webpack".
- A zero-result answer is usually a bad TERM, not a missing issue. Retry with a longer fragment before concluding absence. The tool appends this reminder automatically when it returns nothing.

Global search across projects/groups/users is not available with this token.`,
    parameters: {
      project: PROJECT_PARAM,
      scope: { type: "string", required: true, enum: SEARCH_SCOPES, description: "What to search: blobs, issues, notes, commits, milestones, or wiki_blobs." },
      search: { type: "string", required: true, description: `Keyword or phrase. MUST be at least ${MIN_SEARCH_CHARS_CJK} characters for CJK terms (2-character Chinese terms are silently dropped and return zero results) and at least ${MIN_SEARCH_CHARS_LATIN} for ASCII. Include an adjacent CJK character when searching an ASCII word that appears glued to Chinese text.` },
      ref: { type: "string", description: "For scope 'blobs': search only this branch/tag/SHA." },
      page: { type: "number", description: "Page number (default 1)." },
      perPage: { type: "number", description: "Items per page (default 20, max 100)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { perPage, page } = pageQuery(args);
      const params = new URLSearchParams({ scope: args.scope, search: args.search, per_page: String(perPage), page: String(page) });
      if (args.ref && args.scope === "blobs") params.set("ref", args.ref);
      const { data, total, nextPage } = await getPage(ctx, config, `/projects/${encodeProject(args.project)}/search?${params}`, exec.signal);
      const results = Array.isArray(data) ? data : [];
      let lines;
      if (args.scope === "blobs" || args.scope === "wiki_blobs") {
        lines = results.map((r) => `${r.path ?? r.basename ?? "?"}\n   ${String(r.data ?? "").split("\n").slice(0, 6).join("\n   ")}`);
      } else if (args.scope === "commits") {
        lines = results.map((c) => fmtCommit(c, true));
      } else if (args.scope === "issues" || args.scope === "notes") {
        lines = results.map((i) => (i.iid != null ? fmtIssue(i) : `note ${i.id} ${fmtDate(i.created_at)} ${fmtUser(i.author)}\n   ${String(i.body ?? "").slice(0, 300)}`));
      } else {
        lines = results.map((m) => fmtMilestone(m));
      }
      const header = `Project search in ${args.project} (scope ${args.scope}, '${args.search}'):`;
      // Warn about an unusable term even when it happens to match something, so
      // the model does not generalise a lucky hit into "this term is fine".
      const risk = describeSearchTermRisk(args.search);
      const riskNote = risk ? `\n\nWARNING — ${risk}` : "";
      const body = results.length
        ? `${header}\n\n${lines.join("\n")}\n${total != null ? `\n(${results.length} of ${total})` : `\n(${results.length} shown${nextPage ? `; more available — call again with page=${nextPage}` : ""})`}`
        : `${header}\n\n(no results)${emptyResultHint(args.search)}`;
      return truncate(body + riskNote, config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.scope}: ${args.search}`, kind: "gitlab-search", rawInput: args.search })
  }));
}

function applyCreateIssueTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_create_issue",
    order: 132,
    text: "Use gitlab_create_issue to file an issue. Write the description in markdown and reference uploaded attachments by their '/uploads/<hash>/<name>' path (from gitlab_upload_file) — never a raw branch URL. Look label names up with gitlab_list_labels first; this token cannot create labels. Assignees need numeric user ids, and this token cannot list users, so leave `assigneeIds` unset unless the user supplied ids."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_create_issue",
    description: "Creates an issue and returns its iid and web URL. Supports title, markdown description, labels (existing names only), milestone, due date, confidentiality, and numeric assignee ids. Marked non-concurrent-safe: it is a write with an observable side effect.",
    parameters: {
      project: PROJECT_PARAM,
      title: { type: "string", required: true, description: "Issue title." },
      description: { type: "string", description: "Issue description in markdown. Embed attachments as '/uploads/<hash>/<name>' (the `markdown` field returned by gitlab_upload_file)." },
      labels: { type: "string", description: "Comma-separated label NAMES that already exist on the project (see gitlab_list_labels)." },
      milestoneId: { type: "number", description: "Milestone iid (see gitlab_list_milestones)." },
      assigneeIds: { type: "string", description: "Comma-separated numeric user ids. This token cannot list users, so only pass ids the user gave you." },
      dueDate: { type: "string", description: "Due date, YYYY-MM-DD." },
      confidential: { type: "boolean", description: "Mark the issue confidential (default false)." },
      issueType: { type: "string", enum: ["issue", "incident", "test_case", "task"], description: "Issue type (default 'issue')." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const payload = { title: args.title };
      if (args.description != null) payload.description = args.description;
      if (args.labels) payload.labels = args.labels;
      if (args.milestoneId != null) payload.milestone_id = Number(args.milestoneId);
      if (args.assigneeIds) payload.assignee_ids = String(args.assigneeIds).split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (args.dueDate) payload.due_date = args.dueDate;
      if (args.confidential != null) payload.confidential = Boolean(args.confidential);
      if (args.issueType) payload.issue_type = args.issueType;
      const { text } = await request(ctx, config, "POST", `/projects/${encodeProject(args.project)}/issues`, { json: payload, signal: exec.signal });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return `Issue created, but the response was not JSON: ${text.slice(0, 300)}`;
      }
      return `Created issue ${args.project}#${data.iid} (id ${data.id})\n${data.web_url ?? ""}\nstate: ${data.state}\ntitle: ${data.title}`;
    },
    presentCall: (args) => ({ card: "generic", title: `New issue: ${args.title}`, kind: "gitlab-create-issue", rawInput: args.title })
  }));
}

function applyUpdateIssueTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_update_issue",
    order: 133,
    text: "Use gitlab_update_issue to change an issue's title, description, labels, milestone, assignees, due date, or state. A supplied `description` REPLACES the stored one entirely: read the current description with gitlab_get_issue first and resend the full edited text, never a fragment. Use `addLabels`/`removeLabels` to adjust labels without resending the whole list, and `stateEvent: 'close'` to close."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_update_issue",
    description: "Updates one issue and returns the resulting record summary. Any field you omit is left untouched, except `description`, which replaces the whole stored text when supplied. Use addLabels/removeLabels for incremental label changes, and stateEvent ('close'/'reopen') to change state. Non-concurrent-safe: it is a write.",
    parameters: {
      project: PROJECT_PARAM,
      iid: { type: "number", required: true, description: "Issue iid to update." },
      title: { type: "string", description: "New title." },
      description: { type: "string", description: "New FULL description in markdown; replaces the stored description entirely." },
      labels: { type: "string", description: "Comma-separated label names that REPLACE the issue's whole label set." },
      addLabels: { type: "string", description: "Comma-separated label names to add." },
      removeLabels: { type: "string", description: "Comma-separated label names to remove." },
      milestoneId: { type: "number", description: "Milestone iid to assign (see gitlab_list_milestones)." },
      assigneeIds: { type: "string", description: "Comma-separated numeric user ids that replace the assignee set." },
      dueDate: { type: "string", description: "Due date, YYYY-MM-DD." },
      confidential: { type: "boolean", description: "Confidential flag." },
      stateEvent: { type: "string", enum: ["close", "reopen"], description: "Close or reopen the issue." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const payload = {};
      if (args.title != null) payload.title = args.title;
      if (args.description != null) payload.description = args.description;
      if (args.labels != null) payload.labels = args.labels;
      if (args.addLabels) payload.add_labels = args.addLabels;
      if (args.removeLabels) payload.remove_labels = args.removeLabels;
      if (args.milestoneId != null) payload.milestone_id = Number(args.milestoneId);
      if (args.assigneeIds) payload.assignee_ids = String(args.assigneeIds).split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (args.dueDate) payload.due_date = args.dueDate;
      if (args.confidential != null) payload.confidential = Boolean(args.confidential);
      if (args.stateEvent) payload.state_event = args.stateEvent;
      if (Object.keys(payload).length === 0) throw new Error("tool-gitlab: gitlab_update_issue needs at least one field to change");
      const { text } = await request(ctx, config, "PUT", `/projects/${encodeProject(args.project)}/issues/${Number(args.iid)}`, { json: payload, signal: exec.signal });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return `Issue updated, but the response was not JSON: ${text.slice(0, 300)}`;
      }
      return `Updated issue ${args.project}#${data.iid}\n${fmtIssue(data)}`;
    },
    presentCall: (args) => ({ card: "generic", title: `Update ${args.project}#${args.iid}`, kind: "gitlab-update-issue", rawInput: String(args.iid) })
  }));
}

function applyAddIssueNoteTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_add_issue_note",
    order: 134,
    text: "Use gitlab_add_issue_note to comment on an issue (markdown supported). This token can ADD comments but cannot edit or delete them, so write the final text in one pass."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_add_issue_note",
    description: "Adds a comment (note) to an issue and returns its id and timestamp. Markdown is supported. Editing or deleting an existing comment is not permitted for this token. Non-concurrent-safe: it is a write.",
    parameters: {
      project: PROJECT_PARAM,
      iid: { type: "number", required: true, description: "Issue iid to comment on." },
      body: { type: "string", required: true, description: "Comment body in markdown." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { text } = await request(ctx, config, "POST", `/projects/${encodeProject(args.project)}/issues/${Number(args.iid)}/notes`, {
        json: { body: args.body },
        signal: exec.signal
      });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return `Comment added, but the response was not JSON: ${text.slice(0, 300)}`;
      }
      return `Added comment ${data.id} to ${args.project}#${args.iid} at ${fmtDate(data.created_at)}`;
    },
    presentCall: (args) => ({ card: "generic", title: `Comment on ${args.project}#${args.iid}`, kind: "gitlab-note", rawInput: String(args.iid) })
  }));
}

function applyLinkIssuesTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_link_issues",
    order: 135,
    text: "Use gitlab_link_issues to relate one issue to another (relates_to, blocks, is_blocked_by). Links live on the server and are visible in the web UI. This token can create links but cannot delete them, so pick the relation deliberately. Issues may live in different projects when you pass `targetProject`."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_link_issues",
    description: "Creates a link between two issues. `linkType` is one of relates_to, blocks, or is_blocked_by. Returns both issues' references. Deleting a link is not permitted for this token. Non-concurrent-safe: it is a write.",
    parameters: {
      project: PROJECT_PARAM,
      iid: { type: "number", required: true, description: "Source issue iid." },
      targetProject: { type: "string", description: "Target issue's project (numeric id or 'group/project'); defaults to the source project." },
      targetIid: { type: "number", required: true, description: "Target issue iid." },
      linkType: { type: "string", enum: ["relates_to", "blocks", "is_blocked_by"], description: "Relationship from the source issue to the target (default 'relates_to')." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const targetProject = args.targetProject ?? args.project;
      const { data: target } = await getJson(ctx, config, `/projects/${encodeProject(targetProject)}`, exec.signal);
      const { text } = await request(ctx, config, "POST", `/projects/${encodeProject(args.project)}/issues/${Number(args.iid)}/links`, {
        json: {
          target_project_id: target.id,
          target_issue_iid: Number(args.targetIid),
          link_type: args.linkType || "relates_to"
        },
        signal: exec.signal
      });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return `Link created, but the response was not JSON: ${text.slice(0, 300)}`;
      }
      const sourceRef = data.source_issue ? `${data.source_issue.project_id}#${data.source_issue.iid} (${data.source_issue.title})` : `${args.project}#${args.iid}`;
      const targetRef = data.target_issue ? `${data.target_issue.project_id}#${data.target_issue.iid} (${data.target_issue.title})` : `${targetProject}#${args.targetIid}`;
      return `Linked: ${sourceRef} ${data.link_type ?? args.linkType ?? "relates_to"} ${targetRef} (link id ${data.id ?? "?"})`;
    },
    presentCall: (args) => ({ card: "generic", title: `Link ${args.project}#${args.iid}`, kind: "gitlab-link", rawInput: String(args.targetIid) })
  }));
}

function applyUploadFileTool(ctx, config) {
  ctx.systemPrompt.section({
    name: "tool:gitlab_upload_file",
    order: 136,
    text: "Use gitlab_upload_file to attach a local image or document to a project, then embed the returned '/uploads/<hash>/<name>' path in an issue description or comment — never a raw branch URL. Uploads belong to the project and survive branch cleanup. This token can upload but not delete an upload, so only upload what should stay."
  });
  ctx.tools.register(defineTool({
    name: "gitlab_upload_file",
    description: "Uploads a LOCAL file to a project's upload store and returns its '/uploads/<hash>/<name>' path plus ready-to-paste markdown. Use the returned markdown inside an issue description or note so the attachment belongs to the project rather than a temporary branch. Deleting an upload is not permitted for this token.",
    parameters: {
      project: PROJECT_PARAM,
      filePath: { type: "string", required: true, description: "Absolute path of the local file to upload (image, PDF, archive, ...)." },
      alt: { type: "string", description: "Alt text / display name override for the markdown link." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const path = String(args.filePath);
      let bytes;
      try {
        bytes = await readFile(path);
      } catch (error) {
        throw new Error(`tool-gitlab: cannot read ${path} (${error.message})`);
      }
      const filename = args.alt ? String(args.alt) : basename(path);
      const form = new FormData();
      form.append("file", new Blob([bytes]), filename);
      const { text } = await request(ctx, config, "POST", `/projects/${encodeProject(args.project)}/uploads`, { form, signal: exec.signal });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return `Upload finished, but the response was not JSON: ${text.slice(0, 300)}`;
      }
      const url = data.url ?? data.full_path ?? "?";
      const markdown = data.markdown ?? `[${filename}](${url})`;
      const isImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(extname(path));
      const projectPath = `/projects/${encodeProject(args.project)}`;
      let projectWeb = "";
      try {
        const { data: project } = await getJson(ctx, config, projectPath, exec.signal);
        if (project?.web_url) projectWeb = String(project.web_url).replace(/\/+$/, "");
      } catch {
        /* the upload already succeeded; a missing web URL only degrades the hint */
      }
      return [
        `Uploaded ${basename(path)} (${bytes.length} bytes) to ${args.project}`,
        `path: ${url}`,
        `markdown: ${markdown}`,
        isImage ? `to embed as an image, prefix with '!': !${markdown}` : "non-image attachment: use the link form above",
        projectWeb ? `web url: ${projectWeb}${url}` : `api url: ${baseUrl(config)}${url}`
      ].join("\n");
    },
    presentCall: (args) => ({ card: "generic", title: basename(String(args.filePath)), kind: "gitlab-upload", rawInput: args.filePath })
  }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);

  if (config.getProject) applyGetProjectTool(ctx, config);
  if (config.listBranches) applyListBranchesTool(ctx, config);
  if (config.listCommits) applyListCommitsTool(ctx, config);
  if (config.getCommit) applyGetCommitTool(ctx, config);
  if (config.listTree) applyListTreeTool(ctx, config);
  if (config.getFile) applyGetFileTool(ctx, config);
  if (config.listIssues) applyListIssuesTool(ctx, config);
  if (config.getIssue) applyGetIssueTool(ctx, config);
  if (config.listIssueNotes) applyListIssueNotesTool(ctx, config);
  if (config.listLabels) applyListLabelsTool(ctx, config);
  if (config.listMilestones) applyListMilestonesTool(ctx, config);
  if (config.searchProject) applySearchProjectTool(ctx, config);
  if (config.createIssue) applyCreateIssueTool(ctx, config);
  if (config.updateIssue) applyUpdateIssueTool(ctx, config);
  if (config.addIssueNote) applyAddIssueNoteTool(ctx, config);
  if (config.linkIssues) applyLinkIssuesTool(ctx, config);
  if (config.uploadFile) applyUploadFileTool(ctx, config);
}

export { Config, DEFAULT_API_URL, DEFAULT_TIMEOUT_MS, DEFAULT_TOKEN_ENV, SEARCH_SCOPES, apply, encodeProject, inject, name };
