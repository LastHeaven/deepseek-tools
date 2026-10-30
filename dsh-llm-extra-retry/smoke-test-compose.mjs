// Composition test: drive the REAL `@deepseek-ai/dsh-llm-retry` executor and
// this plugin through one waterfall in the profile's registration order.
//
//   node smoke-test-compose.mjs
//
// `dsh-llm-retry` is mounted first (its row lives in the base bundle, before the
// profile's own rows), so it is the OUTER listener and this plugin runs inside
// it. That is the shipped arrangement: the built-in executor decides its own
// codes, and this plugin only sees what it delegates.

import assert from "node:assert/strict";

const LLM_RETRY =
  "file:///C:/Users/hxy/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js";

const builtIn = await import(LLM_RETRY);
const extra = await import(new URL("./index.js", import.meta.url));

/** A tiny Cordis-shaped harness: `on`, `effect`, `logger`, and a waterfall. */
function createHarness() {
  const listeners = [];
  const cleanups = [];
  const appends = [];
  const logs = [];
  const projection = { state: {} };
  const ctx = {
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    sessionProjections: {
      register: () => () => {},
      stateOf: () => projection.state,
    },
    on(name, listener) {
      listeners.push({ name, listener });
      return () => {};
    },
    effect(factory) {
      cleanups.push(factory());
      return () => {};
    },
  };
  const session = {
    id: "session-1",
    append(type, data) {
      appends.push({ type, data });
      return { type, data };
    },
  };
  const agent = { session };
  /** Outermost-first dispatch, innermost default `() => undefined`. */
  async function waterfall(payload) {
    const queue = [...listeners];
    const inner = () => Promise.resolve(undefined);
    const next = () => {
      const entry = queue.shift();
      return (entry === undefined ? inner : entry.listener)(payload, next);
    };
    return next();
  }
  return { ctx, agent, session, appends, logs, waterfall, projection };
}

function payload(harness, overrides = {}) {
  const controller = new AbortController();
  return {
    agent: harness.agent,
    turn: 1,
    step: 1,
    provider: "newapi",
    failure: { message: "stream read error: unexpected EOF", code: "PI_AI_ERROR" },
    retryPolicy: {
      mode: "normal",
      maxRetries: 5,
      retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitterRatio: 0,
    },
    signal: controller.signal,
    ...overrides,
  };
}

const EXTRA_CONFIG = {
  codes: ["PI_AI_ERROR"],
  messagePatterns: ["unexpected eof", "stream read error"],
  maxRetries: 2,
  initialDelayMs: 4,
  maxDelayMs: 8,
  jitterRatio: 0,
  logRetries: true,
};

// 1. The truncation the screenshot shows: the built-in executor delegates
//    (`PI_AI_ERROR` is outside its retryable set), and this plugin retries.
{
  const harness = createHarness();
  builtIn.apply(harness.ctx, {});
  extra.apply(harness.ctx, EXTRA_CONFIG);

  const decision = await harness.waterfall(payload(harness));
  assert.deepEqual(decision, { kind: "retry" }, "PI_AI_ERROR truncation is retried");
  assert.equal(harness.appends.length, 0, "the extra retry writes no session events");
  assert.ok(
    harness.logs.some(([level, text]) => level === "info" && String(text).includes("llm-extra-retry: retrying")),
    "the decision is logged",
  );
}

// 2. A built-in code keeps the built-in executor's own path and budget: it
//    answers first, records its durable `llm/retry` event, and this plugin
//    never adds a wait on top.
{
  const harness = createHarness();
  builtIn.apply(harness.ctx, {});
  extra.apply(harness.ctx, EXTRA_CONFIG);

  const started = Date.now();
  const decision = await harness.waterfall(
    payload(harness, { failure: { message: "429 rate limit exceeded", code: "RATE_LIMIT" } }),
  );
  assert.deepEqual(decision, { kind: "retry" }, "RATE_LIMIT is retried");
  assert.equal(harness.appends[0].type, "llm/retry", "the built-in executor recorded the retry");
  assert.ok(Date.now() - started < 60, "one backoff, not two");
}

// 3. A failure neither layer owns stays a failure.
{
  const harness = createHarness();
  builtIn.apply(harness.ctx, {});
  extra.apply(harness.ctx, EXTRA_CONFIG);

  const decision = await harness.waterfall(
    payload(harness, { failure: { message: "invalid api key", code: "AUTH" } }),
  );
  assert.equal(decision, undefined, "AUTH is left to the loop");
}

// 4. A permanent PI_AI_ERROR is not retried: the code is ours, the message is not.
{
  const harness = createHarness();
  builtIn.apply(harness.ctx, {});
  extra.apply(harness.ctx, EXTRA_CONFIG);

  const decision = await harness.waterfall(
    payload(harness, {
      failure: { message: 'pi-ai deferred response for model "m" is not supported', code: "PI_AI_ERROR" },
    }),
  );
  assert.equal(decision, undefined, "an unsupported `deferred` response is left to the loop");
}

// 5. The extra budget ends: after `maxRetries` the same failure reaches the loop.
{
  const harness = createHarness();
  builtIn.apply(harness.ctx, {});
  extra.apply(harness.ctx, EXTRA_CONFIG);

  const request = payload(harness);
  assert.deepEqual(await harness.waterfall(request), { kind: "retry" }, "attempt 1");
  assert.deepEqual(await harness.waterfall(request), { kind: "retry" }, "attempt 2");
  assert.equal(await harness.waterfall(request), undefined, "the budget is spent");
  assert.ok(
    harness.logs.some(([level, text]) => level === "warn" && String(text).includes("exhausted")),
    "exhaustion is logged",
  );
}

// 6. Reversed registration order also composes: whoever is asked first may
//    retry, and this plugin honours a downstream decision instead of doubling
//    the wait.
{
  const harness = createHarness();
  extra.apply(harness.ctx, EXTRA_CONFIG);
  builtIn.apply(harness.ctx, {});

  const decision = await harness.waterfall(
    payload(harness, { failure: { message: "upstream 503 unavailable", code: "SERVER" } }),
  );
  assert.deepEqual(decision, { kind: "retry" }, "the built-in retry decides, and is passed through");
  assert.equal(harness.appends.filter((event) => event.type === "llm/retry").length, 1, "exactly one retry recorded");
}

console.log("smoke-test-compose: all checks passed");
