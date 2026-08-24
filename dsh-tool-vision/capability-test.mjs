// Capability-gating unit test for @deepseek-ai/dsh-tool-vision.
//
// Proves, without a real harness, that the prompt-assembly listener masks the
// tool schemas to the routed model's declared input modalities:
//   - text-only model (inputModalities: ["text"])        -> `read_image` removed, `describe_image` kept
//   - vision model   (inputModalities: ["text","image"]) -> `describe_image` removed, `read_image` kept
//   - unknown        (inputModalities undefined)         -> `read_image` removed, `describe_image` kept
const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

const VISION_SECTION = "tool:vision";
const SCHEMAS = [
  { name: "read", description: "d", parameters: {} },
  { name: "read_image", description: "d", parameters: {} },
  { name: "describe_image", description: "d", parameters: {} }
];

const FULL_CONFIG = {
  apiUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "m",
  detail: "auto",
  sendDetail: false,
  imageFormat: "openai",
  timeoutMs: 120000,
  maxOutputChars: 200000
};

// One isolated fake world per case: systemPrompt records the single assembly
// listener this apply() registers, and `inject(["llm"], cb)` runs cb with a
// ctx whose `get("llm")` returns the supplied resolver.
function makeWorld(resolver) {
  const listeners = [];
  const systemPrompt = {
    section() { return () => {}; },
    on(name, fn) { if (name === "system-prompt/assemble") listeners.push(fn); return () => {}; }
  };
  const llmCtx = {
    get: (name) => (name === "llm" ? { resolveModelInfo: resolver } : undefined),
    on: (name, fn) => systemPrompt.on(name, fn),
    tools: { register() { return () => {}; } },
    logger: { warn: () => {} }
  };
  const ctx = {
    tools: { register() { return () => {}; } },
    systemPrompt,
    inject: (_deps, cb) => cb(llmCtx)
  };
  apply(ctx, { ...FULL_CONFIG });
  const listener = listeners[0];
  const assembly = {
    sections: [{ name: VISION_SECTION, text: "describe_image guidance" }],
    tools: SCHEMAS.map((t) => ({ ...t })),
    variables: {}
  };
  return listener(assembly, {
    scope: {},
    agent: { options: { provider: "p", model: "m" }, session: { requestHeader: () => undefined } },
    signal: undefined
  }, () => Promise.resolve(assembly));
}

const names = (assembly) => assembly.tools.map((t) => t.name).sort().join(",");

// 1) text-only model -> read_image hidden, describe_image kept
const textOnly = await makeWorld(async () => ({ inputModalities: ["text"] }));
console.log("text-only -> read_image hidden:", names(textOnly) === "describe_image,read" ? "PASS" : "FAIL (" + names(textOnly) + ")");

// 2) vision model -> describe_image hidden, read_image kept; guidance section dropped
const vision = await makeWorld(async () => ({ inputModalities: ["text", "image"] }));
const visionOk = names(vision) === "read,read_image" && !vision.sections.some((s) => s.name === VISION_SECTION);
console.log("vision -> describe_image hidden + section dropped:", visionOk ? "PASS" : "FAIL (" + names(vision) + " sections=" + vision.sections.map((s) => s.name).join(",") + ")");

// 3) unknown modalities -> read_image hidden, describe_image kept
const unknown = await makeWorld(async () => ({ inputModalities: undefined }));
console.log("unknown modalities -> read_image hidden:", names(unknown) === "describe_image,read" ? "PASS" : "FAIL (" + names(unknown) + ")");

// 4) resolver failure -> read_image hidden (fail closed), describe_image kept
const failed = await makeWorld(async () => { throw new Error("boom"); });
console.log("resolver failure -> read_image hidden:", names(failed) === "describe_image,read" ? "PASS" : "FAIL (" + names(failed) + ")");
