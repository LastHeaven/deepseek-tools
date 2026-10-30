// @local/dsh-llm-extra-retry
//
// Automatic retry for model-request failures that the shipped retry executor
// does not cover.
//
// WHY THIS EXISTS
// ---------------
// `@deepseek-ai/dsh-llm-retry` retries failed model requests at durable
// agent-step boundaries, but only for the codes its provider `retryPolicy`
// declares. The provider-neutral default set is
//
//   EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT
//
// The pi-ai adapter classifies anything it does not recognize as the catch-all
// `PI_AI_ERROR`. A truncated SSE body arrives as
//
//   PI_AI_ERROR  "stream read error: unexpected EOF"
//
// because the adapter's classifier only maps wordings such as "stream ended
// before/without ...", "terminated", "premature close" or a connection/socket
// mention to TRANSPORT. `PI_AI_ERROR` is not in the retryable set, so the run
// dies with a red "本轮运行失败" row even though another attempt would almost
// certainly succeed.
//
// WHAT IT DOES
// ------------
// This plugin is one more listener on the agent loop's `agent/request-error`
// waterfall — the same extension point `dsh-llm-retry` and
// `dsh-compaction-image-offload` use. When the failed attempt's code is
// eligible AND its message matches one of the configured patterns (so a
// genuinely permanent PI_AI_ERROR such as an unsupported `deferred` response
// is not retried forever), it waits a bounded, jittered, cancellable backoff
// and returns `{ kind: "retry" }`. The agent loop then re-runs the failed step
// inside the same open turn over the same durable history, exactly like the
// built-in executor does.
//
// ORDERING
// --------
// The listener asks downstream listeners first (`await next()`) and honours a
// `retry` decision it finds, so it composes with `dsh-llm-retry` in either
// mount order: the built-in executor keeps its own budget for its own codes,
// and this plugin only fills the gap it leaves.
//
// BUDGET
// ------
// The budget lives in memory and is keyed by session + turn + step: a new step
// starts a fresh budget, and the plugin never retries past `maxRetries`
// attempts. On abort (the user cancels the turn, or the plugin is disposed) the
// pending wait resolves immediately and no retry decision is returned, so the
// loop closes the turn the same way it would without this plugin.
//
// The plugin never appends session events of its own: a retried attempt stays
// non-model-visible (the framework's own `llm/retry`/`llm/retry-started`
// records belong to `dsh-llm-retry`), and a restart simply starts a fresh
// budget. Set `logRetries` to see each decision in the Host log.
//
// NO SCHEMA IMPORT
// ----------------
// This file deliberately imports nothing. A bundle installed from a workspace
// directory is linked into the profile, so a bare `@deepseek-ai/*` import here
// would be resolved from the checkout, where no `node_modules` exists. Config
// validation therefore happens in `resolveConfig` (unknown keys included), which
// throws at activation just as a Cordis `Config` schema would.

/** Diagnostic plugin name. */
const name = "llm-extra-retry";

/**
 * Lower-cased substrings that identify a transient truncation/transport
 * failure. Matching is case-insensitive substring containment on the
 * provider's message, not a regular expression, so a configured value is
 * always safe to type.
 */
const DEFAULT_MESSAGE_PATTERNS = Object.freeze([
  "unexpected eof",
  "stream read error",
  "eof",
  "connection reset",
  "econnreset",
  "socket hang up",
  "other side closed",
  "http2 request did not get a response",
  "premature close",
  "stream ended",
  "terminated",
]);

/** The failure code the shipped executor leaves to the loop. */
const DEFAULT_CODES = Object.freeze(["PI_AI_ERROR"]);

/** Every accepted configuration key, so a typo fails loudly instead of being ignored. */
const CONFIG_KEYS = new Set([
  "enabled",
  "codes",
  "messagePatterns",
  "maxRetries",
  "initialDelayMs",
  "maxDelayMs",
  "jitterRatio",
  "logRetries",
]);

const DEFAULTS = Object.freeze({
  enabled: true,
  codes: DEFAULT_CODES,
  messagePatterns: DEFAULT_MESSAGE_PATTERNS,
  maxRetries: 4,
  initialDelayMs: 1500,
  maxDelayMs: 30000,
  jitterRatio: 0.2,
  logRetries: true,
});

const MAX_MAX_RETRIES = 20;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Validate and detach one raw configuration.
 * @param config - the row's `config`, normalized by the Loader (or omitted).
 * @returns immutable, pre-lower-cased settings used by the listener.
 * @throws when an unknown key, a numeric bound, or an entry shape is invalid.
 */
function resolveConfig(config) {
  if (config === undefined || config === null) config = {};
  if (typeof config !== "object" || Array.isArray(config))
    throw new Error("llm-extra-retry: config must be an object");

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`llm-extra-retry: unknown config key "${key}"`);
  }

  const maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_MAX_RETRIES)
    throw new Error(`llm-extra-retry: maxRetries must be an integer between 0 and ${MAX_MAX_RETRIES}`);

  const initialDelayMs = config.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxDelayMs = config.maxDelayMs ?? DEFAULTS.maxDelayMs;
  for (const [key, value] of [
    ["initialDelayMs", initialDelayMs],
    ["maxDelayMs", maxDelayMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS)
      throw new Error(`llm-extra-retry: ${key} must be a positive finite number`);
  }
  if (initialDelayMs > maxDelayMs)
    throw new Error("llm-extra-retry: initialDelayMs must not exceed maxDelayMs");

  const jitterRatio = config.jitterRatio ?? DEFAULTS.jitterRatio;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
    throw new Error("llm-extra-retry: jitterRatio must be between 0 and 1");

  const codes = (config.codes ?? DEFAULTS.codes).map((code) => {
    if (typeof code !== "string" || code.trim().length === 0)
      throw new Error("llm-extra-retry: codes must contain non-empty strings");
    return code.trim().toUpperCase();
  });

  const messagePatterns = (config.messagePatterns ?? DEFAULTS.messagePatterns).map((pattern) => {
    if (typeof pattern !== "string" || pattern.trim().length === 0)
      throw new Error("llm-extra-retry: messagePatterns must contain non-empty strings");
    return pattern.trim().toLowerCase();
  });

  return Object.freeze({
    enabled: config.enabled ?? DEFAULTS.enabled,
    codes: Object.freeze([...new Set(codes)]),
    messagePatterns: Object.freeze([...new Set(messagePatterns)]),
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    logRetries: config.logRetries ?? DEFAULTS.logRetries,
  });
}

/**
 * Bounded exponential backoff with symmetric jitter.
 * @param settings - resolved configuration.
 * @param retry - one-based attempt number.
 * @param random - injectable randomness, for tests.
 * @returns the delay in milliseconds, never above `maxDelayMs`.
 */
function backoffDelay(settings, retry, random) {
  const exponent = Math.min(retry - 1, 16);
  const exponential = Math.min(settings.initialDelayMs * 2 ** exponent, settings.maxDelayMs);
  const jitter = 1 - settings.jitterRatio + 2 * settings.jitterRatio * random();
  return Math.min(exponential * jitter, settings.maxDelayMs);
}

/**
 * Wait for `delayMs`, resolving `false` as soon as `signal` aborts.
 * @param delayMs - wait length in milliseconds.
 * @param signal - the turn signal fused with the plugin's lifetime signal.
 * @returns `true` when the wait completed, `false` when it was cancelled.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Whether one failure is something this plugin may retry.
 * @param settings - resolved configuration.
 * @param failure - normalized failure facts from the failed attempt.
 * @returns true when the code is eligible and the message matches a pattern.
 */
function isEligible(settings, failure) {
  if (typeof failure?.code !== "string") return false;
  if (!settings.codes.includes(failure.code.toUpperCase())) return false;
  if (settings.messagePatterns.length === 0) return true;
  const message = typeof failure.message === "string" ? failure.message.toLowerCase() : "";
  return settings.messagePatterns.some((pattern) => message.includes(pattern));
}

/**
 * Mount the extra-retry recovery listener.
 * @param ctx - the plugin context.
 * @param config - raw plugin configuration from the patch row.
 */
function apply(ctx, config) {
  const settings = resolveConfig(config);
  if (!settings.enabled) return;

  const random = Math.random;
  const lifetime = new AbortController();
  /**
   * Per-session retry budget, held weakly so a disposed Agent's Session is
   * collectable: session object -> the bound turn/step and attempts used.
   */
  const budgets = new WeakMap();
  const active = new Set();

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  function log(level, message, ...args) {
    if (!settings.logRetries) return;
    const logger = ctx.logger;
    const write = logger?.[level] ?? logger?.warn;
    if (typeof write === "function") write.call(logger, message, ...args);
  }

  /**
   * One recovery decision for a failed model request.
   * @param payload - the waterfall payload.
   * @param next - the downstream listeners and, eventually, the loop's default.
   * @returns a retry decision, or `undefined` to leave the failure to the loop.
   */
  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    // Let the downstream chain decide first: `dsh-llm-retry` owns its own codes
    // and budget, and must keep precedence for them.
    let downstream;
    try {
      downstream = await next();
    } catch (error) {
      log("warn", "llm-extra-retry: a downstream recovery listener failed: %o", error);
      downstream = undefined;
    }
    if (downstream?.kind === "retry") return downstream;

    if (lifetime.signal.aborted || signal?.aborted) return undefined;
    if (!isEligible(settings, failure)) return undefined;
    if (settings.maxRetries <= 0) return undefined;

    const session = agent?.session;
    const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);

    const previous = session === undefined ? undefined : budgets.get(session);
    const sameStep = previous !== undefined && previous.turn === turn && previous.step === step;
    const used = sameStep ? previous.used : 0;
    if (used >= settings.maxRetries) {
      if (session !== undefined) budgets.delete(session);
      log(
        "warn",
        `llm-extra-retry: provider "${provider}" exhausted ${settings.maxRetries} extra retries for code ${failure.code} (${failure.message}); leaving the failure to the loop`,
      );
      return undefined;
    }

    const attempt = used + 1;
    if (session !== undefined) budgets.set(session, { turn, step, used: attempt });

    const providerDelay = failure.providerRetryAfterMs;
    const delayMs =
      typeof providerDelay === "number" && Number.isFinite(providerDelay) && providerDelay > 0
        ? Math.min(providerDelay, settings.maxDelayMs)
        : backoffDelay(settings, attempt, random);

    log(
      "info",
      `llm-extra-retry: retrying provider "${provider}" (attempt ${attempt}/${settings.maxRetries}) after ${Math.round(delayMs)}ms for code ${failure.code}: ${failure.message}`,
    );

    if (!(await cancellableDelay(delayMs, fused))) return undefined;
    if (fused.aborted) return undefined;
    return { kind: "retry" };
  }

  const disposeListener = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  });

  ctx.effect(() => async () => {
    disposeListener();
    lifetime.abort(new Error("llm-extra-retry plugin disposed"));
    await Promise.allSettled([...active]);
    // `budgets` is weak, so its entries leave with their Sessions.
  }, "llm-extra-retry: abort and drain active recovery");
}

export { apply, name };
