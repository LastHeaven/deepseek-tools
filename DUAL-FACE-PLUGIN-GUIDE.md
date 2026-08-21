# DSH 双端插件（Host + Client）开发指南

本文档面向需要为 **DeepSeek Harness（DSH）** 编写「带浏览器 UI 的插件」的其他
Agent。它记录从零开发、接线到验证的完整流程，以本仓库的 `dsh-build-panel`
（Build 工作流面板 + `/build` 命令）为参考实现。

> 与本仓库另一份 [`PLUGIN-DEVELOPMENT-GUIDE.md`](./PLUGIN-DEVELOPMENT-GUIDE.md)
> 的分工：那份讲的是「只注册模型工具的 Host 单端插件」（context7 / firecrawl /
> vision）；这份讲的是「Host 提供能力 + Client 提供面板 UI」的**双端插件**，以及
> 两条独有的链路——slash 命令、客户端面板。
>
> 目标读者：需要「照着做就能跑通」的 Agent。每一步都给出可验证的命令和踩坑点。

---

## 目录

1. [背景：双端插件 vs 单端工具插件](#1-背景双端插件-vs-单端工具插件)
2. [先读这些源码，别猜 API](#2-先读这些源码别猜-api)
3. [最小双端插件结构](#3-最小双端插件结构)
4. [Host 半：注册 slash 命令](#4-host-半注册-slash-命令)
5. [Host 半：让命令「驱动 agent 干活」](#5-host-半让命令驱动-agent-干活)
6. [Client 半：模块系统与 seed words](#6-client-半模块系统与-seed-words)
7. [Client 半：注册面板 UI（Slot）](#7-client-半注册面板-ui-slot)
8. [Client → Host 数据通道](#8-client--host-数据通道)
9. [安装与接线](#9-安装与接线)
10. [验证：三段冒烟](#10-验证三段冒烟)
11. [踩坑排查表](#11-踩坑排查表)
12. [参考：本仓库的 dsh-build-panel](#12-参考本仓库的-dsh-build-panel)

---

## 1. 背景：双端插件 vs 单端工具插件

DSH 是 DeepSeek Harness，一个基于 **Cordis** 的插件化运行时。一个 profile（如
`web`）由多层 patch 组合而成（详见 `PLUGIN-DEVELOPMENT-GUIDE.md` 第 1 节）。

一个 npm 包可以是「单端」也可以是「双端」：

| 形态 | Host 半（Node） | Client 半（浏览器） | 典型用途 |
| --- | --- | --- | --- |
| 工具插件 | `lib/index.js` 注册 `ctx.tools` | 无 | context7 / firecrawl / vision |
| 命令插件 | `lib/index.js` 注册 `ctx.commands` | 无 | `/goal`、`/plan` |
| **双端插件** | `lib/index.js` 注册能力 | `lib/client.js` 注册 UI | 面板、设置页、侧边栏入口 |

**什么时候需要 Client 半**：只要想在 Web 页面上出现任何自定义 UI（面板、按钮、
设置项、覆盖层），就必须写 `lib/client.js`。单靠 Host 半无法在浏览器里渲染东西。

---

## 2. 先读这些源码，别猜 API

DSH 的 API **绝不能凭名字猜**。开发前逐份读参考实现，比试错快得多。

| 想搞懂什么 | 读什么（都在 DSH 的 `node_modules` 里） |
| --- | --- |
| 注册 slash 命令 | `@deepseek-ai/dsh-command-goal/lib/index.js`（最简参考）、`@deepseek-ai/dsh-plan-mode/lib/index.js` |
| 命令触发模型干活 | 同上，重点看 `agent.followup()` / `agent.steer()` / `createUserMessage()` |
| 面板 UI + Slot 注册 | `@deepseek-ai/dsh-client-ui-cordis/lib/client.js`（`CordisPanel`，官方面板参考） |
| 侧边栏 footer 入口 | 同一个文件里的 `sidebar.footer.action` 注册段 |
| 模块系统 / seed words | `@deepseek-ai/dsh-client-modules/lib/index.js`（node 半）、`lib/client.js`（browser 半） |
| Client→Host RPC | `@deepseek-ai/dsh-api-remotes/lib/client.js`、`@deepseek-ai/dsh-api-gateway/lib/client.js` |
| Slot 的 standard props | `@deepseek-ai/dsh-client-ui-renderer/lib/client.js` 的 `standardProps()` |

**关键事实（都来自源码，不是猜的）**：

- **Host 半是真实 Node 进程**。你可以直接 `import { readFile } from "node:fs/promises"`
  读写工作区文件，不需要走 DSH 的 sandbox / fs 工具。工作区根目录从
  `invocation.agent.session.header.cwd` 拿。
- **`commands` 服务在 host 平面**（`dsh-base` 的 `cordis.patch.yml` 里 `id: commands`）。
  命令插件 `inject: ["commands"]` 后，用 `ctx.commands.register(...)` 注册。
- **命令 handler 拿到的 `invocation.agent`** 是接收命令的那个 agent，它有
  `followup()` / `steer()` / `inject()` 三个「安排模型干活」的方法。

---

## 3. 最小双端插件结构

```
my-plugin/
  package.json
  lib/
    index.js      # Host 半（Node 进程）
    client.js     # Client 半（浏览器，通过 __ModuleLoader__ 注册）
```

### `package.json`

关键在 `dsh.client` 声明——它让 node 半的 `client-modules` 服务把这个包扫进
`window.__DSH_BOOT__` 的模块图：

```json
{
  "name": "@deepseek-ai/dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/client.js"],
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-commands": "*",
    "@deepseek-ai/dsh-llm": "*"
  }
}
```

要点：

- `"type": "module"`，ESM。Host 半靠 loader 的动态 `import()` 加载。
- `exports["./client"]` **必须存在**，否则 `client-modules` 报
  `declares dsh.client but exports no "./client" bundle`。
- `dsh.client.platform` 必须是 `"web"`，否则不进入 web 的 boot graph。
- `dsh.client.inject` 声明这个 client 半依赖的其它 client 包（模块图排序用）。
  只写你 `require` 的「包级」依赖；**`react` 不是包级依赖，是 seed word（见第 6 节），
  不要写进 inject**。
- `peerDependencies` 声明 Host 半 import 的 `@deepseek-ai/*` 包（零运行时 npm 依赖
  的前提，见 `PLUGIN-DEVELOPMENT-GUIDE.md` 第 7 节）。

---

## 4. Host 半：注册 slash 命令

Host 半用 `inject: ["commands"]`，然后 `ctx.commands.register(...)`。最简参考是
`@deepseek-ai/dsh-command-goal`：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "my-command";
const inject = ["commands"];

function apply(ctx) {
  ctx.commands.register({
    name: "mycmd",                              // 小写，字母/数字/_/-，无斜杠
    description: "一句话描述（显示在 / 菜单里）",
    input: { hint: "[<任务号> [run|overview]]" }, // 可选，声明自由输入占位符
    handler: async (invocation) => {
      // invocation = { commandId, agent, rawInput, attachments, signal }
      const raw = invocation.rawInput.trim();   // 命令名之后的所有原始文本
      const cwd = invocation.agent.session.header.cwd;  // 会话工作目录
      // ... 你的业务逻辑 ...
      return { kind: "success", text: "..." };  // 或 { kind: "error", text: "..." }
    }
  });
}

export { apply, inject, name };
```

命令 handler 的契约（来自 `@deepseek-ai/dsh-commands`）：

- 返回值必须是 `{ kind: "success", text? }` 或 `{ kind: "error", text }`。
- `text` 由 UI 直接渲染，**不进模型上下文**（除非你显式安排，见第 5 节）。
- 命令名必须是 `[a-z][a-z0-9_-]*`，注册时校验。
- 命令的 `command/run` / `command/done` 生命周期会自动记到会话日志，无需你管。

### 一个关键技巧：命令回传 JSON 给面板

命令的 `text` 是纯字符串，但你可以塞 JSON，让面板解析。`dsh-build-panel` 就是这么
做的——查询命令返回 `JSON.stringify({ type: "list", tasks: [...] })`，面板
`JSON.parse` 后渲染。这比自建 RPC 简单得多（见第 8 节为什么不用自建 RPC）。

---

## 5. Host 半：让命令「驱动 agent 干活」

slash 命令本身只是「命令平面」的执行，结果不进模型。如果想让模型真的开始干活
（这正是 opencode 的 `build.md` 命令做的事），要在 handler 里显式用 `agent` 安排
模型可见的消息：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";

handler: (invocation) => {
  invocation.agent.followup(createUserMessage({
    content: [{ type: "text", text: "你的完整工作流指令..." }],
    source: { kind: "user" }
  }));
  return { kind: "success", text: "已下达" };
}
```

三个方法的区别（来自 `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`）：

| 方法 | 语义 | 何时用 |
| --- | --- | --- |
| `agent.followup(msg)` | 排队一个**普通 follow-up 轮次**并唤醒 driver | 从命令触发一整轮「干活」 |
| `agent.steer(msg)` | 提交**最近一步的 steering**；idle 时开新轮，running 时下一步消费 | `/plan [message]` 就是用它 |
| `agent.inject(msg)` | 排队**下一步的模型上下文**，不唤醒 driver | 注入背景资料，等别的消息触发 |

`createUserMessage` 来自 `@deepseek-ai/dsh-llm`。`content` 是 `[{ type: "text", text }]`
块；`source` 用 `{ kind: "user" }`（伪装成用户消息）或
`{ kind: "plugin", plugin: "...", form: "notice", summary: "..." }`（插件通知）。

**官方范例**：`@deepseek-ai/dsh-command-goal/lib/index.js` 的 `submitObjectiveAttachments`
用 `invocation.agent.followup(createUserMessage({...}))` 提交图片给模型。

---

## 6. Client 半：模块系统与 seed words

Client 半不是普通 ESM——它是**工厂注册进浏览器模块系统**的 bundle：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-my-plugin",
  factory: (require) => {
    // 这里能 require 的东西受限，见下
    let react = require("react");

    function apply(ctx) { /* 注册 UI */ }
    const inject = ["slots"];

    return { apply, inject };   // 必须 return 一个 Cordis 插件对象
  }
});
```

### seed words（`require` 能拿到什么）

模块系统启动时，shell 会注入一组**编译期固定的 seed words**。这些词来自
`dsh-web-frontend/dist/assets/index-*.js` 里的 `Gd()`（不同版本变量名不同，搜
`react/jsx-runtime` 就能定位）：

```js
{
  "react": ...,
  "react/jsx-runtime": ...,
  "react-dom": ...,
  "react-dom/client": ...,
  "@deepseek-ai/cordis": ...,
  "@deepseek-ai/dsh-client-ui-slots": ...,
  "@deepseek-ai/dsh-client-ui-primitives": ...
}
```

**意味着**：

- `require("react")` 直接用，**不要**写进 `dsh.client.inject`。
- `require("@deepseek-ai/cordis")`、`require("@deepseek-ai/dsh-client-ui-primitives")`
  也直接可用（`dsh-client-ui-primitives` 提供图标、`StateDot`、`Tooltip` 等）。
- 其它 `@deepseek-ai/dsh-client-ui-*` 包**不是 seed word**，要用的话得写进
  `dsh.client.inject`（模块图会先加载它们）。
- **不能用** `import` / `require` 任意 npm 包、TS 语法、JSX、`window`/`document` 的
  裸全局。UI 用 `React.createElement(...)`，不用 JSX。

### 如何验证一个包是不是 seed word

读 shell 资产里的 `Gd()` 那段（见上）。**不要猜**。`dsh-build-panel` 只用
`require("react")`，所以零 inject 依赖。

---

## 7. Client 半：注册面板 UI（Slot）

Client 半的 `apply(ctx)` 里通过 `ctx.slots`（或 `ctx.get("slots")`）注册 UI。

### 7.1 选对 Slot

先读 `@deepseek-ai/dsh-client-ui-cordis/lib/client.js` 的 `apply()`，看官方怎么
注册 `sidebar.footer.action`（侧边栏底部入口）：

```js
function apply(ctx) {
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "my-panel",
    inject: () => ({ remote: ctx.remote })   // 注入给组件的自定义 props
  }, MyPanelComponent));
}
```

- `slots.inject(slotName, cb)`：等 slot 声明出现后再注册（cb 里调用 `slots.register`）。
- `slots.register(options, component)`：`options.id` 是注册项的 key，`options.inject`
  返回注入给组件的 props，`component` 是 React 组件。

### 7.2 面板组件会拿到什么 props

Slot 组件会收到三类 props（合并后传入，来自
`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` 的 `standardProps()` 与
`renderEntry()`）：

1. **standard props**（框架注入）：
   - root scope 的 slot 拿到 `{ useSessions, useWorkspaces }`。
   - session scope 额外有 `useProjection`、`sessionId`、以及各 `hooks` 来源合成的
     `use<Name>` selector hook。
   - **`useSessions` 是取当前会话的标准钩子**：
     ```js
     const current = useSessions((s) => s.current);  // 当前 session id
     ```
2. **你的 `inject` 返回值**（上面 `{ remote }`）。
3. **owner props**（父 slot 通过 `renderSlot("...", { wide })` 传的，如 `wide`）。

### 7.3 面板悬浮层技巧

侧边栏 footer 空间很窄，面板要「悬浮」出来。官方 `CordisPanel` 的做法是：
面板组件渲染 `position: fixed` 的 `div`，用 `useSessions` 拿当前会话，用
`document.addEventListener("pointerdown", ...)` 做「点外面关闭」。照抄这个模式即可，
**不要**用 `ReactDOM.createPortal`（`react-dom/client` 是 seed word，但没必要）。

---

## 8. Client → Host 数据通道

这是双端插件最容易踩坑的地方。

### 8.1 结论：复用现成的 `remote.commands`，别自建 Typert remote

- Client→Host 的「干净」通道是 Typert Remote（`harness.handle`/`host.call` 那套是
  **动态插件** cordis_define 专用的，静态 npm 插件用不了）。
- 但静态插件的 Typert remote namespace 是**编译期生成并硬编码**在
  `@deepseek-ai/dsh-api-remotes/lib/client.js` 里的（只有 `commands`、`goals`、
  `fileReferences`、`pluginInventory`、`messageFeedback`、`sessionReferenceResolver`、
  `dynamicCordisRunner` 七个）。自定义插件**无法凭空加 namespace**——除非你自己跑
  Typert 构建流水线产出 `lib/typert.remote-client.js`，那需要完整 monorepo 环境，
  成本极高。
- 所以务实做法是：**复用已挂载的 `remote.commands`**。

### 8.2 用 `remote.commands.execute` 回传数据

Client 端这样调：

```js
// inject 里声明：["slots", "remote", "remote.commands"]
const remote = ctx.remote;                       // remote 服务
const res = await remote.commands.execute(sessionId, line, []);
// res.ok ? res.value.result : res.error
// res.value.result = { kind: "success", text } 或 { kind: "error", text }
```

- `remote.commands.execute(sessionId, line, images)` 的参数和返回值契约，读
  `@deepseek-ai/dsh-api-remotes/lib/client.js` 里 `commands/execute` 的描述符
  （`namespace: "commands"`，scope 是 agent，参数是 `agentId` + `line` + `images`）。
- 这个调用**执行的是 host 命令 handler**，返回 handler 的 `{kind, text}`。
- 面板把查询结果 JSON 塞进命令 `text` 回传，再 `JSON.parse`，就实现了面板↔host 的
  双向数据流，**零自建 RPC**。
- 代价：会记一条 `command/run`/`command/done` 到会话日志。对「查询类」命令（面板
  拉数据）可接受；**不要用这条通道做「驱动 agent 干活」**——那应该走
  `agent.followup()`（第 5 节），因为 `followup` 进模型上下文，`command` 不进。

### 8.3 嵌套服务访问的正确写法

`remote.commands` 是**嵌套服务**（`remote` 服务下的 `commands` namespace）。在
client 半里：

- `inject` 数组同时声明 `"remote"` 和 `"remote.commands"`（`remote.commands` 是独立
  的 service key，cordis 的 associate 机制让 `ctx.remote.commands` 解析到它）。
- 访问写 `ctx.remote.commands.execute(...)`，**不是** `ctx.get("remote").commands`
  （后者拿不到嵌套 namespace）。官方 `ui-commands` 就是这个写法。

---

## 9. 安装与接线

与单端工具插件完全一致（详见 `PLUGIN-DEVELOPMENT-GUIDE.md` 第 7、8 节）：

```powershell
# 方式 A：零依赖直接复制
$src = "D:\git\deepseek-tools\dsh-my-plugin"
$dst = "C:\Users\hxy\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-my-plugin"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
Copy-Item "$src\lib\client.js" "$dst\lib\client.js" -Force
```

然后在 `C:\Users\hxy\.dsh\profiles\web\cordis.patch.yml` 里 insert：

```yaml
- insert:
    - id: my-plugin
      name: '@deepseek-ai/dsh-my-plugin'
```

验证裸名可解析：

```powershell
cd "C:\Users\hxy\.dsh\profiles\web"
node --input-type=module -e "const m = await import('@deepseek-ai/dsh-my-plugin'); console.log(m.name)"
```

---

## 10. 验证：三段冒烟

### 10.1 Host 半冒烟（不重启 DSH）

写 `smoke-test.mjs`，构造假 ctx 直接 `apply()` 并跑 handler（套路见
`PLUGIN-DEVELOPMENT-GUIDE.md` 第 9.1 节）。假 agent 长这样：

```js
const agent = {
  session: { header: { cwd: "F:/work/manager-frontend" } },
  followup(msg) { followups.push(msg); }
};
```

验证：`list`/`overview`/`run` 三个分支的返回、`followup` 是否被触发。

### 10.2 Client 半冒烟（不打开浏览器）

写 `smoke-test-client.mjs`，用 `new Function("window","document","require", code)`
执行 client bundle 源码，用假 `__ModuleLoader__`、假 `react`、假 `slots` 服务驱动
`apply()`，验证：bundle 注册、`inject` 数组、slot 注册成功、组件能渲染。

假 react 只需 `{ createElement, Fragment, useState, useEffect, useLayoutEffect,
useRef, useCallback }`（组件里用到哪个补哪个）。

### 10.3 接线冒烟（真实 host）

```powershell
# 1. 配置 dump 干净（无 error/failed/waiting）
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config

# 2. 真实 host 的 boot graph 已包含你的 client bundle
Invoke-WebRequest "http://127.0.0.1:3080/" -UseBasicParsing
#   → 返回的 HTML 里搜你的插件名，应出现在 __DSH_BOOT__ 的 entries 里

# 3. client bundle 能被 serve
Invoke-WebRequest "http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-my-plugin/client.js" -UseBasicParsing
#   → 200
```

最后**刷新浏览器页面**：`cordis.patch.yml` 受 HMR 监听，boot graph 会热更新，但
**新 client bundle 要页面刷新才会真正加载执行**（HMR 不保证即时，最终以刷新后
面板出现为准）。

---

## 11. 踩坑排查表

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| `declares dsh.client but exports no "./client" bundle` | package.json 缺 `exports["./client"]` | 补上 `"./client": "./lib/client.js"` |
| client bundle 没进 `__DSH_BOOT__` | `dsh.client.platform !== "web"`，或插件没进 profile node_modules / 没在 patch 里接线 | 检查三处：`dsh.client`、node_modules 拷贝、`cordis.patch.yml` 的 insert |
| 浏览器 `require("react")` 报 miss | 把 `react` 写进了 `dsh.client.inject`（它该是 seed word） | 从 inject 里删掉 `react`，直接 `require("react")` |
| 浏览器报 `require("xxx") missed the module table` | 用了非 seed word 且没写进 `dsh.client.inject` 的包 | 确认该包是不是 seed word；不是就加进 inject |
| `service "commands" is not declared` | Host 半用了 `ctx.commands` 但没 `inject: ["commands"]` | 加 inject |
| `service "remote.commands" ...` / `ctx.remote.commands` 是 undefined | 只 `inject` 了 `"remote"` 没 `"remote.commands"`，或用了 `ctx.get("remote").commands` | inject 里两个都声明；访问用 `ctx.remote.commands` |
| 面板组件拿不到 `useSessions` | 把 slot 注册成了 session scope 之外还假设有 session props，或误解了 scope | `sidebar.footer.action` 是 root scope，只能拿 `{useSessions, useWorkspaces}`；当前会话用 `useSessions((s)=>s.current)` |
| 命令结果想进模型但没生效 | 用了 `return {kind:"success", text}` 而不是 `agent.followup()` | 命令结果不进模型；要驱动 agent 必须 `agent.followup(createUserMessage(...))` |
| 面板能拉数据但点「执行」没反应 | 用 `remote.commands.execute` 走的是命令平面，不是模型 | 执行类动作在 host handler 里用 `agent.followup()`，别用命令回传 |
| JSX / `import` / `window.xxx` 报错 | client 半是工厂 bundle，禁这些 | 用 `React.createElement`、`require` seed word、`document` 只在回调里用 |
| `JSON.stringify` 抛错 | 把 host 的 live 对象（session/agent/ctx）塞进返回值 | 命令回传只放纯 JSON 标量/数组，抽取所需字段 |

---

## 12. 参考：本仓库的 dsh-build-panel

完整可运行示例在 `dsh-build-panel/`：

```
dsh-build-panel/
  package.json           # 双端声明：main + exports["./client"] + dsh.client
  lib/index.js           # Host 半：/build 命令 + node:fs 读写 docs/<任务号>/
  lib/client.js          # Client 半：sidebar.footer.action 面板
  smoke-test.mjs         # Host 冒烟
  smoke-test-client.mjs  # Client 冒烟
```

它演示了本指南的每个要点：

- `/build` 命令三个分支：列表（JSON 回传）、详情（JSON 回传）、执行（`agent.followup`）。
- 用 `node:fs/promises` 直接读工作区文件，不碰 sandbox。
- 面板：`sidebar.footer.action` 注册 + `useSessions` 拿会话 + `position: fixed` 悬浮层。
- Client→Host 用 `remote.commands.execute` 回传 JSON，零自建 RPC。
- 把 opencode 的 `build.md` 工作流改写成 `agent.followup` 的指令文本，实现同等效果。
