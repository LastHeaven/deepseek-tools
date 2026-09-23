// Validate the model-facing tool schemas of @deepseek-ai/dsh-tool-tourmind.
// Mirrors the DSH registration rules that throw at load time.
import { apply, Config } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-tourmind/lib/index.js";

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
};

apply(ctx, Config({}));

let problems = 0;
function fail(msg) { console.log("  ! " + msg); problems += 1; }

// Type-check a JsonSchemaNode recursively against the documented DSL.
function checkNode(path, node) {
  if (!node || typeof node !== "object") { fail(`${path}: not a schema node`); return; }
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) fail(`${path}: oneOf must be a non-empty array`);
    else node.oneOf.forEach((n, i) => checkNode(`${path}.oneOf[${i}]`, n));
    return;
  }
  const type = node.type;
  if (type === undefined) { fail(`${path}: no type and no oneOf`); return; }
  if (type === "object") {
    if (node.additionalProperties !== true && node.additionalProperties !== false) {
      fail(`${path}: object must declare additionalProperties explicitly (true|false)`);
    }
    for (const [k, v] of Object.entries(node.properties || {})) checkNode(`${path}.${k}`, v);
  } else if (type === "array") {
    if (!node.items) fail(`${path}: array must declare items`);
    else checkNode(`${path}.items`, node.items);
  } else if (type === "json") {
    // open container, fine
  } else if (!["string", "number", "integer", "boolean", "null"].includes(type)) {
    fail(`${path}: unsupported type "${type}"`);
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) fail(`${path}: enum must be an array`);
  // enum values must match the declared type
  if (Array.isArray(node.enum)) {
    for (const v of node.enum) {
      const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      const expected = type === "integer" ? "number" : type;
      if (actual !== expected && !(type === "json")) fail(`${path}: enum value ${JSON.stringify(v)} (${actual}) does not match type ${type}`);
    }
  }
}

console.log(`Registered: ${registered.length} tools`);
for (const tool of registered) {
  if (!tool.name) fail("a tool has no name");
  if (!tool.description || tool.description.length < 20) fail(`${tool.name}: description missing or too short`);
  if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) fail(`${tool.name}: timeoutMs must be a positive finite number`);
  if (!tool.output || !tool.output.schema) fail(`${tool.name}: missing output.schema`);
  else if (tool.output.schema.type !== "string") fail(`${tool.name}: output.schema.type should be string`);
  if (typeof tool.output?.render !== "function") fail(`${tool.name}: missing output.render`);
  else {
    const rendered = tool.output.render({}, "probe");
    if (!Array.isArray(rendered) || rendered[0]?.type !== "text" || typeof rendered[0]?.text !== "string") {
      fail(`${tool.name}: output.render must return [{type:"text", text}]`);
    }
  }
  if (typeof tool.execute !== "function") fail(`${tool.name}: missing execute`);
  // defineTool generates the top-level object wrapper (no additionalProperties
  // there, same as the shipped dsh-tool-firecrawl). The explicit
  // additionalProperties requirement applies to NESTED object nodes only.
  const p = tool.parameters;
  if (!p || p.type !== "object") fail(`${tool.name}: parameters is not an object schema`);
  else {
    for (const [k, v] of Object.entries(p.properties || {})) checkNode(`${tool.name}.parameters.${k}`, v);
    if (Array.isArray(p.required)) {
      for (const r of p.required) {
        if (!v_hasProp(p, r)) fail(`${tool.name}.parameters: required "${r}" is not a declared property`);
      }
    }
  }
}

function v_hasProp(schema, key) {
  return Object.prototype.hasOwnProperty.call(schema.properties || {}, key);
}

// Duplicate names would make one tool unreachable.
const names = registered.map((t) => t.name);
if (new Set(names).size !== names.length) fail("duplicate tool names");

console.log("");
console.log(problems === 0 ? `ALL SCHEMA CHECKS PASSED (${registered.length} tools)` : `${problems} PROBLEM(S)`);
console.log("");
console.log("Tool names:");
for (const n of names) console.log("  " + n);
process.exitCode = problems === 0 ? 0 : 1;
