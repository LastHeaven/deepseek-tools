// @deepseek-ai/dsh-ask-popup
//
// Host-only plugin: shows a WINDOWS SYSTEM NOTIFICATION (tray balloon /
// notification-center toast) whenever the LLM asks the user a question via
// the `ask_user_question` tool.
//
// Mechanism:
//   - The agent loop records every tool invocation as a `tool/call` session
//     event: { turn, step, callId, name, arguments } (arguments is a JSON
//     string).
//   - We subscribe to the global `session/event` stream and watch for
//     `tool/call` with name === "ask_user_question".
//   - On match we parse the questions payload and launch a PowerShell
//     notification via `cmd /c start "" /min` + `-EncodedCommand`.
//     Empirically on Windows 10/11: a direct Node spawn of powershell.exe
//     lands on a non-interactive window station (balloon silently dropped),
//     and a .ps1 file mangles CJK text under the console codepage; the
//     `/min` start + Base64 UTF-16LE command is the combination that shows
//     the balloon with correct Chinese, no console window flash.
//
// No client half is needed: the web UI already shows the question card; this
// plugin only adds the OS-level ping so the user notices even when looking
// elsewhere.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Debug log file — always written (small, diagnostic only). */
const DEBUG_LOG = join(tmpdir(), "dsh-ask-popup.log");
function debugLog(...parts) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {}
}

/** Cordis plugin name used by loader diagnostics. */
const name = "ask-popup";
/** Hard dependency: the session event stream is emitted through the session service's carrier. */
const inject = ["sessions"];

const Config = z.object({
  enabled: z.boolean().default(true),
  /** Toast title. */
  title: z.string().default("DeepSeek Harness"),
  /** How long the bubble stays visible, in milliseconds. */
  timeoutMs: z.number().default(10000),
  /** Only notify when a question has options (multiple-choice) vs free-text-only. */
  onlyWithOptions: z.boolean().default(false),
  /**
   * Notification style:
   *  - "bubble" (default): classic Windows tray balloon (NotifyIcon). Launched
   *    through `cmd /c start` so the PowerShell process runs on the
   *    interactive desktop — a plain Node `spawn` lands on a non-interactive
   *    window station and the balloon never displays.
   *  - "toast": Windows 10/11 notification-center toast via the explorer
   *    AppUserModelID (always registered, displays bottom-right).
   *  - "popup": classic WScript.Shell popup dialog (modal, always visible,
   *    but blocks interaction until dismissed/timeout).
   */
  style: z.union(["bubble", "toast", "popup"]).default("bubble")
});

/** Escape a string for single-quoted PowerShell literals. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * The explorer AppUserModelID — the one AUMID guaranteed to be registered on
 * every Windows 10/11 machine (explorer.exe is always running). WinRT toasts
 * sent under a non-registered AUMID are silently dropped by the OS; under
 * this one they display in the notification center.
 */
const EXPLORER_AUMID = "Microsoft.Explorer.Notification.{69819A3F-3956-5174-3ADB-F225694F9A49}";

/**
 * Build the PowerShell script for one notification style.
 */
function notificationScript(title, text, timeoutMs, style) {
  const duration = Math.max(5, Math.min(Math.trunc(timeoutMs), 30000));
  const titleQ = psQuote(title);
  const textQ = psQuote(text);
  if (style === "popup") {
    // WScript.Shell popup: 64 = information icon; timeout in seconds.
    return [
      "$ws = New-Object -ComObject WScript.Shell",
      `$null = $ws.Popup(${textQ}, ${Math.max(5, Math.round(duration / 1000))}, ${titleQ}, 64)`
    ].join("; ");
  }
  if (style === "toast") {
    // WinRT toast under the explorer AUMID (bottom-right notification center).
    return [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      `$title = ${titleQ}`,
      `$body = ${textQ}`,
      "function Esc($s) { $s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '\\'','&apos;' -replace '\"','&quot;' }",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      "$xml.LoadXml('<toast duration=\"long\"><visual><binding template=\"ToastGeneric\"><text>' + (Esc $title) + '</text><text>' + (Esc $body) + '</text></binding></visual></toast>')",
      "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
      `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(EXPLORER_AUMID)})`,
      "$notifier.Show($toast)"
    ].join("; ");
  }
  // bubble (default): classic tray balloon + sound.
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    `$n.BalloonTipTitle = ${titleQ}`,
    `$n.BalloonTipText = ${textQ}`,
    "$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(${duration})`,
    "[System.Media.SystemSounds]::Exclamation.Play()",
    `Start-Sleep -Milliseconds ${Math.min(duration + 1500, 30000)}`,
    "$n.Dispose()"
  ].join("; ");
}

/**
 * Show a Windows system notification.
 *
 * Launch mechanics (all empirically verified on Windows 10/11):
 *   - The PowerShell script is passed via `-EncodedCommand` (Base64
 *     UTF-16LE), which is the one quoting/encoding path that keeps Chinese
 *     text intact end-to-end (no .ps1 file, no console codepage issues).
 *   - The process is started through `cmd /c start "" /min` so it runs on
 *     the interactive desktop (a direct Node spawn lands on a non-interactive
 *     window station and the balloon is silently dropped) while `/min`
 *     keeps the console window from flashing.
 */
function showWindowsNotification(title, text, timeoutMs, style) {
  const script = notificationScript(title, text, timeoutMs, style);
  // Base64 UTF-16LE: PowerShell's -EncodedCommand decoding is the only
  // path that is byte-exact for CJK text regardless of console codepage.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const child = spawn("cmd.exe", [
      "/c", "start", "", "/min", "powershell",
      "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-EncodedCommand", encoded
    ], {
      stdio: "ignore"
    });
    debugLog("spawned cmd start pid:", child.pid ?? "?");
    child.on("error", (err) => debugLog("cmd spawn error:", err.message));
    child.unref();
  } catch (error) {
    debugLog("spawn threw:", error instanceof Error ? error.message : String(error));
    console.error("[ask-popup] failed to spawn notification:", error);
  }
}

/** Extract the first question text (or header) from a tool/call payload. */
function questionSummary(parsed) {
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const first = questions[0];
  if (first === undefined || first === null) return null;
  const text = typeof first.question === "string" ? first.question : "";
  const header = typeof first.header === "string" ? first.header : "";
  const count = questions.length;
  const summary = (header !== "" ? header + "：\n" : "") + text;
  const suffix = count > 1 ? `\n（共 ${count} 个问题）` : "";
  return summary + suffix;
}

/** Whether the payload carries at least one multiple-choice question. */
function hasOptions(parsed) {
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return questions.some((q) => Array.isArray(q?.options) && q.options.length > 0);
}

function apply(ctx, config) {
  debugLog("apply() called, enabled =", config.enabled);
  if (!config.enabled) return;
  ctx.on("session/event", (_session, event) => {
    debugLog("session/event:", event.type, event.data?.name ?? "");
    if (event.type !== "tool/call") return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    debugLog("tool/call name:", data.name);
    if (data.name !== "ask_user_question") return;

    let parsed = null;
    try {
      parsed = JSON.parse(data.arguments);
      debugLog("parsed questions:", Array.isArray(parsed?.questions) ? parsed.questions.length : 0);
    } catch {
      parsed = null;
      debugLog("parse failed");
    }
    if (parsed === null || parsed === undefined) return;
    if (config.onlyWithOptions && !hasOptions(parsed)) return;
    const summary = questionSummary(parsed);
    if (summary === null) return;

    // Truncate very long question text for the toast.
    const text = summary.length > 300 ? summary.slice(0, 297) + "…" : summary;
    debugLog("SHOW NOTIFICATION:", config.title, "|", text.slice(0, 80), "| style:", config.style);
    showWindowsNotification(config.title, text, config.timeoutMs, config.style);
  });
}

export { Config, apply, inject, name };
