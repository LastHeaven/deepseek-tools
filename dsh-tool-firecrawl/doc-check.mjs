// Documentation consistency check for @deepseek-ai/dsh-tool-firecrawl.
//
// The README documents exact contract details — the slot key, which Config fields
// are page-editable, the credential wire shape, the styling tokens. All of them
// have changed during development, and a stale sentence is indistinguishable from
// a correct one at review time. This re-derives each claim from the code and fails
// when the prose and the implementation drift apart.
//
//   node doc-check.mjs
//
// Exits non-zero on any mismatch, so it can gate a commit.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = readFileSync(join(HERE, "README.md"), "utf8");
const client = readFileSync(join(HERE, "lib", "client.js"), "utf8");
const host = readFileSync(join(HERE, "lib", "index.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const patch = readFileSync(join(HERE, "cordis.patch.yml"), "utf8");

/** Whether one dictionary object declares a key more than once. */
function declaresNoKeyTwice(from, to) {
  const seen = new Map();
  for (const match of client.slice(from, to).matchAll(/^\s{6}([A-Za-z][\w]*):/gm)) {
    seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
  }
  return [...seen.values()].every((count) => count === 1);
}

const enStart = client.indexOf("const en = {");
const zhStart = client.indexOf("const zh = {");
const cssStart = client.indexOf("const CSS");

/** The fields the client form edits, read out of its own arrays. */
const listIn = (name) => {
  const match = client.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  return match === null ? [] : match[1].split(",").map((entry) => entry.trim().replace(/"/g, "")).filter(Boolean);
};
const toolFields = listIn("TOOL_FIELDS");
const countFields = listIn("COUNT_FIELDS");
const editedFields = [...toolFields, ...countFields, "apiUrl", "apiKeyEnv"];

/** One schema line from the Host half, by field name. */
const schemaLine = (field) => (host.split("\n").find((line) => line.trimStart().startsWith(`${field}: `)) ?? "").trim();

/** The `Config` fields the Host half marks `.volatile()`, read line by line. */
const volatileFields = host
  .split("\n")
  .filter((line) => line.includes(".volatile()"))
  .map((line) => /^\s{2}(\w+):/.exec(line)?.[1])
  .filter((field) => field !== undefined)
  .sort();

/** The client dictionary label keys, which differ from the field names for the
 * two text fields: `apiUrl` is labelled `endpoint`, `apiKeyEnv` is `keyReference`. */
const LABEL_KEY = { apiUrl: "endpoint", apiKeyEnv: "keyReference" };
const labelKeyOf = (field) => LABEL_KEY[field] ?? field;

const checks = [
  // Version: the manifest and the history table must agree.
  ["manifest version is 1.1.0", manifest.version === "1.1.0", manifest.version],
  ["README history names the current version", read.includes(`| ${manifest.version} |`)],
  ["README history names the previous version", read.includes("1.0.0")],

  // The row-config slot key: composed in code, spelled out in prose.
  ["row id matches the bundled patch", /id:\s*tool-firecrawl/.test(patch)],
  ["code composes the key as <package>#<row id>", client.includes('const ROW_ID = "tool-firecrawl"') && client.includes("`${PACKAGE}#${ROW_ID}`")],
  ["README states the same key", read.includes(`${manifest.name}#tool-firecrawl`)],

  // Locale namespace.
  ["code registers the toolFirecrawl namespace", client.includes('"toolFirecrawl"')],
  ["README names the namespace", read.includes("toolFirecrawl")],

  // Which fields the page edits: volatile in the Host half, listed in the table.
  ["the Host half marks 13 fields volatile", volatileFields.length === 13, volatileFields.join(", ")],
  ["the client form edits exactly those 13 fields",
    JSON.stringify([...editedFields].sort()) === JSON.stringify(volatileFields),
    `client: ${[...editedFields].sort().join(", ")}`],
  ["apiKey stays plain", schemaLine("apiKey").includes('apiKey: z.string().default("")') && !schemaLine("apiKey").includes(".volatile()"), schemaLine("apiKey")],
  ["timeoutMs stays plain", schemaLine("timeoutMs").includes("timeoutMs: z.number()") && !schemaLine("timeoutMs").includes(".volatile()"), schemaLine("timeoutMs")],
  ["README marks exactly those two as patch only", (read.match(/❌ patch only/g) ?? []).length === 2],
  ["README marks thirteen fields as live", (read.match(/✅ live/g) ?? []).length === 13],
  ["the README table lists every edited field", editedFields.every((field) => read.includes(`\`${field}\``))],

  // The credential wire contract.
  ["code reads the dotted namespace key", client.includes('ctx.get("remote.credentials")')],
  ["code never reaches through the facade", !/ctx\.get\(\s*"remote"\s*\)\?\.\w/.test(client)],
  ["code unwraps the RemoteResult envelope", client.includes("result.ok !== true")],
  ["README documents the dotted key", read.includes('ctx.get("remote.credentials")')],
  ["README documents the envelope", read.includes("RemoteResult") && read.includes("ok, value")],
  ["README documents the inject trap", read.includes("without inject")],

  // Styling invariants the page depends on.
  ["code uses the host radius token", client.includes("--dsw-radius-sm")],
  ["README names the radius token", read.includes("--dsw-radius-sm")],
  ["code has no literal hex colour", !/:\s*#[0-9a-fA-F]{3,8}\b/.test(client)],
  ["buttons never wrap", /\.fcw-button\s*\{[^}]*white-space:\s*nowrap/.test(client)],
  ["buttons keep their own width", /\.fcw-button\s*\{[^}]*flex:\s*0 0 auto/.test(client)],
  ["the key input may shrink", /\.fcw-secretRow\s*>\s*\.fcw-input\s*\{[^}]*min-width:\s*0/.test(client)],

  // Per-tool switches are step-time gates, which is what makes them live.
  ["every tool gates on a when condition", (host.match(/when: enabledWhen\(config,/g) ?? []).length === 7,
    `${(host.match(/when: enabledWhen\(config,/g) ?? []).length} gated registration(s)`],
  ["README documents the when gate", read.includes("{ when }")],
  ["all seven tool names appear in the README",
    ["firecrawl_scrape", "firecrawl_search", "firecrawl_developer_search", "firecrawl_map", "firecrawl_parse", "firecrawl_crawl", "firecrawl_check_crawl_status"]
      .every((toolName) => read.includes(toolName))],

  // Dictionaries: one declaration per key inside each language object.
  ["en declares no key twice", declaresNoKeyTwice(enStart, zhStart)],
  ["zh declares no key twice", declaresNoKeyTwice(zhStart, cssStart)],
  ["every edited field has a label", editedFields.every((field) => new RegExp(`^\\s{6}${labelKeyOf(field)}: `, "m").test(client)),
    editedFields.filter((field) => !new RegExp(`^\\s{6}${labelKeyOf(field)}: `, "m").test(client)).join(", ")],
  ["every edited field has a hint", editedFields.every((field) => new RegExp(`^\\s{6}${labelKeyOf(field)}Hint: `, "m").test(client)),
    editedFields.filter((field) => !new RegExp(`^\\s{6}${labelKeyOf(field)}Hint: `, "m").test(client)).join(", ")],

  // The browser half must stay free of Harness Client packages.
  ["client imports no Harness Client package", !/require\(["']@deepseek-ai\//.test(client)],
  ["README states the same", read.includes("does not import `@deepseek-ai/dsh-client-ui-primitives`")],

  // Packaging.
  ["manifest declares the web client half", manifest.dsh?.client?.platform === "web"],
  ["manifest exports ./client", manifest.exports?.["./client"] === "./lib/client.js"],
  ["files ships lib/client.js", (manifest.files ?? []).includes("lib/client.js")],
  ["the patch carries no literal API key", !/apiKey:/.test(patch)],
];

let failures = 0;
for (const [label, ok, detail] of checks) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

console.log(`\n${failures === 0 ? "README CONSISTENT WITH CODE" : `${failures} MISMATCH(ES)`}`);
process.exit(failures === 0 ? 0 : 1);
