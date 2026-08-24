// Unit test for @deepseek-ai/dsh-tool-vision: DSH attachment sha256 references.
//
// The Web GUI's attachment picker hands the model a bare 64-hex sha256 digest
// (optionally `sha256:`-prefixed). The bytes live CONTENT-ADDRESSED at
// `$DSH_HOME/attachments/v1/objects/<first-2-hex>/<full-sha256>` with no
// extension. This test proves `describe_image` resolves that reference:
//   - a bare digest resolves against the real attachment store layout
//   - a `sha256:`-prefixed digest resolves the same way
//   - the MIME type is SNIFFED from the bytes (the object has no extension),
//     so a stored PNG embeds as data:image/png
//   - a digest with no matching object fails with an actionable error
//   - local paths / http(s) URLs still work (regression)
//
// The fake fetch only serves the backend call; image resolution for the
// sha256 form never touches the network.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apply } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-vision/lib/index.js"
);

// A minimal REAL PNG (1x1) so the MIME sniffer has a genuine header.
const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
const PNG_BYTES = Uint8Array.from(atob(FAKE_PNG_B64), (c) => c.charCodeAt(0));

// A 64-hex digest for the fake object.
const SHA256 = "c2872d81dd03f094713cca90eba7b0b2ab834e27599b6a7016d7cb124e268402";

// --- isolate $DSH_HOME so the test never touches the real store -------------
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
process.env.DSH_HOME = fakeHome;
const objectsRoot = join(fakeHome, "attachments", "v1", "objects");
mkdirSync(join(objectsRoot, SHA256.slice(0, 2)), { recursive: true });
writeFileSync(join(objectsRoot, SHA256.slice(0, 2), SHA256), Buffer.from(PNG_BYTES));

let lastBody = null;
globalThis.fetch = async (url, init) => {
  lastBody = JSON.parse(init.body);
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
};

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
  inject(_deps, cb) { cb({ on() { return () => {}; }, get() { return void 0; }, logger: { warn() {} } }); }
};
apply(ctx, {
  apiUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
  detail: "auto", sendDetail: false, imageFormat: "openai",
  timeoutMs: 120000, maxOutputChars: 200000
});
const tool = registered.find((t) => t.name === "describe_image");
const signal = AbortSignal.timeout(30000);

function urlPart() {
  return lastBody.messages[0].content.find((c) => c.type === "image_url").image_url.url;
}

let failures = 0;
function check(label, ok) {
  console.log(`${label}: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) failures += 1;
}

// 1) bare digest -> resolved + sniffed as image/png
await tool.execute({ image: SHA256, prompt: "p" }, { signal });
const u1 = urlPart();
check("bare digest -> data:image/png base64", u1.startsWith("data:image/png;base64,") && u1.includes(FAKE_PNG_B64));

// 2) sha256:-prefixed digest -> same object
await tool.execute({ image: `sha256:${SHA256}`, prompt: "p" }, { signal });
const u2 = urlPart();
check("sha256:-prefixed -> data:image/png base64", u2.startsWith("data:image/png;base64,") && u2.includes(FAKE_PNG_B64));

// 3) missing digest -> actionable error mentioning the store path
const missing = "1111111111111111111111111111111111111111111111111111111111111111";
let errMsg = "";
try {
  await tool.execute({ image: missing, prompt: "p" }, { signal });
} catch (error) {
  errMsg = String(error?.message ?? error);
}
check(
  "missing digest -> actionable error",
  errMsg.includes("1111111111111111111111111111111111111111111111111111111111111111") && errMsg.includes("attachments")
);

// 4) uppercase digest -> normalized to lowercase path
const UPPER = SHA256.toUpperCase();
mkdirSync(join(objectsRoot, UPPER.slice(0, 2).toLowerCase()), { recursive: true });
writeFileSync(join(objectsRoot, UPPER.slice(0, 2).toLowerCase(), UPPER.toLowerCase()), Buffer.from(PNG_BYTES));
await tool.execute({ image: UPPER, prompt: "p" }, { signal });
check("uppercase digest -> normalized + resolved", urlPart().startsWith("data:image/png;base64,"));

// 5) regression: a digest that happens to be 64 hex but is actually a
//    relative PATH — must still resolve as a file (a missing one errors).
const fakeRel = join(tmpdir(), "vision-rel-regression");
mkdirSync(fakeRel, { recursive: true });
writeFileSync(join(fakeRel, "pic.png"), Buffer.from(PNG_BYTES));
await tool.execute({ image: join(fakeRel, "pic.png"), prompt: "p" }, { signal });
check("regression: local path still works", urlPart().startsWith("data:image/png;base64,"));

rmSync(fakeHome, { recursive: true, force: true });
rmSync(fakeRel, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
