// @deepseek-ai/dsh-tool-tourmind
//
// Native Cordis tool plugin exposing the TourMind hotel booking suite as
// model-facing tools over the TourMind Skill REST API (default
// https://api.tourmind.com). This is the in-process replacement for a
// stdio/MCP proxy around the TourMind Skill: it registers the tools directly
// through the `tools` registry and calls the HTTP API with the Node built-in
// `fetch`, so there is no child process, no JSON-RPC layer, and no third-party
// dependency.
//
// Every endpoint is `POST /skill/<channel>/<op>` with a JSON body and a JSON
// response. The channel is chosen by the stored credential:
//   - no credential, or a `uk_...` token -> ToC (personal),   /skill/toc/<op>
//   - a `sk_...` token                   -> ToB (business),  /skill/tob/<op>
// The credential field is strictly channel-bound: ToB bodies always carry
// `token`; ToC order bodies carry `user_key` and ToC read bodies carry no
// credential field at all. `token` and `user_key` are never mixed.
//
// Success envelope: {"ok": true,  "data": {...}}
// Failure envelope: {"ok": false, "error_code": "...", "error": "..."}
// A failure envelope may arrive with HTTP 200, so both paths are checked.
//
// Verified operations:
//   POST check_skill_update        compare the pinned skill version
//   POST search_location           resolve a keyword to regions/hotels/a place
//   POST search_hotels             candidate hotel pool for a stay
//   POST get_hotel_detail          one hotel's static detail
//   POST query_room_rates          room products + rates for one hotel
//   POST batch_query_room_rates    the same for up to 20 hotels
//   POST check_room_availability   confirm one rate_code is still bookable
//   POST create_booking            create an order -> agent_ref_id
//   POST query_booking             read one order by agent_ref_id
//   POST cancel_booking            cancel one order by agent_ref_id
//   POST pay_order                 obtain the payment URL for one order
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-tourmind";
/** Services required by the tool suite. */
const inject = ["tools", "systemPrompt"];

/** Default cooperative tool-call budget (ms) attached to every tool. */
const DEFAULT_TIMEOUT_MS = 60000;
/** TourMind Skill contract version this plugin was written against. */
const SKILL_VERSION = "1.0.8";

/** Plugin config, resolved by the loader (schemastery defaults applied). */
const Config = z.object({
  apiUrl: z.string().default("https://api.tourmind.com"),
  tokenFile: z.string().default(""),
  skillVersion: z.string().default(SKILL_VERSION),
  account: z.boolean().default(true),
  checkUpdate: z.boolean().default(true),
  searchLocation: z.boolean().default(true),
  searchHotels: z.boolean().default(true),
  hotelDetail: z.boolean().default(true),
  roomRates: z.boolean().default(true),
  batchRoomRates: z.boolean().default(true),
  checkAvailability: z.boolean().default(true),
  createBooking: z.boolean().default(true),
  queryBooking: z.boolean().default(true),
  cancelBooking: z.boolean().default(true),
  payOrder: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxOutputChars: z.number().default(200000)
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-tourmind: ${label} must be a positive integer`);
}

/** Maximum hotels accepted by one batch rate query. */
const MAX_BATCH_HOTELS = 20;
/** ToC operations that are order operations and therefore carry `user_key`. */
const ORDER_OPS = new Set(["create_booking", "query_booking", "cancel_booking", "pay_order"]);
/** Payment methods accepted by `pay_order`. */
const PAYMENT_METHODS = ["Stripe", "微信支付", "支付宝"];
/** Account tool actions. */
const ACCOUNT_ACTIONS = ["status", "save", "clear", "guidance"];

const SIGN_IN_GUIDANCE = [
  "TourMind credentials are channel-bound; pick the one that matches how you book:",
  "- Personal (ToC, token begins uk_): sign in to Journione at https://auth.journione.ai, open the account/API section, copy the complete personal token, then call tourmind_account with action \"save\" and that token.",
  "- Business (ToB, token begins sk_): sign in at https://tourmind.com/user/skill-token, issue or copy the skill token, then call tourmind_account with action \"save\" and that token.",
  "Read-only lookups (location, hotel search, detail, room rates, availability) work without a credential. Order operations (create/query/cancel/pay) need a saved token.",
  "Copy the whole token including the uk_/sk_ prefix; a partial token is rejected and will never be accepted."
].join("\n");

// ---------------------------------------------------------------------------
// Credential storage and channel routing
// ---------------------------------------------------------------------------

/** Effective credential file path. */
function tokenPath(config) {
  const configured = typeof config.tokenFile === "string" ? config.tokenFile.trim() : "";
  if (configured) return configured;
  return join(homedir(), ".dsh", "tourmind-skill-token.txt");
}

/** Read the stored credential; a missing or empty file means "no credential". */
async function readToken(config) {
  const path = tokenPath(config);
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim();
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw new Error(`tourmind: could not read the credential file ${path}: ${error && error.message ? error.message : String(error)}`);
  }
}

/** Classify a credential without throwing: none | uk | sk | unknown. */
function credentialKind(token) {
  if (!token) return "none";
  if (token.startsWith("uk_")) return "uk";
  if (token.startsWith("sk_")) return "sk";
  return "unknown";
}

/** Mask a credential for display; the value itself is never echoed. */
function maskToken(token) {
  if (!token) return "(none stored)";
  return `${token.slice(0, 3)}***`;
}

const INVALID_CREDENTIAL_MESSAGE =
  "tourmind: the stored credential is not a recognized TourMind token. Supply a complete token beginning uk_ (personal, ToC) or sk_ (business, ToB) via tourmind_account action \"save\", or remove the file with tourmind_account action \"clear\".";

/** Resolve the transport channel for an operation, failing on a malformed token. */
function channelOf(token, op) {
  if (!token) {
    if (ORDER_OPS.has(op)) {
      throw new Error("tourmind: order operations (create/query/cancel/pay) require a stored personal credential, but no credential file is present or it is empty. Save a complete token beginning uk_ with tourmind_account action \"save\".");
    }
    return "toc";
  }
  if (token.startsWith("sk_")) return "tob";
  if (token.startsWith("uk_")) return "toc";
  throw new Error(INVALID_CREDENTIAL_MESSAGE);
}

/** The single credential field a channel/op pair is allowed to send. */
function credentialFieldsFor(channel, token, op) {
  if (channel === "tob") return { token };
  if (ORDER_OPS.has(op)) return { user_key: token };
  return {};
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function baseUrl(config) {
  return String(config.apiUrl || "https://api.tourmind.com").replace(/\/+$/, "");
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) : s;
}

/** Build the failure message for any non-success response or envelope. */
function describeFailure(status, envelope, rawText, op) {
  const obj = envelope && typeof envelope === "object" ? envelope : {};
  const code = obj.error_code !== undefined && obj.error_code !== null ? String(obj.error_code) : "";
  const message = obj.error !== undefined && obj.error !== null ? String(obj.error) : "";
  const detail = clip(String(message || rawText || "").replace(/\s+/g, " ").trim(), 500);
  let out = `tourmind ${op} failed (HTTP ${status})`;
  if (code) out += ` [${code}]`;
  if (detail) out += `: ${detail}`;
  const haystack = `${code} ${message} ${rawText || ""}`.toLowerCase();
  if (code.toUpperCase() === "HOTEL_BUSINESS_PERMISSION_REQUIRED") {
    out += " — Hotel business access is not enabled for this account. The stored sk_ token is still valid, so do NOT clear or replace it; ask the account owner to enable the hotel business permission on tourmind.com, then retry.";
  } else if (status === 401 || haystack.includes("unauthorized")) {
    out += " — The stored credential was rejected as invalid or expired. Clear it with the tourmind_account tool (action \"clear\"), then save a freshly issued complete token beginning uk_ or sk_.";
  }
  return out;
}

/**
 * POST one Skill operation and return the parsed envelope.
 * The body must already contain the credential fields its channel allows.
 */
async function requestJson(config, channel, op, body, signal) {
  const path = `/skill/${channel === "tob" ? "tob" : "toc"}/${op}`;
  const url = baseUrl(config) + path;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const rawText = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    envelope = undefined;
  }
  if (!res.ok) throw new Error(describeFailure(res.status, envelope, rawText, op));
  if (envelope && typeof envelope === "object" && !Array.isArray(envelope) && envelope.ok === false) {
    throw new Error(describeFailure(res.status, envelope, rawText, op));
  }
  return envelope !== undefined ? envelope : rawText;
}

/** Route one operation through the stored credential's channel. */
async function callOp(config, op, fields, signal) {
  const token = await readToken(config);
  const channel = channelOf(token, op);
  const body = { ...credentialFieldsFor(channel, token, op), ...fields };
  return requestJson(config, channel, op, body, signal);
}

// ---------------------------------------------------------------------------
// Shared read helpers for formatters
// ---------------------------------------------------------------------------

/** Unwrap the `data` member of a success envelope. */
function payload(envelope) {
  if (!envelope || typeof envelope !== "object") return {};
  const data = envelope.data;
  if (data === undefined || data === null) return envelope;
  if (typeof data === "object") return data;
  return { data };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** First present, non-empty member among `keys`. */
function pick(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Keep only supplied, non-empty fields (never invent API input). */
function definedFields(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function money(amount, currency) {
  if (amount === undefined || amount === null) return "(amount not returned)";
  return currency ? `${amount} ${currency}` : String(amount);
}

function yesNo(value) {
  if (value === undefined || value === null) return "unknown";
  return value ? "yes" : "no";
}

function formatScalar(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(formatScalar).join("/");
  if (typeof value === "object") {
    return Object.entries(value).map(([key, inner]) => `${key}=${formatScalar(inner)}`).join(",");
  }
  return String(value);
}

function oneLine(value, max) {
  return clip(String(value).replace(/\s+/g, " ").trim(), max);
}

function formatTags(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((entry) => (typeof entry === "string" ? entry : pick(entry, "name", "title", "text")))
    .filter((entry) => typeof entry === "string" && entry !== "")
    .join(", ");
}

function stayLabel(args) {
  const occupancy = [`${args.adults} adult(s)`];
  if (args.room_count !== undefined && args.room_count !== null) occupancy.push(`${args.room_count} room(s)`);
  if (args.children !== undefined && args.children !== null) occupancy.push(`${args.children} child(ren)`);
  return `${args.check_in_date} \u2192 ${args.check_out_date}, ${occupancy.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Formatters (model-facing text)
// ---------------------------------------------------------------------------

function formatAccountStatus(config, token, kind) {
  const path = tokenPath(config);
  const lines = ["TourMind credential status", `- Credential file: ${path}`];
  if (kind === "none") {
    lines.push(`- Stored credential: no (${maskToken("")})`);
    lines.push("- Channel: public (ToC, /skill/toc/) — read-only lookups work with no credential; order operations need a saved personal uk_ token.");
  } else if (kind === "uk") {
    lines.push(`- Stored credential: yes — ${maskToken(token)}`);
    lines.push("- Channel: personal (ToC, /skill/toc/) — read requests send no credential field; order requests send user_key.");
  } else if (kind === "sk") {
    lines.push(`- Stored credential: yes — ${maskToken(token)}`);
    lines.push("- Channel: business (ToB, /skill/tob/) — every request body carries the token.");
  } else {
    lines.push(`- Stored credential: yes — ${maskToken(token)} (unrecognized format)`);
    lines.push("- Channel: unresolved — every TourMind call will fail until this file holds a complete token beginning uk_ or sk_, or is cleared.");
  }
  lines.push("The token value itself is never shown or repeated; only the channel it selects is reported.");
  return lines.join("\n");
}

function formatAccountSave(config, token, channel) {
  const kind = credentialKind(token);
  const label = channel === "tob" ? "business (ToB, /skill/tob/)" : "personal (ToC, /skill/toc/)";
  return [
    "TourMind credential saved.",
    `- Credential file: ${tokenPath(config)} (replaced)`,
    `- Masked credential: ${maskToken(token)}`,
    `- Type: ${kind === "sk" ? "uk/sk business skill token" : "personal skill token"}`,
    `- Selected channel: ${label}`,
    "The token was written to disk and was not echoed back. Use tourmind_account action \"status\" to re-check it at any time."
  ].join("\n");
}

function formatAccountClear(config) {
  return [
    "TourMind credential cleared.",
    `- Credential file: ${tokenPath(config)} (removed; a missing file is treated as no credential)`,
    "- Channel now: public (ToC) — read-only lookups keep working; order operations will report that a personal credential is required."
  ].join("\n");
}

/** Markers for the documented `skill_update` object, excluded from the dump. */
const UPDATE_FIELDS = [
  "available",
  "display_to_user",
  "latest_version",
  "message",
  "release_source_url"
];

function formatCheckUpdate(envelope, currentVersion) {
  const d = payload(envelope);
  const update = asObject(pick(d, "skill_update", "update")) || d;
  const latest = pick(update, "latest_version", "new_version", "version", "latest");
  // The documented flag is `available`; the other names are tolerated legacy aliases.
  const availableField = pick(update, "available", "update_available", "has_update", "need_update", "update_required");
  const displayToUser = pick(update, "display_to_user", "show_to_user");
  const notes = pick(update, "message", "update_message", "changelog", "release_notes", "description", "notice");
  const source = pick(update, "release_source_url", "download_url", "update_url", "url");

  const latestStr = latest !== undefined && latest !== null ? String(latest) : "";
  const currentStr = String(currentVersion);
  // Compare as semantic versions so a not-newer value never reads as an update.
  const parsed = (v) => {
    const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v || "");
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
  };
  const cmp = (() => {
    const a = parsed(latestStr);
    const b = parsed(currentStr);
    if (!a || !b) return undefined;
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
  })();

  let available;
  if (availableField !== undefined && availableField !== null) available = availableField === true || availableField === "true";
  else if (cmp !== undefined) available = cmp > 0;

  const lines = [`TourMind skill update check (pinned version: ${currentVersion})`];
  lines.push(`- Latest version reported: ${latestStr || "not reported"}`);
  if (available === undefined) lines.push("- Update available: not reported by the service");
  else if (!available) lines.push("- Update available: no");
  else lines.push(`- Update available: yes${cmp !== undefined && cmp <= 0 ? " (service flag set, but the reported version is not newer than the pinned one)" : ""}`);
  if (displayToUser !== undefined) lines.push(`- Should be shown to the user: ${yesNo(displayToUser)}`);
  if (available && notes) lines.push(`- Release notes: ${oneLine(notes, 1500)}`);
  if (available && source) lines.push(`- Release source: ${source}`);
  if (available && !notes) lines.push("- Release notes: not provided by the service (do not invent release details)");
  if (!available) lines.push("- Action: no update action needed; continue the user's hotel request and do not raise this unless the user asked.");
  for (const [key, value] of Object.entries(update)) {
    if (UPDATE_FIELDS.includes(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`- ${key}: ${oneLine(value, 400)}`);
    }
  }
  return lines.join("\n");
}

function formatSearchLocation(envelope, keyword) {
  const d = payload(envelope);
  const regions = Array.isArray(d) ? d : Array.isArray(d.regions) ? d.regions : [];
  const hotels = Array.isArray(d) ? [] : Array.isArray(d.hotels) ? d.hotels : [];
  const place = Array.isArray(d) ? undefined : asObject(pick(d, "place", "resolved_place", "location"));
  const lines = [`TourMind location matches for "${keyword}"`];
  if (regions.length) {
    lines.push(`Regions (${regions.length}):`);
    for (const region of regions) {
      const rid = pick(region, "region_id", "id") ?? "?";
      const regionName = pick(region, "name", "region_name", "title") || "(unnamed region)";
      const type = pick(region, "type", "region_type");
      const country = pick(region, "country", "country_name", "country_code");
      const count = pick(region, "hotel_count", "hotels_count", "hotel_num");
      const extras = [];
      if (type !== undefined) extras.push(`type: ${type}`);
      if (country !== undefined) extras.push(`country: ${country}`);
      if (count !== undefined) extras.push(`hotels: ${count}`);
      lines.push(`- ${regionName} [region_id: ${rid}]${extras.length ? ` — ${extras.join(", ")}` : ""}`);
    }
  } else {
    lines.push("Regions: none returned.");
  }
  if (hotels.length) {
    lines.push(`Hotels (${hotels.length}):`);
    for (const hotel of hotels) {
      const hid = pick(hotel, "hotel_id", "id") ?? "?";
      const hotelName = pick(hotel, "hotel_name", "name") || "(unnamed hotel)";
      const star = pick(hotel, "star", "star_rating", "stars");
      const address = pick(hotel, "address", "hotel_address");
      lines.push(`- ${hotelName} [hotel_id: ${hid}]${star !== undefined ? ` — ${star}\u2605` : ""}${address ? ` — ${address}` : ""}`);
    }
  } else {
    lines.push("Hotels: none returned.");
  }
  if (place) {
    const lat = pick(place, "latitude", "lat");
    const lng = pick(place, "longitude", "lng", "lon");
    const radius = pick(place, "recommended_radius_km", "radius_km");
    const placeName = pick(place, "name", "place_name", "location_name") || keyword;
    lines.push(
      `Resolved place: ${placeName} — latitude ${lat !== undefined ? lat : "?"}, longitude ${lng !== undefined ? lng : "?"}` +
        `${radius !== undefined ? `, recommended search radius: ${radius} km` : ""}`
    );
    if (lat !== undefined && lng !== undefined) {
      lines.push("Use these coordinates with tourmind_search_hotels nearby mode (latitude + longitude + radius_km) to search around this place.");
    }
  } else {
    lines.push("Resolved place: none — use region_id or keyword mode for tourmind_search_hotels.");
  }
  return lines.join("\n");
}

function formatSearchHotels(envelope, args) {
  const d = payload(envelope);
  const hotels = Array.isArray(d) ? d : Array.isArray(d.hotels) ? d.hotels : [];
  const total = Array.isArray(d) ? hotels.length : pick(d, "total", "total_count");
  const scope = Array.isArray(d) ? undefined : pick(d, "search_scope", "scope");
  const lines = [`TourMind hotel candidates — ${stayLabel(args)}`];
  lines.push(`- Total: ${total !== undefined ? total : hotels.length}${scope !== undefined ? ` | search scope: ${scope}` : ""}`);
  if (!hotels.length) {
    lines.push("No hotels were returned for these dates and filters. Broaden the price band, widen the radius, or retry with a region_id / keyword.");
    return lines.join("\n");
  }
  lines.push(`Hotels (${hotels.length}):`);
  for (const hotel of hotels) {
    const id = pick(hotel, "hotel_id", "id") ?? "?";
    const hotelName = pick(hotel, "hotel_name", "name") || "(unnamed hotel)";
    const star = pick(hotel, "star", "star_rating", "stars");
    const minPrice = pick(hotel, "min_price");
    const currency = pick(hotel, "currency_code", "currency");
    const distance = pick(hotel, "distance_km", "distance");
    const address = pick(hotel, "address", "hotel_address");
    lines.push(`- ${hotelName} [hotel_id: ${id}]${star !== undefined ? ` — ${star}\u2605` : ""}`);
    lines.push(`    cached min_price: ${money(minPrice, currency)} — cached candidate signal, NOT a live price; quote a price only after tourmind_room_rates or tourmind_check_availability.`);
    if (distance !== undefined) lines.push(`    distance: ${distance} km`);
    if (address) lines.push(`    address: ${address}`);
  }
  const webUrl = Array.isArray(d) ? undefined : pick(d, "web_url");
  if (webUrl) lines.push(`Read-only result link (context only, not bookable state): ${webUrl}`);
  lines.push("Verify the shortlist with tourmind_batch_room_rates (at most 20 hotel_ids per call) before quoting anything.");
  return lines.join("\n");
}

function formatHotelDetail(envelope, hotelId) {
  const d = payload(envelope);
  const hotel = asObject(pick(d, "hotel", "hotel_detail", "detail", "data")) || d;
  const lines = [`TourMind hotel detail — hotel_id ${hotelId}`];
  const hotelName = pick(hotel, "hotel_name", "name");
  if (hotelName) lines.push(`- Name: ${hotelName}`);
  lines.push(`- hotel_id: ${pick(hotel, "hotel_id", "id") ?? hotelId}`);
  const star = pick(hotel, "star", "star_rating", "stars");
  if (star !== undefined) lines.push(`- Star rating: ${star}`);
  const address = pick(hotel, "address", "hotel_address");
  if (address) lines.push(`- Address: ${address}`);
  const city = pick(hotel, "city", "city_name");
  const region = pick(hotel, "region_name", "region");
  if (city || region) lines.push(`- Location: ${[city, region].filter(Boolean).join(", ")}`);
  const lat = pick(hotel, "latitude", "lat");
  const lng = pick(hotel, "longitude", "lng", "lon");
  if (lat !== undefined || lng !== undefined) lines.push(`- Coordinates: ${lat ?? "?"}, ${lng ?? "?"}`);
  const phone = pick(hotel, "phone", "telephone", "tel");
  if (phone) lines.push(`- Phone: ${phone}`);
  const email = pick(hotel, "email", "contact_email");
  if (email) lines.push(`- Email: ${email}`);
  const checkIn = pick(hotel, "check_in_time", "checkin_time");
  const checkOut = pick(hotel, "check_out_time", "checkout_time");
  if (checkIn || checkOut) lines.push(`- Check-in / check-out: ${checkIn ?? "?"} / ${checkOut ?? "?"}`);
  const amenities = formatTags(pick(hotel, "amenities", "facilities", "hotel_amenities", "services"));
  if (amenities) lines.push(`- Amenities: ${oneLine(amenities, 800)}`);
  const images = pick(hotel, "images", "image_list", "photos");
  if (Array.isArray(images) && images.length) lines.push(`- Images returned: ${images.length}`);
  const description = pick(hotel, "description", "intro", "hotel_description");
  if (description) lines.push("", `Description: ${oneLine(description, 1500)}`);
  lines.push("", "Static detail only: it carries no price and no availability. Confirm both with tourmind_room_rates or tourmind_check_availability.");
  return lines.join("\n");
}

function roomGroups(source) {
  if (!source || typeof source !== "object") return [];
  if (Array.isArray(source)) return source;
  for (const key of ["rooms", "room_types", "room_list", "products", "room_products", "items"]) {
    if (Array.isArray(source[key]) && source[key].length) return source[key];
  }
  return [];
}

function groupProducts(group) {
  const nested = pick(group, "products", "rates", "rate_list", "room_products");
  if (Array.isArray(nested) && nested.length) return nested;
  return [group];
}

function formatRateProduct(product) {
  const rate = asObject(pick(product, "rate")) || product;
  const policy =
    asObject(pick(product, "cancellation_policy", "cancellation")) ||
    asObject(pick(rate, "cancellation_policy", "cancellation")) ||
    {};
  const code = pick(rate, "rate_code", "rateCode") ?? pick(product, "rate_code");
  const currency = pick(rate, "currency", "currency_code") ?? pick(product, "currency");
  const total = pick(rate, "total_price", "totalPrice") ?? pick(product, "total_price");
  const perNight = pick(rate, "per_night_price", "perNightPrice") ?? pick(product, "per_night_price");
  const onRequest = pick(product, "is_on_request", "on_request") ?? pick(rate, "is_on_request");
  const maxOccupancy = pick(product, "max_occupancy", "maxOccupancy") ?? pick(rate, "max_occupancy");
  const mealType = pick(product, "meal_type") ?? pick(rate, "meal_type");
  const mealCount = pick(product, "meal_count") ?? pick(rate, "meal_count");
  return [
    `  - rate_code: ${code !== undefined ? code : "(not returned)"}`,
    `    total: ${money(total, currency)}${perNight !== undefined ? ` | per night: ${money(perNight, currency)}` : ""}`,
    `    on request: ${yesNo(onRequest)} | max occupancy: ${maxOccupancy !== undefined ? maxOccupancy : "?"}`,
    `    meal: type=${mealType !== undefined ? mealType : "?"}, count=${mealCount !== undefined ? mealCount : "?"}`,
    `    cancellation: type=${pick(policy, "type", "policy_type") ?? "?"}, free_cancel_deadline=${pick(policy, "free_cancel_deadline", "deadline") ?? "none"}, effective_non_refundable=${yesNo(pick(policy, "effective_non_refundable", "non_refundable"))}`
  ];
}

function formatRoomRates(envelope, args) {
  const d = payload(envelope);
  const groups = roomGroups(d);
  const lines = [`TourMind room rates — hotel_id ${args.hotel_id}, ${stayLabel(args)}`];
  if (!groups.length) {
    lines.push("No room rates were returned for this hotel and stay. The hotel may be sold out, the occupancy may exceed every room's capacity, or the dates may be outside the booking window.");
    return lines.join("\n");
  }
  lines.push(`Room types returned: ${groups.length}`);
  for (const group of groups) {
    const typeName = pick(group, "room_type_name", "room_name", "name", "room_type") || "(unnamed room type)";
    lines.push(`Room type: ${typeName}`);
    const products = groupProducts(group);
    for (const product of products) lines.push(...formatRateProduct(product));
  }
  const notice = pick(d, "notice", "message", "remark", "note");
  if (notice) lines.push(`Note from the service: ${oneLine(notice, 600)}`);
  lines.push("Rates are live quotes for the product's own conditions; re-check with tourmind_check_availability (hotel_id + rate_code) immediately before tourmind_create_booking.");
  return lines.join("\n");
}

function formatBatchItem(item) {
  const lines = [];
  const groups = roomGroups(item);
  const itemStatus = pick(item, "status", "state");
  const succeeded = pick(item, "ok", "success");
  for (const group of groups) {
    const typeName = pick(group, "room_type_name", "room_name", "name", "room_type") || "(unnamed room type)";
    lines.push(`  Room type: ${typeName}`);
    for (const product of groupProducts(group)) lines.push(...formatRateProduct(product));
  }
  if (lines.length) return lines;
  const statusText = itemStatus !== undefined ? String(itemStatus).toLowerCase() : "";
  if (succeeded === false || statusText === "failed" || statusText === "error" || statusText === "fail") {
    return [`  FAILED — the service reported status "${itemStatus !== undefined ? itemStatus : "failed"}" for this hotel without a message. Treat this hotel as unverified, not as unavailable.`];
  }
  return ["  No room rates returned for this hotel. This is an empty result, not an error and not proof of unavailability; re-check with tourmind_room_rates or tourmind_check_availability."];
}

function formatBatchRoomRates(envelope, args) {
  const d = payload(envelope);
  const items = Array.isArray(d) ? d : Array.isArray(d.results) ? d.results : Array.isArray(d.items) ? d.items : Array.isArray(d.hotels) ? d.hotels : [];
  const summary = Array.isArray(d) ? undefined : asObject(pick(d, "summary"));
  const lines = [`TourMind batch room rates — ${args.hotel_ids.length} hotel(s), ${stayLabel(args)}`];
  if (summary) {
    const pairs = Object.entries(summary).map(([key, value]) => `${key}=${formatScalar(value)}`);
    if (pairs.length) lines.push(`Summary: ${pairs.join(", ")}`);
  }
  if (!items.length) {
    lines.push("The batch response carried no per-hotel items. Do not treat any hotel as unavailable; re-run tourmind_room_rates for the hotels you need.");
    return lines.join("\n");
  }
  for (const item of items) {
    const hotelId = pick(item, "hotel_id", "hotelId", "id") ?? "(hotel_id not returned)";
    const code = pick(item, "error_code");
    const errorText = pick(item, "error", "error_message");
    lines.push(`Hotel ${hotelId}:`);
    if (errorText !== undefined || code !== undefined || item.ok === false) {
      const detail = errorText !== undefined ? oneLine(errorText, 400) : "the service returned no error text for this hotel";
      lines.push(`  FAILED — ${detail}${code !== undefined ? ` [${code}]` : ""}`);
      continue;
    }
    lines.push(...formatBatchItem(item));
  }
  lines.push("Every listed hotel is reported independently; successful items are never dropped because a sibling failed.");
  return lines.join("\n");
}

function formatCheckAvailability(envelope, args) {
  const d = payload(envelope);
  const available = pick(d, "available", "is_available", "availability");
  const rate = asObject(pick(d, "rate")) || d;
  const policy =
    asObject(pick(d, "cancellation_policy", "cancellation")) ||
    asObject(pick(rate, "cancellation_policy", "cancellation")) ||
    {};
  const lines = [`TourMind availability — hotel_id ${args.hotel_id}, rate_code ${args.rate_code}`];
  lines.push(`- Stay: ${stayLabel(args)}`);
  lines.push(`- Available: ${available !== undefined ? yesNo(available) : "not reported (check the raw status fields below)"}`);
  lines.push(`- rate_code: ${pick(rate, "rate_code", "rateCode") ?? pick(d, "rate_code") ?? args.rate_code}`);
  const currency = pick(rate, "currency", "currency_code") ?? pick(d, "currency", "currency_code");
  lines.push(`- total: ${money(pick(d, "total_price", "price") ?? pick(rate, "total_price"), currency)}`);
  const perNight = pick(d, "per_night_price") ?? pick(rate, "per_night_price");
  if (perNight !== undefined) lines.push(`- per night: ${money(perNight, currency)}`);
  lines.push(`- on request: ${yesNo(pick(d, "is_on_request") ?? pick(rate, "is_on_request"))}`);
  lines.push(`- max occupancy: ${pick(d, "max_occupancy") ?? pick(rate, "max_occupancy") ?? "?"}`);
  lines.push(
    `- cancellation: type=${pick(policy, "type", "policy_type") ?? "?"}, free_cancel_deadline=${pick(policy, "free_cancel_deadline", "deadline") ?? "none"}, effective_non_refundable=${yesNo(pick(policy, "effective_non_refundable", "non_refundable"))}`
  );
  const status = pick(d, "status", "state");
  if (status !== undefined) lines.push(`- status: ${status}`);
  const message = pick(d, "message", "notice");
  if (message) lines.push(`- message: ${oneLine(message, 600)}`);
  lines.push("This confirms the rate for this stay only; create the order promptly with tourmind_create_booking because availability and price can change.");
  return lines.join("\n");
}

function bookingAmountLines(d, currency) {
  const lines = [];
  const total = pick(d, "total_price", "total_amount", "amount");
  const paid = pick(d, "paid_amount", "pay_amount");
  const fee = pick(d, "cancel_fee", "cancellation_fee");
  if (total !== undefined) lines.push(`- Total price: ${money(total, currency)}`);
  if (paid !== undefined) lines.push(`- Paid amount: ${money(paid, currency)}`);
  if (fee !== undefined) lines.push(`- Cancellation fee: ${money(fee, currency)}`);
  return lines;
}

function bookingStayLines(d) {
  const lines = [];
  const hotel = pick(d, "hotel_name", "hotel_id");
  const room = pick(d, "room_type_name", "room_name", "room_type", "rate_code");
  const checkIn = pick(d, "check_in_date", "checkin_date");
  const checkOut = pick(d, "check_out_date", "checkout_date");
  if (hotel !== undefined) lines.push(`- Hotel: ${hotel}`);
  if (room !== undefined) lines.push(`- Room / rate: ${room}`);
  if (checkIn !== undefined || checkOut !== undefined) lines.push(`- Dates: ${checkIn ?? "?"} \u2192 ${checkOut ?? "?"}`);
  const guests = pick(d, "guest_name");
  if (guests !== undefined) lines.push(`- Guest: ${guests}`);
  const adults = pick(d, "adults");
  if (adults !== undefined) lines.push(`- Adults: ${adults}`);
  return lines;
}

function formatCreateBooking(envelope, args) {
  const d = payload(envelope);
  const ref = pick(d, "agent_ref_id", "agentRefId", "order_no", "order_id");
  const currency = pick(d, "currency", "currency_code") ?? args.currency;
  const lines = ["TourMind booking created."];
  lines.push(`- TourMind order number (agent_ref_id): ${ref !== undefined ? ref : "(not returned — read the raw fields below and do not invent one)"}`);
  const status = pick(d, "status", "order_status");
  if (status !== undefined) lines.push(`- Status: ${status}`);
  const paymentStatus = pick(d, "payment_status", "pay_status");
  if (paymentStatus !== undefined) lines.push(`- Payment status: ${paymentStatus}`);
  lines.push(...bookingStayLines(Object.keys(d).length ? d : args));
  lines.push(...bookingAmountLines(d, currency));
  const due = pick(d, "pay_url", "payment_url");
  if (due !== undefined) lines.push(`- Payment URL: ${due}`);
  const message = pick(d, "message", "notice");
  if (message) lines.push(`- Message: ${oneLine(message, 600)}`);
  lines.push(`Keep agent_ref_id ${ref !== undefined ? ref : "(see above)"} to query, cancel, or pay this order with tourmind_query_booking, tourmind_cancel_booking, or tourmind_pay_order.`);
  return lines.join("\n");
}

function formatQueryBooking(envelope, args) {
  const d = payload(envelope);
  const ref = pick(d, "agent_ref_id", "agentRefId", "order_no", "order_id") ?? args.agent_ref_id;
  const currency = pick(d, "currency", "currency_code");
  const lines = [`TourMind order — agent_ref_id ${ref}`];
  const status = pick(d, "status", "order_status");
  lines.push(`- Status: ${status !== undefined ? status : "not reported"}`);
  const paymentStatus = pick(d, "payment_status", "pay_status");
  if (paymentStatus !== undefined) lines.push(`- Payment status: ${paymentStatus}`);
  lines.push(...bookingStayLines(d));
  lines.push(...bookingAmountLines(d, currency));
  const cancelable = pick(d, "cancelable", "is_cancelable");
  if (cancelable !== undefined) lines.push(`- Cancelable: ${yesNo(cancelable)}`);
  const createdAt = pick(d, "created_at", "create_time");
  if (createdAt !== undefined) lines.push(`- Created: ${createdAt}`);
  const message = pick(d, "message", "notice");
  if (message) lines.push(`- Message: ${oneLine(message, 600)}`);
  lines.push("Status, amounts, and cancellation terms come from the service as of this call; re-query before quoting them back as current.");
  return lines.join("\n");
}

function formatCancelBooking(envelope, args) {
  const d = payload(envelope);
  const ref = pick(d, "agent_ref_id", "agentRefId", "order_no", "order_id") ?? args.agent_ref_id;
  const currency = pick(d, "currency", "currency_code");
  const lines = [`TourMind cancellation — agent_ref_id ${ref}`];
  lines.push(`- status: ${pick(d, "status", "order_status") ?? "not reported"}`);
  lines.push(`- cancel_fee: ${money(pick(d, "cancel_fee", "cancellation_fee"), currency)}`);
  lines.push(`- refund_amount: ${money(pick(d, "refund_amount", "refund"), currency)}`);
  lines.push(`- currency: ${currency ?? "not reported"}`);
  const refundStatus = pick(d, "refund_status");
  if (refundStatus !== undefined) lines.push(`- refund_status: ${refundStatus}`);
  const message = pick(d, "message", "notice");
  if (message) lines.push(`- Message: ${oneLine(message, 600)}`);
  return lines.join("\n");
}

function formatPayOrder(envelope, args) {
  const d = payload(envelope);
  const ref = pick(d, "agent_ref_id", "agentRefId", "order_no", "order_id") ?? args.agent_ref_id;
  const payUrl = pick(d, "pay_url", "payment_url", "url");
  const currency = pick(d, "currency", "currency_code");
  const lines = [`TourMind payment — agent_ref_id ${ref}`];
  lines.push(`- pay_url: ${payUrl !== undefined ? payUrl : "not returned by the service"}`);
  const method = pick(d, "payment_method") ?? args.payment_method;
  if (method !== undefined) lines.push(`- payment_method: ${method}`);
  const amount = pick(d, "total_price", "amount", "pay_amount");
  if (amount !== undefined) lines.push(`- Amount due: ${money(amount, currency)}`);
  const status = pick(d, "status", "payment_status", "pay_status");
  if (status !== undefined) lines.push(`- status: ${status}`);
  const expires = pick(d, "expires_at", "expire_time", "pay_url_expire_time");
  if (expires !== undefined) lines.push(`- Link expires: ${expires}`);
  const message = pick(d, "message", "notice");
  if (message) lines.push(`- Message: ${oneLine(message, 600)}`);
  if (payUrl !== undefined) lines.push("Open pay_url exactly as returned to complete payment; the order is not settled until payment succeeds.");
  return lines.join("\n");
}

function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n(Content truncated at ${max} characters.)`;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function stringOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }]
  };
}

function applyAccountTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_account",
    description: "Inspect, save, or clear the stored TourMind credential and explain how to obtain one. Use action \"status\" to see which channel the current credential selects, \"save\" (with token) to store a complete uk_ or sk_ token, \"clear\" to remove it, and \"guidance\" for the sign-in pages. Read-only TourMind lookups work without a credential; order operations require one. The token value is never echoed back.",
    parameters: {
      action: { type: "string", enum: ACCOUNT_ACTIONS, description: "What to do (default \"status\")." },
      token: { type: "string", description: "The complete TourMind token to store; required for action \"save\" and ignored otherwise. It must begin uk_ (personal) or sk_ (business)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args) {
      const action = args.action || "status";
      const path = tokenPath(config);
      if (action === "save") {
        const token = typeof args.token === "string" ? args.token.trim() : "";
        if (!token) {
          throw new Error("tourmind_account: action \"save\" requires the token parameter — pass the complete TourMind token beginning uk_ (personal) or sk_ (business).");
        }
        if (!token.startsWith("uk_") && !token.startsWith("sk_")) {
          throw new Error("tourmind_account: the supplied credential is not a complete TourMind token. Supply the whole token beginning uk_ (personal, ToC) or sk_ (business, ToB), including its prefix.");
        }
        if (token.length <= 3) {
          throw new Error("tourmind_account: the supplied credential is only a prefix. Supply the complete token beginning uk_ or sk_, not just \"uk_\" or \"sk_\".");
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
        return truncate(formatAccountSave(config, token, channelOf(token, "search_hotels")), config.maxOutputChars);
      }
      if (action === "clear") {
        try {
          await unlink(path);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            throw new Error(`tourmind_account: could not remove the credential file ${path}: ${error && error.message ? error.message : String(error)}`);
          }
        }
        return truncate(formatAccountClear(config), config.maxOutputChars);
      }
      if (action === "guidance") {
        return truncate(SIGN_IN_GUIDANCE, config.maxOutputChars);
      }
      let token = "";
      try {
        token = await readToken(config);
      } catch (error) {
        return truncate(`TourMind credential status\n- Credential file: ${path}\n- Could not be read: ${error && error.message ? error.message : String(error)}\nThe TourMind tools will fail until this file is readable, replaced with a valid token, or removed with tourmind_account action "clear".`, config.maxOutputChars);
      }
      return truncate(formatAccountStatus(config, token, credentialKind(token)), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `tourmind account: ${args.action || "status"}`, kind: "tourmind-account", rawInput: args.action || "status" })
  }));
}

function applyCheckUpdateTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_check_update",
    description: "Ask the TourMind Skill service whether a newer contract version exists than the one this plugin was written against, and return the reported latest version and notes. Use it when TourMind behaviour or fields look unexpected. It only reads version metadata and changes nothing.",
    parameters: {
      current_version: { type: "string", description: `The version to compare against (default the plugin's pinned version, ${SKILL_VERSION}).` }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const currentVersion = typeof args.current_version === "string" && args.current_version.trim() !== ""
        ? args.current_version.trim()
        : (config.skillVersion || SKILL_VERSION);
      const envelope = await callOp(config, "check_skill_update", { current_version: currentVersion }, exec.signal);
      return truncate(formatCheckUpdate(envelope, currentVersion), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `tourmind update check: ${args.current_version || config.skillVersion || SKILL_VERSION}`, kind: "tourmind-update", rawInput: args.current_version || SKILL_VERSION })
  }));
}

function applySearchLocationTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_search_location",
    description: "Resolve a place name or keyword to TourMind regions, hotels, and coordinates. Use it first when you only have a city/landmark name, then pass the returned region_id to tourmind_search_hotels region mode, or the place's latitude/longitude plus recommended_radius_km to nearby mode. Returns region ids with hotel counts, matched hotels, and the resolved place.",
    parameters: {
      keyword: { type: "string", required: true, description: "Place name, city, district, or landmark to resolve (for example \"Tokyo\" or \"West Lake Hangzhou\")." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const envelope = await callOp(config, "search_location", { keyword: args.keyword }, exec.signal);
      return truncate(formatSearchLocation(envelope, args.keyword), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.keyword, kind: "tourmind-location", rawInput: args.keyword })
  }));
}

function applySearchHotelsTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_search_hotels",
    description: "Search the TourMind hotel pool for a stay and return candidate hotels with a cached min_price. Use one of three modes: region (region_id from tourmind_search_location), nearby (latitude + longitude + radius_km), or keyword. The returned min_price is a cached candidate signal, never a quote; confirm real prices with tourmind_room_rates or tourmind_batch_room_rates before telling the user anything about cost.",
    parameters: {
      check_in_date: { type: "string", required: true, description: "Check-in date as YYYY-MM-DD." },
      check_out_date: { type: "string", required: true, description: "Check-out date as YYYY-MM-DD; must be after check_in_date." },
      adults: { type: "integer", required: true, description: "Number of adults (18+) staying." },
      room_count: { type: "integer", description: "Number of rooms requested (default 1)." },
      children: { type: "integer", description: "Number of children staying (default 0)." },
      children_ages: { type: "array", items: { type: "integer" }, description: "Ages of the children, one entry per child; must match the children count when supplied." },
      lowest_price: { type: "number", description: "Minimum budget filter. IMPORTANT: this is in CNY and MUST be the whole-stay total across ALL rooms, not a per-room nightly figure. Multiply any per-room nightly budget by nights x rooms first (for example 600 CNY per room per night x 3 nights x 2 rooms = 3600)." },
      highest_price: { type: "number", description: "Maximum budget filter. IMPORTANT: this is in CNY and MUST be the whole-stay total across ALL rooms, not a per-room nightly figure. Multiply any per-room nightly budget by nights x rooms first (for example 600 CNY per room per night x 3 nights x 2 rooms = 3600)." },
      location_name: { type: "string", description: "Human-readable location name to search within (for example a city or district)." },
      region_id: { type: "string", description: "TourMind region id from tourmind_search_location; selects region mode." },
      keyword: { type: "string", description: "Hotel name or keyword; selects keyword mode. Pass only one of region_id, keyword, or latitude+longitude." },
      latitude: { type: "number", description: "Latitude for nearby mode; requires longitude and radius_km." },
      longitude: { type: "number", description: "Longitude for nearby mode; requires latitude and radius_km." },
      radius_km: { type: "number", description: "Search radius in kilometres for nearby mode." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const fields = definedFields(args, [
        "check_in_date",
        "check_out_date",
        "adults",
        "room_count",
        "children",
        "children_ages",
        "lowest_price",
        "highest_price",
        "location_name",
        "region_id",
        "keyword",
        "latitude",
        "longitude",
        "radius_km"
      ]);
      const envelope = await callOp(config, "search_hotels", fields, exec.signal);
      return truncate(formatSearchHotels(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.region_id || args.keyword || args.location_name || "hotel search", kind: "tourmind-hotels", rawInput: args.check_in_date })
  }));
}

function applyHotelDetailTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_hotel_detail",
    description: "Fetch the static detail of one TourMind hotel: name, star rating, address, coordinates, amenities, and description. Use it to answer descriptive questions about a hotel you already have a hotel_id for. It returns no price and no availability; get those from tourmind_room_rates or tourmind_check_availability.",
    parameters: {
      hotel_id: { type: "string", required: true, description: "The TourMind hotel id (from tourmind_search_hotels or tourmind_search_location)." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const envelope = await callOp(config, "get_hotel_detail", { hotel_id: args.hotel_id }, exec.signal);
      return truncate(formatHotelDetail(envelope, args.hotel_id), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.hotel_id, kind: "tourmind-hotel", rawInput: args.hotel_id })
  }));
}

const OCCUPANCY_PARAMS = {
  room_count: { type: "integer", description: "Number of rooms requested (default 1)." },
  children: { type: "integer", description: "Number of children staying (default 0)." },
  children_ages: { type: "array", items: { type: "integer" }, description: "Ages of the children, one entry per child; must match the children count when supplied." }
};

const STAY_PARAMS = {
  check_in_date: { type: "string", required: true, description: "Check-in date as YYYY-MM-DD." },
  check_out_date: { type: "string", required: true, description: "Check-out date as YYYY-MM-DD; must be after check_in_date." },
  adults: { type: "integer", required: true, description: "Number of adults (18+) staying." }
};

function applyRoomRatesTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_room_rates",
    description: "Get the live room types, rate codes, prices, and cancellation policies for one TourMind hotel over a stay. Use it to quote a price for a specific hotel after tourmind_search_hotels, or to expand one hotel from a batch result. Returns one entry per rate_code with total and per-night price, occupancy, meal plan, on-request flag, and cancellation terms.",
    parameters: {
      hotel_id: { type: "string", required: true, description: "The TourMind hotel id." },
      ...STAY_PARAMS,
      ...OCCUPANCY_PARAMS
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const fields = definedFields(args, ["hotel_id", "check_in_date", "check_out_date", "adults", "room_count", "children", "children_ages"]);
      const envelope = await callOp(config, "query_room_rates", fields, exec.signal);
      return truncate(formatRoomRates(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.hotel_id, kind: "tourmind-rates", rawInput: args.hotel_id })
  }));
}

function applyBatchRoomRatesTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_batch_room_rates",
    description: "Get live room rates for up to 20 TourMind hotels in one call. Use it to price the shortlist returned by tourmind_search_hotels without one call per hotel. Each hotel is reported independently with its own status and summary, so one failure never hides a sibling's rates. Split longer lists into batches of at most 20.",
    parameters: {
      hotel_ids: { type: "array", items: { type: "string" }, required: true, description: "Between 1 and 20 TourMind hotel ids. A longer list is rejected: split it into batches of at most 20 and call the tool once per batch." },
      ...STAY_PARAMS,
      ...OCCUPANCY_PARAMS
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ids = Array.isArray(args.hotel_ids)
        ? args.hotel_ids.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim())
        : [];
      if (!ids.length) {
        throw new Error("tourmind_batch_room_rates: hotel_ids must contain at least one hotel id; pass the ids returned by tourmind_search_hotels.");
      }
      if (ids.length > MAX_BATCH_HOTELS) {
        throw new Error(`tourmind_batch_room_rates: ${ids.length} hotel ids were supplied but at most ${MAX_BATCH_HOTELS} are allowed per call. Split the list into batches of at most ${MAX_BATCH_HOTELS} hotel ids and call the tool once per batch.`);
      }
      const fields = {
        hotel_ids: ids,
        ...definedFields(args, ["check_in_date", "check_out_date", "adults", "room_count", "children", "children_ages"])
      };
      const envelope = await callOp(config, "batch_query_room_rates", fields, exec.signal);
      return truncate(formatBatchRoomRates(envelope, { ...args, hotel_ids: ids }), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${Array.isArray(args.hotel_ids) ? args.hotel_ids.length : 0} hotels`, kind: "tourmind-batch-rates", rawInput: args.check_in_date })
  }));
}

function applyCheckAvailabilityTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_check_availability",
    description: "Confirm that one specific TourMind rate_code is still bookable for a stay, and re-read its price, currency, and cancellation terms. Use it immediately before tourmind_create_booking, because rates from tourmind_room_rates can sell out or change. Returns the availability flag, rate code, price, and policy.",
    parameters: {
      hotel_id: { type: "string", required: true, description: "The TourMind hotel id." },
      rate_code: { type: "string", required: true, description: "The exact rate_code from tourmind_room_rates or tourmind_batch_room_rates." },
      ...STAY_PARAMS,
      ...OCCUPANCY_PARAMS
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const fields = definedFields(args, ["hotel_id", "rate_code", "check_in_date", "check_out_date", "adults", "room_count", "children", "children_ages"]);
      const envelope = await callOp(config, "check_room_availability", fields, exec.signal);
      return truncate(formatCheckAvailability(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `${args.hotel_id} / ${args.rate_code}`, kind: "tourmind-availability", rawInput: args.rate_code })
  }));
}

/** Require a plausible contact email address. */
function assertContactEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email) {
    throw new Error("tourmind_create_booking: contact_email is required — collect the guest's contact email first, because the booking confirmation and voucher are delivered to it.");
  }
  if (/\s/.test(email)) {
    throw new Error(`tourmind_create_booking: contact_email "${email}" is not plausible — it must not contain spaces.`);
  }
  const parts = email.split("@");
  if (parts.length !== 2) {
    throw new Error(`tourmind_create_booking: contact_email "${email}" is not plausible — it must contain exactly one "@".`);
  }
  const [local, domain] = parts;
  if (!local) {
    throw new Error(`tourmind_create_booking: contact_email "${email}" is not plausible — the part before "@" is empty.`);
  }
  if (!domain || !domain.includes(".")) {
    throw new Error(`tourmind_create_booking: contact_email "${email}" is not plausible — the domain part after "@" must be non-empty and contain a "." (for example guest@example.com).`);
  }
  if (domain.startsWith(".") || domain.endsWith(".")) {
    throw new Error(`tourmind_create_booking: contact_email "${email}" is not plausible — the domain part must not start or end with a ".".`);
  }
  return email;
}

/** Require the guest's legal name. */
function assertGuestName(value) {
  const guest = typeof value === "string" ? value.trim() : "";
  if (!guest) {
    throw new Error("tourmind_create_booking: guest_name is required — collect the guest's legal name exactly as it appears on the ID or passport they will present at check-in.");
  }
  return guest;
}

/** Require a non-empty string argument for booking-critical fields. */
function assertNonEmpty(label, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`tourmind_create_booking: ${label} is required — read it from tourmind_check_availability or tourmind_room_rates and pass it unchanged.`);
  return text;
}

function applyCreateBookingTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_create_booking",
    description: "Create a TourMind hotel order for one rate_code. Call tourmind_check_availability first, then pass the confirmed rate_code with the exact currency and total_price the service returned. Requires the guest's legal name and a plausible contact email; the order number comes back as data.agent_ref_id and must be reported to the user.",
    parameters: {
      hotel_id: { type: "string", required: true, description: "The TourMind hotel id." },
      rate_code: { type: "string", required: true, description: "The confirmed rate_code from tourmind_check_availability." },
      check_in_date: { type: "string", required: true, description: "Check-in date as YYYY-MM-DD." },
      check_out_date: { type: "string", required: true, description: "Check-out date as YYYY-MM-DD." },
      guest_name: { type: "string", required: true, description: "The guest's legal name exactly as on their ID or passport; the hotel checks it at check-in." },
      contact_email: { type: "string", required: true, description: "Contact email for the confirmation and voucher. Required and plausibility-checked (one @, non-empty local part, domain containing a dot)." },
      adults: { type: "integer", required: true, description: "Number of adults (18+) staying." },
      room_count: { type: "integer", required: true, description: "Number of rooms to book." },
      children: { type: "integer", description: "Number of children staying (default 0)." },
      children_ages: { type: "array", items: { type: "integer" }, description: "Ages of the children, one entry per child; send it whenever children > 0." },
      currency: { type: "string", required: true, description: "Currency code of total_price exactly as returned by the availability or rate call (for example CNY)." },
      total_price: { type: "number", required: true, description: "The whole-stay total the service quoted for this rate_code; never a client-side estimate." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const guestName = assertGuestName(args.guest_name);
      const contactEmail = assertContactEmail(args.contact_email);
      const rateCode = assertNonEmpty("rate_code", args.rate_code);
      const currency = assertNonEmpty("currency", args.currency);
      const hotelId = assertNonEmpty("hotel_id", args.hotel_id);
      if (args.total_price === undefined || args.total_price === null) {
        throw new Error("tourmind_create_booking: total_price is required — pass the whole-stay total returned by tourmind_check_availability or tourmind_room_rates, not an estimate.");
      }
      const fields = {
        hotel_id: hotelId,
        rate_code: rateCode,
        check_in_date: args.check_in_date,
        check_out_date: args.check_out_date,
        guest_name: guestName,
        contact_email: contactEmail,
        adults: args.adults,
        room_count: args.room_count,
        children: args.children !== undefined && args.children !== null ? args.children : 0,
        currency,
        total_price: args.total_price
      };
      if (Array.isArray(args.children_ages) && args.children_ages.length) fields.children_ages = args.children_ages;
      const envelope = await callOp(config, "create_booking", fields, exec.signal);
      return truncate(formatCreateBooking(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `book ${args.hotel_id}`, kind: "tourmind-booking", rawInput: args.hotel_id })
  }));
}

function applyQueryBookingTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_query_booking",
    description: "Read back one TourMind order by its agent_ref_id: status, payment status, hotel and room, dates, guests, and amounts. Use it to answer \"what happened to my booking\" or before cancelling or paying. Requires the order operations channel credential.",
    parameters: {
      agent_ref_id: { type: "string", required: true, description: "The TourMind order number returned as data.agent_ref_id by tourmind_create_booking." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const envelope = await callOp(config, "query_booking", { agent_ref_id: args.agent_ref_id }, exec.signal);
      return truncate(formatQueryBooking(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: args.agent_ref_id, kind: "tourmind-order", rawInput: args.agent_ref_id })
  }));
}

function applyCancelBookingTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_cancel_booking",
    description: "Cancel one TourMind order by its agent_ref_id and report the resulting status, cancellation fee, refund amount, and currency. This is a destructive, irreversible operation: confirm the agent_ref_id and the cancellation policy with the user before calling it.",
    parameters: {
      agent_ref_id: { type: "string", required: true, description: "The TourMind order number returned as data.agent_ref_id by tourmind_create_booking." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const envelope = await callOp(config, "cancel_booking", { agent_ref_id: args.agent_ref_id }, exec.signal);
      return truncate(formatCancelBooking(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `cancel ${args.agent_ref_id}`, kind: "tourmind-cancel", rawInput: args.agent_ref_id })
  }));
}

function applyPayOrderTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: "tourmind_pay_order",
    description: "Request the payment link for one TourMind order by its agent_ref_id and return pay_url. Use it when the user is ready to settle an order created by tourmind_create_booking. Present pay_url to the user and report the payment status; the order is not paid until the user completes payment there.",
    parameters: {
      agent_ref_id: { type: "string", required: true, description: "The TourMind order number returned as data.agent_ref_id by tourmind_create_booking." },
      payment_method: { type: "string", enum: PAYMENT_METHODS, required: true, description: "Payment channel: \"Stripe\", \"微信支付\", or \"支付宝\"." }
    },
    output: stringOutput(),
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const envelope = await callOp(config, "pay_order", { agent_ref_id: args.agent_ref_id, payment_method: args.payment_method }, exec.signal);
      return truncate(formatPayOrder(envelope, args), config.maxOutputChars);
    },
    presentCall: (args) => ({ card: "generic", title: `pay ${args.agent_ref_id}`, kind: "tourmind-pay", rawInput: args.payment_method })
  }));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  assertPositiveInteger("maxOutputChars", config.maxOutputChars);
  if (typeof config.skillVersion !== "string" || config.skillVersion.trim() === "") {
    throw new Error("tool-tourmind: skillVersion must be a non-empty string");
  }

  ctx.systemPrompt.section({
    name: "tool:tourmind",
    order: 120,
    text: [
      "The tourmind_* tools call the live TourMind hotel APIs; the stored credential selects the personal (ToC) or business (ToB) channel.",
      "Never invent hotels, room types, prices, availability, cancellation terms, or order numbers — report only what a tool returned, and say plainly when a call returned nothing.",
      "min_price from tourmind_search_hotels is a cached candidate signal, not a quote: quote a price only after tourmind_room_rates, tourmind_batch_room_rates, or tourmind_check_availability.",
      "Treat tourmind_search_hotels output as a candidate pool and verify the shortlist with tourmind_batch_room_rates (at most 20 hotel_ids per call).",
      "Before tourmind_create_booking, collect the guest's legal name and a plausible contact email, pass the exact currency and total_price the availability call returned, and read data.agent_ref_id back to the user as the TourMind order number.",
      "Dates are YYYY-MM-DD and price filters are CNY whole-stay totals across all rooms (per-room nightly budgets must be multiplied by nights x rooms first)."
    ].join(" ")
  });

  if (config.account) applyAccountTool(ctx, config);
  if (config.checkUpdate) applyCheckUpdateTool(ctx, config);
  if (config.searchLocation) applySearchLocationTool(ctx, config);
  if (config.searchHotels) applySearchHotelsTool(ctx, config);
  if (config.hotelDetail) applyHotelDetailTool(ctx, config);
  if (config.roomRates) applyRoomRatesTool(ctx, config);
  if (config.batchRoomRates) applyBatchRoomRatesTool(ctx, config);
  if (config.checkAvailability) applyCheckAvailabilityTool(ctx, config);
  if (config.createBooking) applyCreateBookingTool(ctx, config);
  if (config.queryBooking) applyQueryBookingTool(ctx, config);
  if (config.cancelBooking) applyCancelBookingTool(ctx, config);
  if (config.payOrder) applyPayOrderTool(ctx, config);
}

export { Config, DEFAULT_TIMEOUT_MS, SKILL_VERSION, apply, inject, name };
