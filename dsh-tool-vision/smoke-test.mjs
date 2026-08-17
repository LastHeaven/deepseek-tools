// Smoke test for @deepseek-ai/dsh-tool-vision.
//
// Drives the plugin with a FAKE ctx (no DSH loader) so the logic can be
// verified without restarting the harness. The fake backend is a local
// fetch shim that echoes a canned vision answer, so no real API key or
// network call is needed.
const { apply, name, inject } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

let requestSeen = null;
const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
globalThis.fetch = async (url, init) => {
  // Image fetch (remote URL during resolveImage): return fake PNG bytes.
  if (String(url).startsWith("https://example.invalid/screen.png")) {
    return {
      ok: true, status: 200,
      headers: { get: () => "image/png" },
      async arrayBuffer() { return Uint8Array.from(atob(FAKE_PNG_B64), (c) => c.charCodeAt(0)).buffer; }
    };
  }
  // Backend call.
  requestSeen = { url, body: JSON.parse(init.body) };
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: "A red button labeled 'Submit' on a white form." } }]
      });
    }
  };
};

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } }
};

apply(ctx, {
  apiUrl: "https://example.invalid/v1",
  apiKey: "test-key",
  model: "gpt-4o",
  detail: "auto",
  sendDetail: true,
  imageFormat: "openai",
  timeoutMs: 120000,
  maxOutputChars: 200000
});

console.log("name:", name, "| inject:", JSON.stringify(inject));
console.log("registered:", registered.map((t) => t.name).join(", "));

const signal = AbortSignal.timeout(30000);
const tool = registered.find((t) => t.name === "describe_image");
const out = await tool.execute(
  { image: "https://example.invalid/screen.png", prompt: "What is on this screen?" },
  { signal }
);
console.log("--- backend request url ---");
console.log(requestSeen.url);
console.log("--- backend request model ---");
console.log(requestSeen.body.model);
console.log("--- tool output ---");
console.log(out);
