// Verify every bundled wecomcli-* skill satisfies DSH's skill contract:
// valid YAML frontmatter with a non-empty `name` (matching SKILL_NAME) and
// `description`, plus optional metadata. A malformed skill is silently ignored
// by dsh-skill-filesystem with only a logger warning, so this is a real check.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const root = process.argv[2] ?? "C:/Users/hxy/.dsh/.agent-presets/wecom/skills";

// Mirror dsh-skill's frontmatter extraction: leading `---` fence, then `---`.
function extractFrontmatter(raw) {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(normalized)) return undefined;
  const rest = normalized.slice(normalized.indexOf("\n") + 1);
  const close = rest.search(/^---\s*$/m);
  if (close === -1) return undefined;
  return rest.slice(0, close);
}

const dirs = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
let failures = 0;
const summary = [];

for (const dir of dirs) {
  const file = join(root, dir, "SKILL.md");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    failures += 1;
    summary.push(`MISSING  ${dir}: no SKILL.md`);
    continue;
  }
  const fm = extractFrontmatter(raw);
  if (fm === undefined) {
    failures += 1;
    summary.push(`NOFM     ${dir}: missing frontmatter fence`);
    continue;
  }
  let data;
  try {
    data = YAML.parse(fm);
  } catch (e) {
    failures += 1;
    summary.push(`BADYAML  ${dir}: ${e.message.split("\n")[0]}`);
    continue;
  }
  if (!data || typeof data !== "object") {
    failures += 1;
    summary.push(`NODATA   ${dir}`);
    continue;
  }
  const problems = [];
  if (typeof data.name !== "string" || data.name.length === 0) problems.push("no name");
  else if (!SKILL_NAME.test(data.name)) problems.push(`name fails SKILL_NAME: ${JSON.stringify(data.name)}`);
  if (typeof data.description !== "string" || data.description.length === 0) problems.push("no description");
  // Reject the legacy invocation keys the parser refuses outright.
  for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
    if (Object.hasOwn(data, legacy)) problems.push(`legacy invocation key ${legacy}`);
  }
  // The frontmatter `name` should match the directory name for clarity.
  if (data.name !== dir) problems.push(`name ${JSON.stringify(data.name)} != dir ${JSON.stringify(dir)}`);

  if (problems.length > 0) {
    failures += 1;
    summary.push(`INVALID  ${dir}: ${problems.join("; ")}`);
  } else {
    const meta = data.metadata ? ` metadata=${JSON.stringify(Object.keys(data.metadata))}` : "";
    summary.push(`OK       ${dir}: name=${data.name}, desc=${data.description.slice(0, 40)}…${meta}`);
  }
}

console.log(summary.join("\n"));
console.log(`\n${dirs.length} skill directories, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
