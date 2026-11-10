// Documentation consistency check for @deepseek-ai/dsh-build-panel.
//
// The README documents exact contract details — the row id, the slot, the two
// Remote methods, the four workflow steps, the packaging fields, the absence of a
// config page. All of them have changed during development, and a stale sentence
// reads exactly like a correct one at review time. This re-derives each claim
// from the code and fails when the prose and the implementation drift apart.
//
//   node doc-check.mjs
//
// Exits non-zero on any mismatch, so it can gate a commit.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = readFileSync(join(HERE, "README.md"), "utf8");
const host = readFileSync(join(HERE, "lib", "index.js"), "utf8");
const client = readFileSync(join(HERE, "lib", "client.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const patch = readFileSync(join(HERE, "cordis.patch.yml"), "utf8");
const guides = {
  plugin: readFileSync(join(HERE, "..", "PLUGIN-DEVELOPMENT-GUIDE.md"), "utf8"),
  dual: readFileSync(join(HERE, "..", "DUAL-FACE-PLUGIN-GUIDE.md"), "utf8")
};

/** One line of the Host half, trimmed, by a substring it must contain. */
const hostLine = (needle) => (host.split("\n").find((line) => line.includes(needle)) ?? "").trim();

/** The `docs/<...>` paths the workflow instruction interpolates. */
const instructionPaths = [...new Set(
  [...host.matchAll(/docs\/\$\{id\}\/([A-Za-z.]+)/g)].map((match) => match[1])
)].sort();

const checks = [
  // Version: the manifest and the history table must agree.
  ["manifest version is 1.0.0", manifest.version === "1.0.0", manifest.version],
  ["README history names the current version", read.includes(`| ${manifest.version} |`)],

  // The row: the id the slot and the panel are keyed by.
  ["patch sets the build-panel id", /id:\s*build-panel/.test(patch)],
  ["README states the same id", read.includes("id: build-panel")],
  ["patch mounts the package by name", patch.includes(`'${manifest.name}'`)],
  ["README states the same package name", read.includes(manifest.name)],
  ["the client registers under the same slot id", client.includes('id: "build-panel"')],

  // The two planes, and where each one lands.
  ["the service namespace is buildPanel", host.includes('super(ctx, "buildPanel")')],
  ["the service exposes exactly list and overview", (host.match(/marker\("(\w+)"\)/g) ?? []).length === 2
    && /marker\("list"\)/.test(host) && /marker\("overview"\)/.test(host)],
  ["the client calls both endpoints", client.includes('callBuildPanel("list"') && client.includes('callBuildPanel("overview"')],
  ["README names both endpoints", read.includes("buildPanel/list") && read.includes("buildPanel/overview")],
  ["the browse plane queues nothing", !/followup\(/.test(host.slice(host.indexOf("class BuildPanelService"), host.indexOf("function apply")))],

  // The drive plane: the command surface.
  ["the command is named build", host.includes('name: "build"')],
  ["the command accepts only run", /sub === "run" \|\| sub\.startsWith\("run "\)/.test(host)],
  ["README documents the run-only surface", read.includes("/build <任务号> run")],
  ["the commit subcommand is gone from the host", !/commit/.test(host.replace(/^\/\/.*$/gm, ""))],
  ["the commit wording is gone from the client", !/commit/.test(client)],
  ["README history records the removed commit surface", !read.includes("执行 commit")],
  ["the drive plane queues a model-visible follow-up", host.includes("invocation.agent.followup(createUserMessage(")],
  ["README explains the follow-up", read.includes("agent.followup") || read.includes("follow-up")],

  // The four workflow steps, and the paths they interpolate.
  ["the instruction has four numbered steps", (host.match(/^## \d\./gm) ?? []).length === 4,
    `${(host.match(/^## \d\./gm) ?? []).length} step(s)`],
  ["README lists the four steps", (read.match(/^\d\. /gm) ?? []).length >= 4],
  ["every instruction path is in the README table",
    instructionPaths.every((path) => read.includes(path)), instructionPaths.filter((path) => !read.includes(path)).join(", ")],

  // Session resolution: a per-call read of the session's cwd.
  ["the docs root comes from the session cwd", host.includes('const cwd = session.header.cwd')],
  ["a missing cwd fails loud", hostLine("当前会话缺少工作目录").includes("throw") || host.includes('return { kind: "error", text: "当前会话缺少工作目录 cwd" }')],
  ["README states a missing cwd is an error", read.includes("without a working directory") && read.includes("error")],
  ["README states a missing docs/ is an empty list", read.includes("empty list")],

  // Both halves come from one row, which is what makes enable/disable whole.
  ["the manifest declares the bundle patch", manifest.dsh?.bundle?.patch === "./cordis.patch.yml"],
  ["the manifest declares the web client half", manifest.dsh?.client?.platform === "web"],
  ["README explains that both halves share one row", read.includes("both halves") || read.includes("Both halves")],
  ["README explains the browser needs a refresh", /page refresh/i.test(read)],

  // No Config: the row must not gain a configuration page.
  ["the host declares no Config schema", !/\bConfig\b/.test(host.replace(/^\/\/.*$/gm, ""))],
  ["the patch carries no config block", !/^\s*config:/m.test(patch)],
  ["README explains the missing config page", read.includes("no `Config`") || read.includes("no Config")],

  // Packaging.
  ["files ships the patch layer", (manifest.files ?? []).includes("cordis.patch.yml")],
  ["files ships the client bundle", (manifest.files ?? []).includes("lib/client.js")],
  ["files ships the locales", (manifest.files ?? []).includes("locale/*.json")],
  ["files ships the icon", (manifest.files ?? []).includes("icon.svg")],
  ["manifest names an icon", typeof manifest.icon === "string"],
  ["manifest exports ./client", manifest.exports?.["./client"] === "./lib/client.js"],
  ["manifest exports the patch layer", manifest.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml"],
  ["manifest declares engines.dsh", typeof manifest.engines?.dsh === "string"],

  // The browser half must stay free of Harness Client packages, and of the
  // module-system rules it cannot break.
  ["the client imports no Harness Client package", !/require\(["']@deepseek-ai\//.test(client)],
  ["the client requires only react", JSON.stringify([...client.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])) === JSON.stringify(["react"]),
    [...client.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]).join(", ")],
  ["the client never uses JSX or import", !/^\s*import\s/m.test(client)],
  ["README states the seed-word rule", read.includes("seed word")],

  // The session selector the panel depends on: the stale `state.current` shape
  // renders a disabled badge instead of failing, so it is called out in prose.
  ["the selector reads retainedBy.mainView", client.includes("retainedBy?.mainView")],
  ["README warns about the stale selector", read.includes("stale session selector") || read.includes("disabled \"无会话\"")],

  // Both guides must stop calling this package a bare module.
  ["the plugin guide no longer lists build-panel as a bare module", !/dsh-ask-popup`、`dsh-build-panel`/.test(guides.plugin)
    && !/`dsh-build-panel` 目前都还是/.test(guides.plugin)],
  ["the dual-face guide no longer calls it a bare module", !/dsh-build-panel` 目前仍是\*\*裸模块\*\*/.test(guides.dual)],
  ["the dual-face guide points at the shipped bundle", guides.dual.includes("dsh.bundle.patch")],
];

let failures = 0;
for (const [label, ok, detail] of checks) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail === undefined || detail === "" ? "" : ` — ${detail}`}`);
  }
}

console.log(`\n${failures === 0 ? "README CONSISTENT WITH CODE" : `${failures} MISMATCH(ES)`}`);
process.exit(failures === 0 ? 0 : 1);
