// Standalone smoke test for @local/dsh-llm-extra-retry.
//
// Drives `apply()` with a fake Cordis context — the same technique the other
// plugins in this workspace use — so the recovery decision can be exercised
// without restarting the Harness.
//
//   node smoke-test.mjs

import assert from "node:assert/strict";

const moduleUrl = new URL("./index.js", import.meta.url);
const { apply, name } = await import(moduleUrl);

assert.equal(name, "llm-extra-retry", "exports its diagnostic name");

/** Minimal fake ctx that records the waterfall listener and the cleanup effect. */
function createCtx() {
  const listeners = [];
  const cleanups = [];
  const logs = [];
  const logger = {
    info: (...args) => logs.push(["info", ...args]),
    warn: (...args) => logs.push(["warn", ...args]),
    error: (...args) => logs.push(["error", ...args]),
  };
  return {
    listeners,
    cleanups,
    logs,
    logger,
    on(event, listener) {
      assert.equal(event, "agent/request-error");
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    effect(factory) {
      cleanups.push(factory());
    },
  };
}

const BASE_CONFIG = {
  enabled: true,
  codes: ["PI_AI_ERROR"],
  messagePatterns: ["unexpected eof", "stream read error"],
  maxRetries: 2,
  initialDelayMs: 12,
  maxDelayMs: 40,
  jitterRatio: 0,
  logRetries: false,
};

/** Build one waterfall payload. */
function payload(overrides = {}) {
  const controller = new AbortController();
  return {
    agent: { session: { id: "session-1" } },
    turn: 1,
    step: 1,
    provider: "newapi",
    failure: { message: "stream read error: unexpected EOF", code: "PI_AI_ERROR" },
    retryPolicy: undefined,
    signal: controller.signal,
    controller,
    ...overrides,
  };
}

const nextReturnsNothing = () => Promise.resolve(undefined);

// 1. An eligible transient failure is retried after a bounded backoff.
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  assert.equal(ctx.listeners.length, 1, "registers exactly one waterfall listener");

  const started = Date.now();
  const decision = await ctx.listeners[0](payload(), nextReturnsNothing);
  const elapsed = Date.now() - started;
  assert.deepEqual(decision, { kind: "retry" }, "retries the eligible failure");
  assert.ok(elapsed >= 8, `waited the backoff (${elapsed}ms)`);
  assert.ok(elapsed < 2000, "backoff is bounded");
}

// 2. A downstream `retry` decision wins, and is not delayed by our backoff.
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  const started = Date.now();
  const decision = await ctx.listeners[0](payload(), () => Promise.resolve({ kind: "retry" }));
  assert.deepEqual(decision, { kind: "retry" });
  assert.ok(Date.now() - started < 8, "a downstream retry short-circuits our wait");
}

// 3. A downstream failure is contained: we still make our own decision.
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  const decision = await ctx.listeners[0](payload(), () => Promise.reject(new Error("boom")));
  assert.deepEqual(decision, { kind: "retry" });
}

// 4. A code outside the configured set is left to the loop.
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  const decision = await ctx.listeners[0](
    payload({ failure: { message: "invalid api key", code: "AUTH" } }),
    nextReturnsNothing,
  );
  assert.equal(decision, undefined, "does not retry AUTH");
}

// 5. An eligible code whose message does not match a pattern is left to the loop
//    (this is the "permanent" PI_AI_ERROR case, e.g. an unsupported `deferred`).
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  const decision = await ctx.listeners[0](
    payload({
      failure: {
        message: 'pi-ai deferred response for model "m" is not supported',
        code: "PI_AI_ERROR",
      },
    }),
    nextReturnsNothing,
  );
  assert.equal(decision, undefined, "does not retry a permanent PI_AI_ERROR");
}

// 6. The retry budget is bounded and per step; a new step starts a fresh budget.
{
  const ctx = createCtx();
  apply(ctx, BASE_CONFIG);
  const listener = ctx.listeners[0];
  const first = payload();
  assert.deepEqual(await listener(first, nextReturnsNothing), { kind: "retry" }, "attempt 1");
  assert.deepEqual(await listener(first, nextReturnsNothing), { kind: "retry" }, "attempt 2");
  assert.equal(await listener(first, nextReturnsNothing), undefined, "attempt 3 is refused");

  const nextStep = payload({ step: 2 });
  assert.deepEqual(await listener(nextStep, nextReturnsNothing), { kind: "retry" }, "fresh step, fresh budget");
}

// 7. A turn abort during the wait cancels the retry instead of retrying a cancelled turn.
{
  const ctx = createCtx();
  apply(ctx, { ...BASE_CONFIG, initialDelayMs: 5000, maxDelayMs: 5000 });
  const request = payload();
  const started = Date.now();
  const pending = ctx.listeners[0](request, nextReturnsNothing);
  setTimeout(() => request.controller.abort(new Error("user cancelled")), 20);
  const decision = await pending;
  assert.equal(decision, undefined, "an aborted turn is not retried");
  assert.ok(Date.now() - started < 1000, "the wait was cancelled, not slept through");
}

// 8. Plugin disposal aborts a pending wait and stops new decisions.
{
  const ctx = createCtx();
  apply(ctx, { ...BASE_CONFIG, initialDelayMs: 5000, maxDelayMs: 5000 });
  const listener = ctx.listeners[0];
  const pending = listener(payload(), nextReturnsNothing);
  setTimeout(() => void ctx.cleanups[0](), 20);
  assert.equal(await pending, undefined, "disposal cancels the pending wait");
  assert.equal(ctx.listeners.length, 0, "disposal removed the waterfall listener");
  assert.equal(await listener(payload(), nextReturnsNothing), undefined, "no decisions after disposal");
}

// 9. `enabled: false` mounts nothing.
{
  const ctx = createCtx();
  apply(ctx, { ...BASE_CONFIG, enabled: false });
  assert.equal(ctx.listeners.length, 0, "disabled plugin registers no listener");
  assert.equal(ctx.cleanups.length, 0, "disabled plugin registers no cleanup");
}

// 10. `codes: []` retries nothing; `messagePatterns: []` retries every eligible code.
{
  const none = createCtx();
  apply(none, { ...BASE_CONFIG, codes: [] });
  assert.equal(await none.listeners[0](payload(), nextReturnsNothing), undefined, "empty codes retries nothing");

  const any = createCtx();
  apply(any, { ...BASE_CONFIG, messagePatterns: [] });
  assert.deepEqual(
    await any.listeners[0](
      payload({ failure: { message: "pi-ai stream ended pending", code: "PI_AI_ERROR" } }),
      nextReturnsNothing,
    ),
    { kind: "retry" },
    "empty patterns retries every eligible failure",
  );
}

// 11. A provider `Retry-After` overrides the local backoff, clamped to maxDelayMs.
{
  const ctx = createCtx();
  apply(ctx, { ...BASE_CONFIG, maxDelayMs: 25 });
  const started = Date.now();
  const decision = await ctx.listeners[0](
    payload({ failure: { message: "stream read error: unexpected EOF", code: "PI_AI_ERROR", providerRetryAfterMs: 5 } }),
    nextReturnsNothing,
  );
  assert.deepEqual(decision, { kind: "retry" });
  assert.ok(Date.now() - started < 400, "honoured the provider delay");
}

// 12. Misconfiguration fails loudly at mount time rather than at the failure boundary.
for (const bad of [
  { maxRetries: -1 },
  { maxRetries: 1.5 },
  { initialDelayMs: 0 },
  { initialDelayMs: 100, maxDelayMs: 10 },
  { jitterRatio: 2 },
  { codes: [""] },
  { messagePatterns: [42] },
]) {
  assert.throws(() => apply(createCtx(), { ...BASE_CONFIG, ...bad }), /llm-extra-retry:/, `rejects ${JSON.stringify(bad)}`);
}

console.log("smoke-test: all checks passed");
