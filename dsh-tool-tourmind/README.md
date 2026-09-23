# @deepseek-ai/dsh-tool-tourmind

Model-facing **TourMind hotel booking** tools for DSH, over the TourMind Skill
REST API (`https://api.tourmind.com`).

A native Cordis Host plugin: it registers tools into `ctx.tools` and calls the
HTTP API with the Node built-in `fetch`. No MCP child process, no `mcp__`
prefix, no third-party npm dependency.

This plugin is the tool half of the `tourmind-booking` agent preset; the
travel-domain business rules live in that preset's `tourmind-booking` skill.

---

## Tools

| Tool | Purpose |
| --- | --- |
| `tourmind_account` | Credential status, save, clear, and sign-in guidance. **Start here.** |
| `tourmind_check_update` | Compare the pinned skill version against the service. |
| `tourmind_search_location` | Resolve a city/POI/hotel phrase to regions, hotels and a Google place. |
| `tourmind_search_hotels` | Candidate hotel pool for a stay (region, nearby, or keyword mode). |
| `tourmind_hotel_detail` | One hotel's static detail: address, star, images, facilities, fees. |
| `tourmind_room_rates` | Live room products and rates for one hotel. |
| `tourmind_batch_room_rates` | The same for up to 20 hotels in one request. |
| `tourmind_check_availability` | Confirm one `rate_code` is still bookable; returns the final price. |
| `tourmind_create_booking` | Create an order → `agent_ref_id`. |
| `tourmind_query_booking` | Read one order by `agent_ref_id`. |
| `tourmind_cancel_booking` | Cancel one order by `agent_ref_id`. |
| `tourmind_pay_order` | Obtain the payment URL (`Stripe` / `微信支付` / `支付宝`). |

### `tourmind_account`

```jsonc
{ "action": "status" }                  // which channel a stored token selects
{ "action": "save", "token": "sk_..." } // validate + store; never echoed back
{ "action": "clear" }                   // remove the stored credential
{ "action": "guidance" }                // personal + business sign-in instructions
```

`status` reports only a masked prefix (`sk_***`), never the token value.

## Channels and credentials

Two channels, selected by the stored credential:

| Credential | Channel | Path prefix | Credential field |
| --- | --- | --- | --- |
| absent / empty | public personal (ToC) | `/skill/toc/` | none on read endpoints |
| `uk_...` | personal (ToC) | `/skill/toc/` | `user_key` on order operations only |
| `sk_...` | business (ToB) | `/skill/tob/` | `token` on every request |
| anything else | none | — | rejected before any request |

`token` and `user_key` are never mixed in one request. A personal credential is
never sent to a business endpoint or vice versa, and `check_skill_update` on
ToC sends only `current_version` even when a `uk_` token is stored.

The credential lives in one file, `config.tokenFile`, defaulting to
`$HOME/.dsh/tourmind-skill-token.txt`. Order operations
(`create`/`query`/`cancel`/`pay`) require a stored credential and report a clear
error when none is present; read-only lookups work without one.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://api.tourmind.com` | API base URL. |
| `tokenFile` | `""` | Credential file; empty means `$HOME/.dsh/tourmind-skill-token.txt`. |
| `skillVersion` | `1.0.8` | `current_version` sent to `check_skill_update`. |
| per-tool booleans | `true` | `account`, `checkUpdate`, `searchLocation`, `searchHotels`, `hotelDetail`, `roomRates`, `batchRoomRates`, `checkAvailability`, `createBooking`, `queryBooking`, `cancelBooking`, `payOrder`. |
| `timeoutMs` | `60000` | Cooperative per-call budget. |
| `maxOutputChars` | `200000` | Truncation cap for formatted output. |

## Behaviour worth knowing

- **A price is never invented.** `search_hotels.min_price` is reported as a
  cached candidate signal; a quotable price requires `tourmind_room_rates` or
  `tourmind_check_availability`.
- **Batch items are independent.** A top-level successful batch that contains a
  failed hotel never drops the successful siblings, and an empty item is
  reported as empty — never as unavailability and never as an error.
- **`create_booking` refuses to run** without `guest_name`, `rate_code`,
  `currency`, `total_price`, and a plausible `contact_email`.
- **Batch size is enforced**: 1–20 `hotel_ids` per call.
- **Error handling**: a failure arrives either as a non-2xx status or as an
  `{"ok": false}` envelope at HTTP 200; both are surfaced with the status,
  `error_code` and detail. HTTP 401 / `unauthorized` points at
  `tourmind_account` action `clear`. HTTP 403 with
  `HOTEL_BUSINESS_PERMISSION_REQUIRED` states that hotel business access is not
  enabled and that the (valid) `sk_` token must **not** be replaced.

## Wiring

The plugin resolves from the profile directory, so it must be present at
`$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai/dsh-tool-tourmind/`.
The preset row (see `C:\Users\hxy\.dsh\.agent-presets\tourmind-booking\agent.cordis.yml`):

```yaml
- id: tool-tourmind
  name: '@deepseek-ai/dsh-tool-tourmind'
  config:
    apiUrl: https://api.tourmind.com
```

The row sits **loose** — no `isolate` realm. It publishes no service: it
registers into the host `tools` / `systemPrompt` registries' per-preset layer
and consumes those host registries, so a realm would hide them and leave the row
waiting forever.

## Development

```powershell
node --check lib/index.js          # syntax
node verify-schemas.mjs            # model-facing schema rules, 12 tools
node smoke-test.mjs                # fake ctx + LIVE read-only API calls
```

`verify-schemas.mjs` imports the **installed** copy under
`$DSH_HOME/profiles/web/node_modules`, so copy `lib/index.js` there before
running either script. `smoke-test.mjs` also asserts the argument guards
(empty / over-20 batch, missing and malformed email) reject before any network
call. Dates passed to it must be in the future.
