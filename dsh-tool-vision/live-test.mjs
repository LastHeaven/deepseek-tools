// Live end-to-end test of dsh-tool-vision against newapi (MiniMax-M3).
// Key is read from process.env.VISION_KEY so it is never written to disk.
// Uses a LOCAL image (no outbound internet in sandbox) — the plugin reads it,
// base64-embeds it as a data: URI (no detail), matching the working curl shape.
const KEY = process.env.VISION_KEY;
if (!KEY) { console.error("set VISION_KEY first"); process.exit(1); }

const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
  inject(_deps, cb) { cb({ on() { return () => {}; }, get() { return void 0; }, logger: { warn() {} } }); }
};

apply(ctx, {
  apiUrl: "http://newapi.localhost/v1",
  apiKey: KEY,
  model: "minimax-m3",
  detail: "auto",
  sendDetail: false,
  imageFormat: "openai",
  timeoutMs: 120000,
  maxOutputChars: 200000
});

const tool = registered.find((t) => t.name === "describe_image");
const signal = AbortSignal.timeout(90000);

// A LOCAL image (no outbound internet in sandbox). The plugin reads it,
// base64-embeds it as a data: URI (no detail), matching the working curl shape.
const imageUrl = "D:\\git\\deepseek-tools\\dsh-tool-vision\\test-chart.png";

console.log("=== Live: describe_image with a LOCAL image (base64-embedded) ===");
const out = await tool.execute(
  { image: imageUrl, prompt: "这是什么图片？用一句话描述颜色和形状。" },
  { signal }
);
console.log(out);
