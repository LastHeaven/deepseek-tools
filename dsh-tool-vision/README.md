# dsh-tool-vision

A standalone **vision tool plugin** for a non-vision (text-only) model, packaged
as a native DSH Cordis tool plugin. It gives a sightless model "eyes" by routing
an image through a multimodal model and feeding the result back as text.

## How a text-only model "sees"

A plain language model receives only tokens; it cannot read pixels. The trick is
to **not** give it pixels at all. Instead:

```
user image ──▶ vision backend (real multimodal LLM) ──▶ text
                                                       │
                                                       ▼
                 non-vision model reads the text as if it had seen the image
```

1. The image (URL or local file) is sent to a **vision-capable backend** — a
   real multimodal model behind an OpenAI-compatible `/v1/chat/completions`
   endpoint that accepts an `image_url` content part.
2. That backend returns a **text** answer: a caption, an OCR transcript, or a
   direct reply to a visual question.
3. The text is injected into the non-vision model's context as ordinary text.
   The text-only model now "sees by proxy" — it never touches the pixels, but
   it reasons over a faithful language description of them.

This plugin is the bridge. It registers one model-facing tool, `describe_image`,
and performs steps 1–2 on the model's behalf.

## Tools

| Tool | Purpose |
| --- | --- |
| `describe_image` | Give the text-only model vision. Takes an `image` (URL or local path) and a `prompt` (what to extract), returns the backend's text answer. |

## Backend

OpenAI-compatible vision chat completions. Any of these work by setting `apiUrl`
+ `apiKey` + `model`:

- OpenAI `gpt-4o` (`https://api.openai.com/v1`)
- SiliconFlow / OpenRouter / Azure OpenAI
- A local vLLM or llama.cpp server exposing `llava` / `minicpm-v` etc. behind
  `/v1/chat/completions`

Local image paths are read from the agent host and embedded as base64 `data:`
URIs, so the backend does not need filesystem access to your machine.

## Configuration (`cordis.patch.yml`)

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible vision endpoint. |
| `apiKey` | `""` | Bearer token; omit for keyless local servers. |
| `model` | `gpt-4o` | Vision model name on the backend. |
| `detail` | `auto` | `low` / `high` / `auto` vision detail. |
| `sendDetail` | `false` | Send the `detail` sub-field inside `image_url`. Some OpenAI-compatible proxies (e.g. newapi/CodeBuddy) reject it with HTTP 400 — default off to match the bare `image_url` form that works there. Enable for backends that use it. |
| `imageFormat` | `openai` | Multimodal request shape. `openai` emits an `image_url` content block; `anthropic` emits an `image` content block whose `source` carries `base64` (`media_type`+`data`) for local files or `url` for URLs (the Claude-style schema). |
| `timeoutMs` | `120000` | Cooperative tool-call budget. |
| `maxOutputChars` | `200000` | Cap on returned text. |

### Request body shapes

**`imageFormat: "openai"`** (default):

```json
{
  "model": "<model>",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "<prompt>" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,<base64>" } }
  ] }]
}
```

Note: every image — whether given as a local path or a remote `http(s)` URL —
is embedded as a `data:` URI (the plugin fetches remote URLs first). The
`detail` sub-field is sent only when `sendDetail: true` (default `false`,
because newapi/CodeBuddy rejects it).

**`imageFormat: "anthropic"`** — the images/source schema you described:

```json
{
  "model": "<model>",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "<prompt>" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "<base64>" } }
    // or for a URL: { "type": "image", "source": { "type": "url", "url": "<url>" } }
  ] }]
}
```

Local image paths are read and base64-encoded, then placed in `source.data`
(with the detected `media_type`); URL images use `source.type: "url"`.

## Install (copy into profile node_modules)

```powershell
$src = "D:\git\deepseek-tools\dsh-tool-vision"
$dst = "$env:DSH_HOME\profiles\web\node_modules\@deepseek-ai\dsh-tool-vision"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
```

## Wire (`cordis.patch.yml`)

```yaml
- insert:
    - id: tool-vision
      name: '@deepseek-ai/dsh-tool-vision'
      config:
        apiUrl: https://api.openai.com/v1
        apiKey: <your-key>
        model: gpt-4o
```

## Verify

```powershell
node "D:\git\deepseek-tools\dsh-tool-vision\smoke-test.mjs"
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
```

## Backend caveats

The vision bridge only works if the **backend model actually accepts vision
input** (`image_url` content parts). Not every OpenAI-compatible endpoint does:

- **newapi (`minimax-m3`) — WORKS**, with two required adjustments that the
  plugin now applies automatically: (1) the proxy **rejects remote `http(s)`
  image URLs**, so the plugin fetches any URL and embeds it as a base64 `data:`
  URI (local files are embedded the same way); (2) the proxy **rejects the
  `detail` sub-field**, so `sendDetail` defaults to `false`. With these, a
  `describe_image` call against `http://newapi.localhost/v1` + `minimax-m3`
  succeeds end-to-end.
- Some other OpenAI-compatible proxies have no vision path at all and will 400
  any `image_url` input. When that happens, the tool raises a clear, actionable
  error telling the model to use a vision-capable model (e.g. `gpt-4o`, a local
  `llava`/`minicpm-v`, or an OpenRouter multimodal model).

Always verify with a `describe_image` call (or a raw `/v1/chat/completions`
probe containing an `image_url` part) that your chosen model sees images before
relying on it.
