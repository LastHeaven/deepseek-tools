// Smoke test for @local/dsh-tool-gitlab.
//
// Drives the plugin WITHOUT the DSH loader: it builds a fake ctx, calls apply(),
// and then exercises the registered tools against the live GitLab instance. The
// loader is skipped on purpose, so the config object passed here must be complete
// (no schemastery defaults are applied).
//
//   node smoke-test.mjs                      register + read-only checks
//   GITLAB_SMOKE_WRITE=1 node smoke-test.mjs also create/close a scratch issue
//   GITLAB_SMOKE_UPLOAD=<path> node smoke-test.mjs  also upload that file
//
// The token comes from the harness credential store (`GITLAB_TOKEN`) or from the
// GITLAB_TOKEN environment variable; it is never printed.

// Peer deps (`@deepseek-ai/*`) resolve from the DSH profile, not from this
// checkout, so the test drives the INSTALLED copy. Override with GITLAB_PLUGIN.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN =
  process.env.GITLAB_PLUGIN ??
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@local/dsh-tool-gitlab/lib/index.js";

const { apply, name, inject, Config } = await import(PLUGIN);

const PROJECT = process.env.GITLAB_SMOKE_PROJECT ?? "cx/trip";

function loadToken() {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
  const file = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const match = /^\s*GITLAB_TOKEN:\s*(.+?)\s*$/m.exec(text);
  return match ? match[1].replace(/^["']|["']$/g, "") : undefined;
}

const token = loadToken();
if (!token) {
  console.error("no token: set GITLAB_TOKEN or store it in the harness credential store");
  process.exit(1);
}

// The fake ctx: only the two injected services plus the optional credential seam
// (left undefined here, so the plugin takes the process-environment path).
const registered = [];
const sections = [];
const ctx = {
  tools: {
    register(def) {
      registered.push(def);
      return () => {};
    }
  },
  systemPrompt: {
    section(entry) {
      sections.push(entry);
      return () => {};
    }
  },
  get: () => undefined
};

const config = {
  apiUrl: process.env.GITLAB_API_URL ?? "http://192.168.2.204",
  apiToken: token,
  tokenEnv: "GITLAB_TOKEN",
  getProject: true,
  listBranches: true,
  listCommits: true,
  getCommit: true,
  listTree: true,
  getFile: true,
  listIssues: true,
  getIssue: true,
  listIssueNotes: true,
  listLabels: true,
  listMilestones: true,
  searchProject: true,
  createIssue: true,
  updateIssue: true,
  addIssueNote: true,
  linkIssues: true,
  uploadFile: true,
  timeoutMs: 60000,
  maxOutputChars: 200000
};

// The loader would reject an incomplete config; prove the schema accepts this one.
Config(config);

apply(ctx, config);

console.log(`plugin: ${name} | inject: ${JSON.stringify(inject)}`);
console.log(`tools (${registered.length}): ${registered.map((t) => t.name).join(", ")}`);
console.log(`prompt sections: ${sections.length}`);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const signal = AbortSignal.timeout(60000);
const exec = { signal };

let failures = 0;
async function check(label, fn, expect = () => true) {
  try {
    const value = await fn();
    const verdict = expect(value);
    console.log(`\n=== ${label} — ${verdict === true ? "OK" : "UNEXPECTED"}`);
    console.log(String(value).slice(0, 700));
    if (verdict !== true) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`\n=== ${label} — FAILED`);
    console.log(String(error.message).slice(0, 700));
  }
}

/** Run a tool and return its text, or undefined when it fails. */
async function quietly(tool, args) {
  try {
    return await byName[tool].execute(args, exec);
  } catch {
    return undefined;
  }
}

await check("gitlab_get_project", () => byName.gitlab_get_project.execute({ project: PROJECT }, exec), (v) => /default branch:/.test(v));
await check("gitlab_list_branches", () => byName.gitlab_list_branches.execute({ project: PROJECT, perPage: 3 }, exec), (v) => /Branches of/.test(v));
await check("gitlab_list_commits", () => byName.gitlab_list_commits.execute({ project: PROJECT, perPage: 3 }, exec), (v) => /Commits in/.test(v));

const commits = await quietly("gitlab_list_commits", { project: PROJECT, perPage: 1 });
const sha = /^([0-9a-f]{8}) /m.exec(commits ?? "")?.[1];
if (sha) await check("gitlab_get_commit (with diff)", () => byName.gitlab_get_commit.execute({ project: PROJECT, sha, diff: true, maxDiffChars: 2000 }, exec), (v) => /message:/.test(v));

await check("gitlab_list_tree", () => byName.gitlab_list_tree.execute({ project: PROJECT, path: "docs", perPage: 5 }, exec), (v) => /Tree of/.test(v));
await check("gitlab_get_repository_file", () => byName.gitlab_get_repository_file.execute({ project: PROJECT, filePath: "README.md" }, exec), (v) => /trip|File README/.test(v));
await check("gitlab_list_issues", () => byName.gitlab_list_issues.execute({ project: PROJECT, perPage: 2 }, exec), (v) => /Issues in/.test(v));
await check("gitlab_list_labels", () => byName.gitlab_list_labels.execute({ project: PROJECT, perPage: 5 }, exec), (v) => /Labels in/.test(v));
await check("gitlab_list_milestones", () => byName.gitlab_list_milestones.execute({ project: PROJECT, perPage: 3 }, exec), (v) => /Milestones in/.test(v));
await check("gitlab_search_project (blobs)", () => byName.gitlab_search_project.execute({ project: PROJECT, scope: "blobs", search: "hotel", perPage: 2 }, exec), (v) => /Project search/.test(v));
await check("gitlab_search_project (issues)", () => byName.gitlab_search_project.execute({ project: PROJECT, scope: "issues", search: "hotel", perPage: 2 }, exec), (v) => /Project search/.test(v));

const issueList = await quietly("gitlab_list_issues", { project: PROJECT, perPage: 1 });
const iid = /#(\d+) \[/.exec(issueList ?? "")?.[1];
if (iid) {
  await check("gitlab_get_issue (with notes)", () => byName.gitlab_get_issue.execute({ project: PROJECT, iid: Number(iid), includeNotes: true, notesLimit: 3 }, exec), (v) => /description:/.test(v));
  await check("gitlab_list_issue_notes", () => byName.gitlab_list_issue_notes.execute({ project: PROJECT, iid: Number(iid), perPage: 3 }, exec), (v) => /Comments on/.test(v));
}

if (process.env.GITLAB_SMOKE_WRITE === "1") {
  const writeProject = process.env.GITLAB_SMOKE_WRITE_PROJECT ?? "hexingyu/test-merge";
  let created;
  try {
    created = await byName.gitlab_create_issue.execute({
      project: writeProject,
      title: "dsh-tool-gitlab smoke test — safe to close",
      description: "Created by `dsh-tool-gitlab/smoke-test.mjs` to prove the write path. The token cannot delete issues, so this is closed rather than removed."
    }, exec);
    console.log(`\n=== gitlab_create_issue — OK\n${created}`);
  } catch (error) {
    failures += 1;
    console.log(`\n=== gitlab_create_issue — FAILED\n${error.message}`);
  }
  const createdIid = /#(\d+)/.exec(created ?? "")?.[1];
  if (createdIid) {
    await check("gitlab_add_issue_note", () => byName.gitlab_add_issue_note.execute({ project: writeProject, iid: Number(createdIid), body: "Note written by the smoke test." }, exec), (v) => /Added comment/.test(v));
    await check("gitlab_update_issue (title + close)", () => byName.gitlab_update_issue.execute({ project: writeProject, iid: Number(createdIid), title: "dsh-tool-gitlab smoke test (closed)", stateEvent: "close" }, exec), (v) => /state\]|Updated issue/.test(v));
    // Link creation is REPORTED, not asserted: this token can create links but
    // not delete them, so a failed attempt must not leave debris behind either.
    try {
      const linked = await byName.gitlab_link_issues.execute({ project: writeProject, iid: Number(createdIid), targetIid: Number(createdIid), linkType: "relates_to" }, exec);
      console.log(`\n=== gitlab_link_issues — OK\n${linked}`);
    } catch (error) {
      console.log(`\n=== gitlab_link_issues — not attempted/accepted: ${error.message.slice(0, 300)}`);
    }
    console.log(`\nNOTE: this token cannot DELETE issues; issue ${writeProject}#${createdIid} is left CLOSED — delete it in the web UI if it should not stay.`);
  }
}

if (process.env.GITLAB_SMOKE_UPLOAD) {
  await check("gitlab_upload_file", () => byName.gitlab_upload_file.execute({ project: process.env.GITLAB_SMOKE_PROJECT ?? PROJECT, filePath: process.env.GITLAB_SMOKE_UPLOAD }, exec), (v) => /path: \/uploads\//.test(v));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
