// Documentation consistency check for @deepseek-ai/dsh-tool-context7.
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

const checks = [
  // Version: the manifest and the history table must agree.
  ["manifest version is 1.1.0", manifest.version === "1.1.0", manifest.version],
  ["README history names the current version", read.includes(`| ${manifest.version} |`)],
  ["README history names the previous version", read.includes("1.0.0")],

  // The row-config slot key: composed in code, spelled out in prose.
  ["row id matches the bundled patch", /id:\s*tool-context7/.test(patch)],
  ["code composes the key as <package>#<row id>", client.includes('const ROW_ID = "tool-context7"') && client.includes("`${PACKAGE}#${ROW_ID}`")],
  ["README states the same key", read.includes(`${manifest.name}#tool-context7`)],

  // Locale namespace.
  ["code registers the toolContext7 namespace", client.includes('"toolContext7"')],
  ["README names the namespace", read.includes("toolContext7")],

  // Which fields the page edits: volatile in the Host half, listed in the table.
  ["apiUrl is volatile", host.includes("apiUrl: z.string().default(API_BASE_URL).volatile()")],
  ["apiKeyEnv is volatile", host.includes('.role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile()')],
  ["resolveLibraryId is volatile", host.includes("resolveLibraryId: z.boolean().default(true).volatile()")],
  ["queryDocs is volatile", host.includes("queryDocs: z.boolean().default(true).volatile()")],
  ["maxOutputChars is volatile", host.includes("maxOutputChars: z.number().step(1).min(1).default(200000).volatile()")],
  ["apiKey stays plain", /apiKey: z\.string\(\)\.default\(""\)/.test(host) && !host.includes("apiKey: z.string().default(\"\").volatile()")],
  ["timeoutMs stays plain", /timeoutMs: z\.number\(\)\.step\(1\)\.min\(1\)\.default\(DEFAULT_TIMEOUT_MS\)/.test(host)],
  ["README marks exactly those two as patch only", (read.match(/❌ patch only/g) ?? []).length === 2],
  ["README marks five fields as live", (read.match(/✅ live/g) ?? []).length === 5],

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
  ["buttons never wrap", /\.tc7-button\s*\{[^}]*white-space:\s*nowrap/.test(client)],
  ["buttons keep their own width", /\.tc7-button\s*\{[^}]*flex:\s*0 0 auto/.test(client)],
  ["the key input may shrink", /\.tc7-secretRow\s*>\s*\.tc7-input\s*\{[^}]*min-width:\s*0/.test(client)],

  // Per-tool switches are step-time gates, which is what makes them live.
  ["both tools gate on a when condition", host.includes("enabledWhen(config,")],
  ["README documents the when gate", read.includes("{ when }")],
  ["both tool names appear in the README", read.includes("context7_resolve_library_id") && read.includes("context7_query_docs")],

  // Dictionaries: one declaration per key inside each language object.
  ["en declares no key twice", declaresNoKeyTwice(enStart, zhStart)],
  ["zh declares no key twice", declaresNoKeyTwice(zhStart, cssStart)],

  // The browser half must stay free of Harness Client packages.
  ["client imports no Harness Client package", !/require\(["']@deepseek-ai\//.test(client)],
  ["README states the same", read.includes("does not import `@deepseek-ai/dsh-client-ui-primitives`")],
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
