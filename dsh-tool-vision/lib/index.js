// @deepseek-ai/dsh-tool-vision
//
// Standalone vision tool plugin for a NON-vision (text-only) model.
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
// Verified backend contract (OpenAI-compatible vision chat completions):
//   POST {apiUrl}/chat/completions
//   body: { model, messages: [ { role: "user", content: [
//             { type: "text", text: <prompt> },
//             { type: "image_url", image_url: { url: <url|data:>, detail: <low|high|auto> } }
//           ] } ] }
//   response: { choices: [ { message: { content: <text> } } ] }
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

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

/**
 * Resolve an image reference into a normalized descriptor the backend expects.
 * Both forms are emitted as BASE64 so the backend never has to fetch a remote
 * URL itself — some OpenAI-compatible proxies (e.g. newapi/CodeBuddy) reject
 * remote http(s) image URLs but accept embedded data: URIs.
 *   - http(s) URL -> fetched, then { kind: "base64", value, mime }
 *   - local path  -> read,      then { kind: "base64", value, mime }
 */
async function resolveImage(config, image, signal) {
  if (isHttpUrl(image)) {
    const res = await fetch(image.trim(), { method: "GET", signal });
    if (!res.ok) {
      throw new Error(`tool-vision: failed to download image ${image.trim()} (HTTP ${res.status})`);
    }
    const buffer = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    return { kind: "base64", value: Buffer.from(buffer).toString("base64"), mime };
  }
  const abs = resolvePath(image);
  const buffer = await readFile(abs);
  const mime = inferImageMime(abs);
  const b64 = buffer.toString("base64");
  return { kind: "base64", value: b64, mime };
}

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
    name: "tool:vision",
    order: 119,
    text:
      "Use the describe_image tool to let this text-only model 'see' an image. Pass an image URL or a local file path plus a question or description instruction. " +
      "The tool routes the image to a vision-capable backend and returns its text answer, which you should treat as if you had looked at the image yourself. " +
      "Use it whenever the user references an image, screenshot, diagram, chart, or any visual content. Ask specific questions (e.g. 'What text is in this screenshot?', 'Describe this UI layout') for best results."
  });
  ctx.tools.register(defineTool({
    name: "describe_image",
    description:
      "Give this text-only model vision by routing an image to a multimodal backend and returning its text answer. Accepts an image URL or a local file path (read and embedded automatically) plus a prompt describing what to extract. Use it to read screenshots, diagrams, charts, OCR document text, or answer visual questions. This is the model's 'eyes'.",
    parameters: {
      image: { type: "string", required: true, description: "Image URL (http/https) or a local file path to read and embed." },
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
}

export { Config, DEFAULT_TIMEOUT_MS, apply, inject, name };
