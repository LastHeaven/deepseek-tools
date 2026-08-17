// Remote-URL embedding unit test for @deepseek-ai/dsh-tool-vision.
//
// Proves the plugin FETCHES a remote http(s) image and embeds it as a base64
// data: URI (instead of passing the remote URL through). A fake fetch supplies
// image bytes + a content-type, so no real network is needed.
const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

let lastBody = null;
globalThis.fetch = async (url, init) => {
  // When called for the backend, capture body; when called for the image URL,
  // return fake image bytes.
  if (String(url).startsWith("http://newapi")) {
    lastBody = JSON.parse(init.body);
    return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "seen" } }] }); } };
  }
  // image fetch
  return {
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
    async arrayBuffer() { return Uint8Array.from(atob(FAKE_PNG_B64), (c) => c.charCodeAt(0)).buffer; }
  };
};

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } }
};
apply(ctx, {
  apiUrl: "http://newapi.localhost/v1", apiKey: "k", model: "minimax-m3",
  detail: "auto", sendDetail: false, imageFormat: "openai", timeoutMs: 120000, maxOutputChars: 200000
});
const tool = registered.find((t) => t.name === "describe_image");
const signal = AbortSignal.timeout(30000);

const out = await tool.execute({ image: "https://example.test/photo.png", prompt: "describe" }, { signal });
const urlPart = lastBody.messages[0].content.find((c) => c.type === "image_url").image_url.url;
const ok = urlPart.startsWith("data:image/png;base64,") && urlPart.includes(FAKE_PNG_B64);
console.log("Remote URL -> fetched + base64 data: URI:", ok ? "PASS" : "FAIL");
console.log("Backend output:", out);
