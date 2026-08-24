// @deepseek-ai/dsh-tool-vision
//
// Standalone vision tool plugin for a NON-vision (text-only) model.
//
// IMAGE REFERENCES
// ----------------
// `describe_image` accepts three forms for its `image` argument:
//   - http(s) URL                 -> fetched, then base64-embedded
//   - local file path             -> read,   then base64-embedded
//   - DSH attachment sha256 ref   -> resolved against the local attachment
//                                    store, then base64-embedded
//
// The sha256 form is a bare 64-hex digest (optionally `sha256:`-prefixed),
// e.g. `c2872d81dd03f094713cca90eba7b0b2ab834e27599b6a7016d7cb124e268402`.
// That is the reference the Web GUI hands to the model when the user drops an
// image onto the chat: the file is stored CONTENT-ADDRESSED at
// `$DSH_HOME/attachments/v1/objects/<first-2-hex>/<full-sha256>` with no
// extension (the bytes themselves are a PNG/JPEG/WebP/GIF). The model can
// therefore pass the digest straight to this tool and the plugin maps it to
// the stored object, reads the bytes, sniffs the real MIME from the file
// header, and embeds the image as a base64 data: URI — exactly as if the user
// had pasted a normal file path.
//
// THE TECHNIQUE
// -------------
// A plain language model has no way to read pixels. This plugin gives it sight
// WITHOUT changing the model: you route the image to a real multimodal model
// (the "vision backend") and feed THAT model's text output back into the
// non-vision model's context as ordinary text.
//
//   user image ──▶ vision backend (real multimodal LLM) ──▶ text
//                                                        │
//                                                        ▼
//                      non-vision model reads the text as if it had seen the image
//
// The non-vision model never receives pixels — only a faithful language
// description, OCR transcript, or a direct answer to a visual question. This is
// exactly how projects attach "eyes" to text-only models: the heavy lifting is
// delegated to an OpenAI-compatible /v1/chat/completions call that accepts an
// `image_url` content part.
//
// This plugin registers a single model-facing tool, `describe_image`, that
// takes an image (URL or local path) + a prompt and returns the backend's text
// answer. The model using this tool is therefore able to "see" by proxy.
//
// CAPABILITY GATING
// -----------------
// `describe_image` is only useful when the routed model CANNOT read pixels
// itself, while the harness's own `read_image` tool is only useful when it
// CAN. This plugin therefore inspects the routed model's declared input
// modalities (ctx.llm.resolveModelInfo(...).inputModalities) at prompt-assembly
// time and masks the FINAL tool schemas the loop sends to the model:
//   - vision model    (declares "image") -> hides `describe_image`, keeps `read_image`
//   - text-only model (no "image")       -> hides `read_image`, keeps `describe_image`
//   - unknown/undeclared (no modality info) -> hides `read_image`, keeps `describe_image`
// `read_image` survives only on a POSITIVE "image" declaration. The mask is
// re-evaluated on every assembly, so a mid-session model switch is reflected
// on the next step. `read_image` additionally self-gates at execution
// (dsh-tool-fs), so a non-vision model can never read pixels even if it
// guesses the hidden tool's name.
//
// Verified backend contract (OpenAI-compatible vision chat completions):
//   POST {apiUrl}/chat/completions
//   body: { model, messages: [ { role: "user", content: [
//             { type: "text", text: <prompt> },
//             { type: "image_url", image_url: { url: <url|data:>, detail: <low|high|auto> } }
//           ] } ] }
//   response: { choices: [ { message: { content: <text> } } ] }
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-vision";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 120000;

/** Default OpenAI-compatible chat completions path. */
const DEFAULT_API_URL = "https://api.openai.com/v1";

/** Default vision model (override per backend). gpt-4o is a safe default. */
const DEFAULT_MODEL = "gpt-4o";

/** Vision detail presets accepted by the backend. */
const DETAIL_LEVELS = ["auto", "low", "high"];

/** Prompt-section name carrying the `describe_image` guidance (removed for vision models). */
const VISION_SECTION = "tool:vision";

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default(DEFAULT_API_URL),
  apiKey: z.string().default(""),
  model: z.string().default(DEFAULT_MODEL),
  // schemastery has no .enum(); allowed values are validated at apply() time.
  detail: z.string().default("auto"),
  // Some OpenAI-compatible proxies (e.g. newapi/CodeBuddy) reject the `detail`
  // sub-field inside `image_url` (HTTP 400). Default false to match the bare
  // image_url form that works there; enable for backends that use it.
  sendDetail: z.boolean().default(false),
  // Multimodal request shape. "openai" uses content parts with an image_url
  // block; "anthropic" uses a content block of type "image" whose `source`
  // carries base64 media_type+data or a url (the Claude-style schema).
  imageFormat: z.string().default("openai"),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-vision: ${label} must be a positive integer`);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  return String(config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
}

function makeHeaders(config) {
  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/** Is `value` an http(s) URL we can hand straight to the backend? */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// ---------------------------------------------------------------------------
// DSH attachment sha256 references
// ---------------------------------------------------------------------------

/** Matches a bare 64-hex sha256 digest, optionally `sha256:`-prefixed. */
const SHA256_REF_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i;

/** Default DSH home when `$DSH_HOME` is not set (`~/.dsh`). */
function defaultDshHome() {
  return join(homedir(), ".dsh");
}

/** Resolve the DSH home: `$DSH_HOME` wins, otherwise `~/.dsh`. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : defaultDshHome();
}

/**
 * Content-addressed attachment object path for one sha256 digest:
 * `$DSH_HOME/attachments/v1/objects/<first-2-hex>/<full-sha256>`.
 * Mirrors the layout of the dsh-attachment-local store.
 */
function attachmentObjectPath(sha256) {
  return join(dshHome(), "attachments", "v1", "objects", sha256.slice(0, 2), sha256);
}

/**
 * Is `value` a DSH attachment sha256 reference (bare digest or
 * `sha256:`-prefixed)? These are the references the Web GUI's attachment
 * picker hands to the model.
 */
function isSha256Reference(value) {
  const match = SHA256_REF_PATTERN.exec(String(value || "").trim());
  return match !== null;
}

// ---------------------------------------------------------------------------
// MIME sniffing
// ---------------------------------------------------------------------------

/**
 * Sniff the MIME type of image bytes from their magic number, so files
 * WITHOUT an extension (like content-addressed attachment objects) still
 * embed with the correct `data:` URI media type. Falls back to a supplied
 * default (or png) when the header is not recognized.
 */
function sniffImageMime(buffer, fallback = "image/png") {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x49 && buffer[1] === 0x49 &&
    buffer[2] === 0x2a && buffer[3] === 0x00
  ) {
    return "image/tiff";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x4d && buffer[1] === 0x4d &&
    buffer[2] === 0x00 && buffer[3] === 0x2a
  ) {
    return "image/tiff";
  }
  if (buffer.length >= 12 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x00 && buffer[3] === 0x1c) {
    return "image/avif";
  }
  return fallback;
}

/** Guess an image MIME type from extension (defaulting to png). */

/** Guess an image MIME type from extension (defaulting to png). */
function inferImageMime(filename) {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".tiff": "image/tiff",
    ".tif": "image/tiff"
  };
  return map[ext] || "image/png";
}

/**
 * Resolve an image reference into a normalized descriptor the backend expects.
 * Every form is emitted as BASE64 so the backend never has to fetch a remote
 * URL itself — some OpenAI-compatible proxies (e.g. newapi/CodeBuddy) reject
 * remote http(s) image URLs but accept embedded data: URIs.
 *   - http(s) URL             -> fetched, then { kind: "base64", value, mime }
 *   - local path              -> read,    then { kind: "base64", value, mime }
 *   - DSH attachment sha256   -> read from the local attachment store, then
 *                                { kind: "base64", value, mime } (MIME sniffed
 *                                from the bytes; the object has no extension)
 */
async function resolveImage(config, image, signal) {
  const trimmed = String(image || "").trim();
  if (isHttpUrl(trimmed)) {
    const res = await fetch(trimmed, { method: "GET", signal });
    if (!res.ok) {
      throw new Error(`tool-vision: failed to download image ${trimmed} (HTTP ${res.status})`);
    }
    const buffer = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || sniffImageMime(buffer, "image/png");
    return { kind: "base64", value: Buffer.from(buffer).toString("base64"), mime };
  }

  // DSH attachment sha256 reference (bare digest or `sha256:`-prefixed).
  const shaMatch = SHA256_REF_PATTERN.exec(trimmed);
  if (shaMatch !== null) {
    const sha256 = shaMatch[1].toLowerCase();
    const objectPath = attachmentObjectPath(sha256);
    let buffer;
    try {
      buffer = await readFile(objectPath);
    } catch (error) {
      const code = error?.code ?? "";
      const hint =
        code === "ENOENT"
          ? `no attachment object at ${objectPath} — the digest may not belong to this machine's attachment store`
          : String(error?.message ?? error);
      throw new Error(`tool-vision: could not read DSH attachment ${sha256}: ${hint}`);
    }
    const mime = sniffImageMime(buffer);
    return { kind: "base64", value: buffer.toString("base64"), mime };
  }

  const abs = resolvePath(trimmed);
  const buffer = await readFile(abs);
  const mime = inferImageMime(abs);
  const b64 = buffer.toString("base64");
  return { kind: "base64", value: b64, mime };
}

async function visionComplete(config, image, prompt, signal) {
  const img = await resolveImage(config, image, signal);

  let requestContent;
  if (config.imageFormat === "anthropic") {
    // Claude-style: content blocks; image block carries a `source` object.
    let source;
    if (img.kind === "url") {
      source = { type: "url", url: img.value };
    } else {
      source = { type: "base64", media_type: img.mime, data: img.value };
    }
    requestContent = [
      { type: "text", text: prompt },
      { type: "image", source }
    ];
  } else {
    // OpenAI-style: content parts with an image_url block.
    const imagePart = { url: img.kind === "url" ? img.value : `data:${img.mime};base64,${img.value}` };
    if (config.sendDetail) imagePart.detail = config.detail;
    requestContent = [
      { type: "text", text: prompt },
      { type: "image_url", image_url: imagePart }
    ];
  }

  const body = {
    model: config.model,
    messages: [
      { role: "user", content: requestContent }
    ]
  };
  const res = await fetch(baseUrl(config) + "/chat/completions", {
    method: "POST",
    headers: makeHeaders(config),
    body: JSON.stringify(body),
    signal
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null
        ? data.error?.message || data.message || text
        : text;
    const msg = String(detail);
    // The backend proxy understood the request shape but rejected it — most
    // commonly because this model/route has no vision (image_url) path. Give
    // the model actionable guidance instead of a raw 400.
    const looksLikeVisionRejection =
      /invalid[ _]parameter|invalid_request_error|does not support|unsupported|image/i.test(msg);
    if (res.status === 400 && looksLikeVisionRejection) {
      throw new Error(
        `tool-vision: the backend at ${baseUrl(config)} rejected the image input ` +
        `(HTTP 400) — this model/route does not appear to accept vision (image_url) requests. ` +
        `Use a model that supports vision (e.g. gpt-4o, a local llava/minicpm-v, or OpenRouter), ` +
        `or try sendDetail: false. Backend said: ${msg.slice(0, 400)}`
      );
    }
    throw new Error(`tool-vision POST /chat/completions failed (HTTP ${res.status}): ${msg.slice(0, 500)}`);
  }
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    null;
  if (content == null) {
    throw new Error(`tool-vision: backend returned no content. Response: ${String(text).slice(0, 500)}`);
  }
  return String(content);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

function applyDescribeImageTool(ctx, config) {
  ctx.systemPrompt.section({
    name: VISION_SECTION,
    order: 119,
    text:
      "Use the describe_image tool to let this text-only model 'see' an image. Pass an image URL, a local file path, or a DSH attachment sha256 reference (a bare 64-hex digest such as c2872d81dd03f094713cca90eba7b0b2ab834e27599b6a7016d7cb124e268402 — the form the attachment picker hands to the model) plus a question or description instruction. " +
      "The tool routes the image to a vision-capable backend and returns its text answer, which you should treat as if you had looked at the image yourself. " +
      "Use it whenever the user references an image, screenshot, diagram, chart, or any visual content. Ask specific questions (e.g. 'What text is in this screenshot?', 'Describe this UI layout') for best results."
  });
  ctx.tools.register(defineTool({
    name: "describe_image",
    description:
      "Give this text-only model vision by routing an image to a multimodal backend and returning its text answer. Accepts an image URL, a local file path, or a DSH attachment sha256 reference (bare 64-hex digest, e.g. c2872d81dd03f094713cca90eba7b0b2ab834e27599b6a7016d7cb124e268402 — read and embedded automatically) plus a prompt describing what to extract. Use it to read screenshots, diagrams, charts, OCR document text, or answer visual questions. This is the model's 'eyes'.",
    parameters: {
      image: { type: "string", required: true, description: "Image URL (http/https), a local file path, or a DSH attachment sha256 reference (64-hex digest) to read and embed." },
      prompt: { type: "string", required: true, description: "What to ask about the image, e.g. 'Transcribe all text', 'Describe this diagram', 'What color is the button?'." },
      detail: { type: "string", enum: DETAIL_LEVELS, description: "Vision detail level: 'low' (cheaper, faster), 'high' (more tokens, finer detail), or 'auto' (backend default)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const detail = args.detail || config.detail;
      const answer = await visionComplete(
        { ...config, detail },
        args.image,
        args.prompt,
        exec.signal
      );
      return truncate(answer, config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.image, kind: "vision", rawInput: args.prompt })
  }));
}

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

/** The harness's own image tool, hidden unless the routed model is confirmed vision-capable. */
const NATIVE_IMAGE_TOOL = "read_image";

/**
 * Resolve the routed model's image capability for one prompt assembly.
 *   - `true`      -> the model declares "image" input
 *   - `false`     -> the model does NOT declare "image", OR the adapter
 *                    declined to declare modalities, OR resolution failed
 *   - `undefined` -> no routed model to resolve (a bare/diagnostic assembly
 *                    with no agent/provider/model): the catalog is left alone
 *
 * Only a POSITIVE "image" declaration keeps `read_image` visible; every other
 * outcome hides it and keeps `describe_image`.
 */
async function resolveModelHasImage(ctx, context) {
  const agent = context.agent;
  const llm = ctx.get("llm");
  if (llm === void 0) return void 0;
  const header = agent?.session?.requestHeader?.();
  const provider = header?.config?.provider ?? agent?.options?.provider;
  const model = header?.config?.model ?? agent?.options?.model;
  if (typeof provider !== "string" || typeof model !== "string") return void 0;
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, context.signal);
  } catch (error) {
    ctx.logger?.warn?.(`tool-vision: could not resolve image capability for model "${model}"; treating it as non-vision and hiding read_image: ${error?.message ?? String(error)}`);
    return false;
  }
  if (info.inputModalities === void 0) return false;
  return info.inputModalities.includes("image");
}

/**
 * Mask one assembly's tool schemas to the routed model's capability:
 *   - vision model (`hasImage === true`) -> remove `describe_image`
 *   - anything else (text-only, unknown, undeclared) -> remove `read_image`
 */
function maskToolSchemas(schemas, hasImage) {
  const deny = hasImage === true ? "describe_image" : NATIVE_IMAGE_TOOL;
  return schemas.filter((schema) => schema.name !== deny);
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);
  if (!DETAIL_LEVELS.includes(config.detail)) {
    throw new Error(`tool-vision: detail must be one of ${DETAIL_LEVELS.join(", ")}`);
  }
  const FORMATS = ["openai", "anthropic"];
  if (!FORMATS.includes(config.imageFormat)) {
    throw new Error(`tool-vision: imageFormat must be one of ${FORMATS.join(", ")}`);
  }
  applyDescribeImageTool(ctx, config);
  ctx.inject(["llm"], (llmCtx) => {
    // Prompt-assembly capability mask. Runs around the `system-prompt/assemble`
    // waterfall so the FINAL tool schemas the loop sends to the model are
    // masked: a vision model loses `describe_image` (and its guidance
    // section), a text-only model loses `read_image`. Re-evaluated every step,
    // so a mid-session model switch is reflected on the next assembly.
    llmCtx.on("system-prompt/assemble", async (assembly, context, next) => {
      const hasImage = await resolveModelHasImage(llmCtx, context);
      const assembled = await next();
      if (hasImage === undefined) return assembled;
      return {
        ...assembled,
        tools: maskToolSchemas(assembled.tools, hasImage),
        sections: hasImage === true
          ? assembled.sections.filter((section) => section.name !== VISION_SECTION)
          : assembled.sections
      };
    });
  });
}

export { Config, DEFAULT_TIMEOUT_MS, apply, inject, name };
