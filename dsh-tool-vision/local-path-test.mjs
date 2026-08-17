// Unit test for @deepseek-ai/dsh-tool-vision (no real network).
//
// Verifies the image-resolution path with a fake fetch that supplies image
// bytes for image URLs and a canned JSON answer for the backend:
//   - a local file path is read and embedded as a base64 data: URI (openai)
//     or a base64 source (anthropic)
//   - a remote http(s) URL is FETCHED and embedded as a base64 data: URI too
//     (openai) / base64 source (anthropic) — never passed through as a URL,
//     because some proxies reject remote URLs.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

let lastBody = null;
globalThis.fetch = async (url, init) => {
  // Image fetch: return fake PNG bytes with a content-type.
  if (String(url).startsWith("https://x.test/") || String(url).startsWith("http://example")) {
    return {
      ok: true, status: 200,
      headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "image/png" : null) },
      async arrayBuffer() { return Uint8Array.from(atob(FAKE_PNG_B64), (c) => c.charCodeAt(0)).buffer; }
    };
  }
  // Backend call.
  lastBody = JSON.parse(init.body);
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
};

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } }
};

function cfg(extra) {
  return { apiUrl: "https://example.invalid/v1", apiKey: "k", model: "m", detail: "auto", sendDetail: true, imageFormat: "openai", timeoutMs: 120000, maxOutputChars: 200000, ...extra };
}
function tool() { return registered.filter((t) => t.name === "describe_image").pop(); }

apply(ctx, cfg({}));
const signal = AbortSignal.timeout(30000);
const dir = mkdtempSync(join(tmpdir(), "vision-"));
const imgPath = join(dir, "chart.png");
writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

// 1) local file -> data: URI (openai)
await tool().execute({ image: imgPath, prompt: "p" }, { signal });
const dataPart = lastBody.messages[0].content.find((c) => c.type === "image_url").image_url.url;
console.log("Local file -> data: URI:", dataPart.startsWith("data:image/png;base64,") && dataPart.length > 22 ? "PASS" : "FAIL (" + dataPart.slice(0, 30) + ")");

// 2) remote URL -> fetched + base64 data: URI (openai), NOT passed through
await tool().execute({ image: "https://x.test/a.png", prompt: "p" }, { signal });
const urlPart = lastBody.messages[0].content.find((c) => c.type === "image_url").image_url.url;
console.log("Remote URL -> fetched+base64:", urlPart.startsWith("data:image/png;base64,") && urlPart.includes(FAKE_PNG_B64) ? "PASS" : "FAIL (" + urlPart.slice(0, 30) + ")");

// 3) sendDetail=false omits detail
apply(ctx, cfg({ sendDetail: false }));
await tool().execute({ image: "https://x.test/a.png", prompt: "p" }, { signal });
const hasDetail = "detail" in lastBody.messages[0].content.find((c) => c.type === "image_url").image_url;
console.log("sendDetail=false omits detail:", hasDetail ? "FAIL" : "PASS");

// 4) anthropic format: local file -> base64 source
apply(ctx, cfg({ imageFormat: "anthropic" }));
await tool().execute({ image: imgPath, prompt: "p" }, { signal });
const imgBlock = lastBody.messages[0].content.find((c) => c.type === "image");
const src = imgBlock && imgBlock.source;
console.log("anthropic local -> base64 source:", src && src.type === "base64" && src.media_type === "image/png" && src.data ? "PASS" : "FAIL (" + JSON.stringify(src) + ")");

// 5) anthropic format: remote URL -> fetched + base64 source (never url source)
await tool().execute({ image: "https://x.test/a.png", prompt: "p" }, { signal });
const imgBlock2 = lastBody.messages[0].content.find((c) => c.type === "image");
const src2 = imgBlock2 && imgBlock2.source;
console.log("anthropic remote -> base64 source (no url):", src2 && src2.type === "base64" && src2.data && src2.data.includes(FAKE_PNG_B64) ? "PASS" : "FAIL (" + JSON.stringify(src2) + ")");
