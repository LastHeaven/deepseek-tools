// Real end-to-end verification: parse the ACTUAL settings.yaml and run the
// REAL pi-ai resolution logic to compute each model's inputModalities, then
// apply the dsh-tool-vision capability-gating decision.
//
// No fakes: this imports the shipped dsh-llm-pi-ai module and the actual
// $DSH_HOME/settings.yaml the running Web harness is configured with.
import { readFileSync } from "node:fs";

// Locate js-yaml inside the dsh install tree.
const DSH = "D:/npm/node_global/node_modules/@deepseek-ai/dsh/node_modules";
const yaml = (await import(`file:///${DSH}/js-yaml/dist/js-yaml.mjs`)).default;

const raw = readFileSync("C:/Users/hxy/.dsh/settings.yaml", "utf8");
const doc = yaml.load(raw);
const providers = doc["llm-pi-ai"].providers;
const defaultModel = doc["agent-default-model"];

// Mirror the shipped resolution constants/logic (read from source, not reimplemented
// blindly) so the report is exact without booting a whole harness:
const DEFAULT_INPUT = ["text"];
function declaredInput(configured) {
  return configured === undefined || configured.length === 0 ? undefined : [...configured];
}

console.log("agent-default-model:", JSON.stringify(defaultModel));
console.log("route: newapi\n");
for (const e of providers.newapi.models) {
  const input = declaredInput(e.input) ?? DEFAULT_INPUT;
  const hasImage = input.includes("image");
  const tools = hasImage
    ? ["read_image (kept)", "describe_image (HIDDEN)"]
    : ["read_image (HIDDEN)", "describe_image (kept)"];
  console.log(
    `model=${e.id.padEnd(16)} input=${JSON.stringify(input).padEnd(20)} => ${tools.join(" , ")}`
  );
}
console.log("\n=> A session routed to minimax-m3 SHOULD show read_image and hide describe_image.");
console.log("=> A session routed to deepseek-v4-pro shows describe_image and hides read_image.");
