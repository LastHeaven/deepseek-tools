// @deepseek-ai/dsh-build-panel
//
// Host half of the "build" workflow panel (the DSH equivalent of the opencode
// `build.md` command). Two planes, two transports:
//
//   - browse plane: a dedicated Typert Remote service (`buildPanel` namespace)
//     exposing `list`/`overview` RPC over the shared `/api` channel. Panel
//     browsing is pure UI state — it appends NO session events, renders NO
//     chat cards, and never reaches the model context.
//   - drive plane (`/build <id> run [note]`): the human-facing slash command,
//     which queues a model-visible follow-up message carrying the full
//     workflow instruction, so the agent executes the build workflow (read
//     index → read plan → implement → archive) exactly like the opencode
//     command did. This one is intentionally logged: it changes what the
//     agent does and belongs in the audit trail.
//
// Both planes run against the session's real working directory via node:fs
// (the host process, not the sandbox).
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "build-panel";
/** Services required: the slash registry (drive plane) and sessions (cwd resolution). */
const inject = ["commands", "sessions"];

/** The model-facing workflow instruction queued by `/build <id> run`. */
function workflowInstruction(id, extra) {
  const note = extra === "" ? "" : `\n\n补充说明：${extra}`;
  return `请按 build 工作流执行任务号 ${id}。${note}

## 1. 参考文件索引
读取 docs/${id}/index.md 作为参考文件索引（需自行维护涉及到的源码路径）。
若 index.md 为空或不存在，自动扫描 docs/${id}/ 下所有非 index.md、非 plan.md 的 .md 文件，按文件名排序取前 3 个作为默认参考。

## 2. 执行目标
读取 docs/${id}/plan.md 作为执行目标。
若 plan.md 为空，读取 docs/${id}/todo/ 目录下状态为「待办」的任务作为目标。

## 3. 执行
按目标实现，并维护 index.md 中涉及的源码路径。

## 4. 完成后标准操作
1. 追加 docs/${id}/archive.md：格式 \`| 时间 | 交接摘要 | 遗留事项 | 下一步 |\`，严禁覆盖历史记录。
2. 将状态为「已完成」的 todo 文件移动到 docs/${id}/finish/（保留原文件名，重名则追加时间戳）。
3. 将 docs/${id}/plan.md 内容剪切到 docs/${id}/plans/<时间戳>.md 并清空 plan.md（确保 plans/ 目录存在）。

若有需求或设计不清楚的地方，直接问用户。`;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Read one optional file; empty string when missing. */
async function readOpt(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Parse the `状态` field out of a todo file's frontmatter. */
function todoStatus(content) {
  const match = /状态\s*[:：]\s*(\S+)/u.exec(content);
  return match ? match[1] : "";
}

/** Modification time (ms) of one file, or null when missing. */
async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** One task directory (a direct child of docs/) as panel-facing JSON. */
async function describeTask(root, id) {
  const dir = join(root, id);
  const indexExists = await exists(join(dir, "index.md"));
  const planExists = await exists(join(dir, "plan.md"));
  const todos = await listDir(join(dir, "todo"));
  const finish = await listDir(join(dir, "finish"));
  const plans = await listDir(join(dir, "plans"));
  return {
    id,
    indexExists,
    planExists,
    planMtime: planExists ? await mtime(join(dir, "plan.md")) : null,
    todoCount: todos.length,
    finishCount: finish.length,
    plansCount: plans.length
  };
}

/** Every task directory under docs/, newest plan first. */
async function listTasks(root) {
  const entries = await listDir(root);
  const tasks = [];
  for (const entry of entries) {
    const probe = await readdir(join(root, entry)).catch(() => null);
    if (probe === null) continue; // file, not a directory
    tasks.push(await describeTask(root, entry));
  }
  // Newest plan.md first; tasks without a plan keep ascending id order at the tail.
  tasks.sort((a, b) => {
    const am = a.planMtime ?? Number.NEGATIVE_INFINITY;
    const bm = b.planMtime ?? Number.NEGATIVE_INFINITY;
    if (am !== bm) return bm - am;
    return a.id < b.id ? -1 : 1;
  });
  return tasks;
}

/** Full overview of one task directory. */
async function taskOverview(root, id) {
  const dir = join(root, id);
  const probe = await readdir(dir).catch(() => null);
  if (probe === null) throw new Error(`任务目录 docs/${id} 不存在`);
  const todos = await listDir(join(dir, "todo"));
  const todoItems = [];
  for (const file of todos) {
    const content = await readOpt(join(dir, "todo", file));
    todoItems.push({ file, status: todoStatus(content) });
  }
  const archive = await readOpt(join(dir, "archive.md"));
  const archiveTail = archive.split("\n").filter((line) => line.trim() !== "").slice(-6).join("\n");
  return {
    type: "overview",
    id,
    index: await readOpt(join(dir, "index.md")),
    plan: await readOpt(join(dir, "plan.md")),
    todos: todoItems,
    finish: await listDir(join(dir, "finish")),
    plans: await listDir(join(dir, "plans")),
    archiveTail
  };
}

/**
 * The browse plane: a dedicated Remote service whose calls are pure UI reads.
 * Registered under the `buildPanel` wire namespace; the SRC gateway derives
 * endpoints `buildPanel/list` and `buildPanel/overview` from the method
 * markers below. Parameter names are wire fields, so they stay stable.
 */
class BuildPanelService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "buildPanel");
    this.sessions = ctx.sessions;
  }

  /** List every task directory under the session's docs/, newest plan first. */
  async list(sessionId) {
    const root = this.docsRoot(sessionId);
    return { type: "list", tasks: await listTasks(root) };
  }

  /** Full overview of one task directory under the session's docs/. */
  async overview(sessionId, id) {
    const root = this.docsRoot(sessionId);
    return taskOverview(root, id);
  }

  /** docs/ root of one session, failing loud when the session has no cwd. */
  docsRoot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`会话 ${sessionId} 不存在`);
    const cwd = session.header.cwd;
    if (cwd === undefined || cwd === "") throw new Error("当前会话缺少工作目录 cwd");
    return join(cwd, "docs");
  }
}

// Apply the @Remote markers the way the decorator would: one initializer per
// method, run against an object whose prototype chain carries the class
// prototype, so `remoteMethods()` (WeakMap keyed by prototype) sees them on
// every instance. This is the exact table the stage-3 decorator writes.
{
  const initializers = [];
  const marker = (methodName) => {
    Remote(BuildPanelService.prototype[methodName], {
      private: false,
      static: false,
      name: methodName,
      kind: "method",
      addInitializer(fn) { initializers.push(fn); },
    });
  };
  marker("list");
  marker("overview");
  const probe = Object.create(BuildPanelService.prototype);
  for (const init of initializers) init.call(probe);
}

/** Register the browse service and the `/build` drive command. */
function apply(ctx) {
  new BuildPanelService(ctx);
  ctx.commands.register({
    name: "build",
    description: "执行 docs/<任务号> 构建工作流（浏览请用侧边栏 Build 面板）",
    input: { hint: "<任务号> run [补充说明]" },
    handler: async (invocation) => {
      const cwd = invocation.agent.session.header.cwd;
      if (cwd === void 0 || cwd === "") return { kind: "error", text: "当前会话缺少工作目录 cwd" };
      const raw = invocation.rawInput.trim();
      const parts = raw.split(/\s+/u);
      const id = parts[0];
      const sub = parts.slice(1).join(" ").trim();
      if (id === "" || !(sub === "run" || sub.startsWith("run "))) {
        return { kind: "error", text: '用法：/build <任务号> run [补充说明]；浏览任务请打开侧边栏 Build 面板' };
      }
      const extra = sub.slice(3).trim();
      try {
        invocation.agent.followup(createUserMessage({
          content: [{ type: "text", text: workflowInstruction(id, extra) }],
          source: { kind: "user" }
        }));
        return { kind: "success", text: JSON.stringify({ type: "run", id, ok: true }) };
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    }
  });
}

export { apply, inject, name };
