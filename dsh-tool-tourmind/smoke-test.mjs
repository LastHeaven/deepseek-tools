// Smoke test for @deepseek-ai/dsh-tool-tourmind.
//
// Drives the plugin with a fake Cordis ctx (no DSH process), then exercises the
// registered tools against the LIVE TourMind API for the read-only endpoints.
// Usage: node smoke-test.mjs
import { apply, name, inject, Config } from "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-tourmind/lib/index.js";

const registered = [];
const sections = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section(s) { sections.push(s); return () => {}; } },
};

// Reproduce the loader's Config normalization (defaults, no validation bypass).
const config = Config({
  apiUrl: "https://api.tourmind.com",
  timeoutMs: 120000,
  maxOutputChars: 200000,
});

apply(ctx, config);

console.log("name    :", name);
console.log("inject  :", JSON.stringify(inject));
console.log("tools   :", registered.map((t) => t.name).join(", "));
console.log("sections:", JSON.stringify(sections.map((s) => s.name)));
console.log("toolDefs:", registered.length, "| promptSections:", sections.length);
console.log("");

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

const signal = AbortSignal.timeout(120000);
const results = [];
async function run(label, toolName, args) {
  const tool = byName[toolName];
  if (!tool) { results.push(`${label}: MISSING TOOL ${toolName}`); return undefined; }
  try {
    const out = await tool.execute(args, { signal });
    const text = String(out);
    results.push(`${label}: OK (${text.length} chars)`);
    return text;
  } catch (error) {
    results.push(`${label}: ERROR -> ${error && error.message ? error.message : String(error)}`);
    return undefined;
  }
}

// --- local, no network ---
await run("account status ", "tourmind_account", { action: "status" });
await run("account guidanc", "tourmind_account", { action: "guidance" });

// --- schema guards that must FAIL before any network call ---
{
  const t = byName["tourmind_batch_room_rates"];
  try {
    await t.execute({ hotel_ids: [], check_in_date: "2026-10-20", check_out_date: "2026-10-23", adults: 2 }, { signal });
    results.push("batch empty guard: FAIL (no error thrown)");
  } catch (error) { results.push(`batch empty guard: OK (${error.message.slice(0, 80)})`); }
  try {
    await t.execute({ hotel_ids: Array.from({ length: 21 }, (_, i) => String(i)), check_in_date: "2026-10-20", check_out_date: "2026-10-23", adults: 2 }, { signal });
    results.push("batch >20 guard  : FAIL (no error thrown)");
  } catch (error) { results.push(`batch >20 guard  : OK (${error.message.slice(0, 80)})`); }
}
{
  const t = byName["tourmind_create_booking"];
  const base = { hotel_id: "1", rate_code: "r", check_in_date: "2026-10-20", check_out_date: "2026-10-23", adults: 2, room_count: 1, children: 0, children_ages: [], currency: "CNY", total_price: 100 };
  for (const [label, email] of [["missing-email guard", undefined], ["bad-email guard   ", "nodomain"], ["bad-email guard 2 ", "a b@c.com"]]) {
    try {
      await t.execute({ ...base, guest_name: "Zhang San", ...(email === undefined ? {} : { contact_email: email }) }, { signal });
      results.push(`${label}: FAIL (no error thrown)`);
    } catch (error) { results.push(`${label}: OK (${error.message.slice(0, 70)})`); }
  }
}

// --- live read-only API ---
const kw = process.argv[2] || "Tokyo Shinjuku";
const locRaw = await run("search_location ", "tourmind_search_location", { keyword: kw });
if (locRaw) console.log("--- search_location output ---\n" + locRaw.slice(0, 1600) + "\n");

const updRaw = await run("check_update    ", "tourmind_check_update", {});
if (updRaw) console.log("--- check_update output ---\n" + updRaw.slice(0, 500) + "\n");

// Reuse a resolved region id when the live location search produced one.
let regionId;
try {
  const m = locRaw && locRaw.match(/region_id[=: ]+([A-Za-z0-9_-]+)/i);
  if (m) regionId = m[1];
} catch { /* ignore */ }

const searchArgs = {
  check_in_date: "2026-10-20",
  check_out_date: "2026-10-23",
  adults: 2,
  room_count: 1,
  children: 0,
  children_ages: [],
};
if (regionId) { searchArgs.region_id = regionId; searchArgs.location_name = kw; }
else { searchArgs.keyword = kw; }

const searchRaw = await run("search_hotels   ", "tourmind_search_hotels", searchArgs);
if (searchRaw) console.log("--- search_hotels output ---\n" + searchRaw.slice(0, 2500) + "\n");

// Extract hotel ids for batch + detail + rates.
const ids = [...new Set((searchRaw || "").match(/\b\d{6,10}\b/g) || [])].slice(0, 3);
console.log("extracted hotel ids:", JSON.stringify(ids));

if (ids.length) {
  const detailRaw = await run("hotel_detail    ", "tourmind_hotel_detail", { hotel_id: ids[0] });
  if (detailRaw) console.log("--- hotel_detail output ---\n" + detailRaw.slice(0, 1400) + "\n");

  const batchRaw = await run("batch_rates     ", "tourmind_batch_room_rates", { hotel_ids: ids, ...searchArgs });
  if (batchRaw) console.log("--- batch_room_rates output ---\n" + batchRaw.slice(0, 2500) + "\n");
}

console.log("=== RESULTS ===");
for (const line of results) console.log(line);
