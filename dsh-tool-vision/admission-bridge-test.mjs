// Unit test for @deepseek-ai/dsh-tool-vision: admission bridge + digest prefixes.
//
// Covers the two behaviors added so a text-only model can accept attached
// images instead of the host rejecting the prompt with "当前模型不支持图片":
//   1. ADMISSION BRIDGE — wraps the llm runtime's PUBLIC resolveModelInfo so a
//      text-only model reports `image`, letting the api-proxy prompt gate admit
//      image attachments. Internal dispatch is untouched (it uses the private
//      resolveModelInfoFor path), so dsh-llm still projects attached images
//      into `[image omitted … attachment sha256:<8-hex>]` placeholders.
//   2. DIGEST PREFIX RESOLUTION — describe_image accepts an 8+ hex-character
//      digest prefix (exactly what those placeholders leave behind) and maps it
//      back to the full content-addressed attachment object.
//   Also: bridgeAttachments=false leaves the runtime untouched; installing
//   twice never double-wraps; ambiguity/missing prefixes fail with actionable
//   errors.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
const PNG_BYTES = Uint8Array.from(atob(FAKE_PNG_B64), (c) => c.charCodeAt(0));

const SHA_A = "c2872d81dd03f094713cca90eba7b0b2ab834e27599b6a7016d7cb124e268402";
const SHA_B = "c2872d81" + "f".repeat(56); // exactly 64 chars; shares the 8-hex prefix with SHA_A -> ambiguity probe
const SHA_OTHER = "deadbeef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c";

let failures = 0;
function check(label, ok) {
  console.log(`${label}: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Part 1: digest prefix resolution (isolated $DSH_HOME)
// ---------------------------------------------------------------------------
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-home-bridge-"));
process.env.DSH_HOME = fakeHome;
const objectsRoot = join(fakeHome, "attachments", "v1", "objects");
for (const digest of [SHA_A, SHA_OTHER]) {
  mkdirSync(join(objectsRoot, digest.slice(0, 2)), { recursive: true });
  writeFileSync(join(objectsRoot, digest.slice(0, 2), digest), Buffer.from(PNG_BYTES));
}

let lastBody = null;
globalThis.fetch = async (_url, init) => {
  lastBody = JSON.parse(init.body);
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
};

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
  // Fake llm SERVICE + CONTEXT, mimicking real cordis semantics: the inject
  // callback receives a CONTEXT (with on/get/logger), and the actual runtime
  // (whose public resolveModelInfo reports TEXT ONLY, like the deepseek
  // adapter does for non-vision models) sits behind context.get("llm").
  llmServices: null,
  inject(_deps, cb) {
    const service = {
      calls: 0,
      async resolveModelInfo(provider, model) {
        this.calls += 1;
        return { provider, id: model, name: model, inputModalities: ["text"] };
      }
    };
    const contextLike = {
      on() { return () => {}; },
      get(name) { return name === "llm" ? service : void 0; },
      logger: { warn() {}, info() {} }
    };
    this.llmServices = service;
    cb(contextLike);
  }
};
apply(ctx, {
  apiUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
  detail: "auto", sendDetail: false, imageFormat: "openai",
  timeoutMs: 120000, maxOutputChars: 200000,
  bridgeAttachments: true
});
const tool = registered.find((t) => t.name === "describe_image");
const signal = AbortSignal.timeout(30000);
const llm = ctx.llmServices;

function urlPart() {
  return lastBody.messages[0].content.find((c) => c.type === "image_url").image_url.url;
}

// 1) The bridge patched the PUBLIC method: a text-only model now admits images.
{
  const info = await llm.resolveModelInfo("deepseek-official", "deepseek-v4-flash");
  check("bridge: text-only model now declares image", Array.isArray(info.inputModalities) && info.inputModalities.includes("image") && info.inputModalities.includes("text"));
}

// 2) Idempotent install: applying again must not double-wrap.
apply(ctx, {
  apiUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
  detail: "auto", sendDetail: false, imageFormat: "openai",
  timeoutMs: 120000, maxOutputChars: 200000,
  bridgeAttachments: true
});
{
  const before = llm.calls;
  await llm.resolveModelInfo("p", "m");
  check("bridge: no double wrap (one inner call)", llm.calls - before === 1);
}

// 3) 8-hex PREFIX of a stored object -> resolves to the full object.
await tool.execute({ image: SHA_A.slice(0, 8), prompt: "p" }, { signal });
check("8-hex prefix -> full object resolved + sniffed png", urlPart().startsWith("data:image/png;base64,") && urlPart().includes(FAKE_PNG_B64));

// 4) sha256:-prefixed short form works too.
await tool.execute({ image: `sha256:${SHA_OTHER.slice(0, 10)}`, prompt: "p" }, { signal });
check("sha256:-prefixed 10-hex prefix -> resolved", urlPart().includes(FAKE_PNG_B64));

// 5) Missing prefix -> actionable error.
let err1 = "";
try { await tool.execute({ image: "12345678", prompt: "p" }, { signal }); } catch (e) { err1 = String(e?.message ?? e); }
check("missing prefix -> actionable error", err1.includes("no DSH attachment matches") && err1.includes("12345678"));

// 6) Ambiguous prefix -> actionable error naming both matches.
mkdirSync(join(objectsRoot, SHA_B.slice(0, 2)), { recursive: true });
writeFileSync(join(objectsRoot, SHA_B.slice(0, 2), SHA_B), Buffer.from(PNG_BYTES));
let err2 = "";
try { await tool.execute({ image: SHA_A.slice(0, 8), prompt: "p" }, { signal }); } catch (e) { err2 = String(e?.message ?? e); }
check("ambiguous prefix -> asks for more characters", err2.includes("ambiguous") && err2.includes("more hex"));

rmSync(fakeHome, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Part 2: bridgeAttachments=false leaves the runtime untouched
// ---------------------------------------------------------------------------
const plainLlm = {
  async resolveModelInfo(provider, model) {
    return { provider, id: model, name: model, inputModalities: ["text"] };
  }
};
const plainCtx = {
  tools: { register() { return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
  inject(_deps, cb) {
    cb({ on() { return () => {}; }, get() { return plainLlm; }, logger: { warn() {} } });
  }
};
apply(plainCtx, {
  apiUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
  detail: "auto", sendDetail: false, imageFormat: "openai",
  timeoutMs: 120000, maxOutputChars: 200000,
  bridgeAttachments: false
});
{
  const info = await plainLlm.resolveModelInfo("p", "m");
  check("bridgeAttachments=false -> modalities untouched", info.inputModalities.length === 1 && info.inputModalities[0] === "text");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
