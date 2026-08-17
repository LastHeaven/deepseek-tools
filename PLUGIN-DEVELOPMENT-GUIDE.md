# DSH 插件开发指南

本文档面向需要为 **DeepSeek Harness（DSH）** 编写新插件的其他 Agent。它记录了从
零开发、安装、接线到验证的完整流程，并以 `dsh-tool-firecrawl`（本仓库已实现的
Firecrawl 原生工具插件）为参考实现。

> 目标读者：需要「照着做就能跑通」的 Agent。每一步都给出可验证的命令和失败排查点。

---

## 目录

1. [背景：DSH 插件是什么](#1-背景dsh-插件是什么)
2. [前置侦察：先摸清环境和真实接口](#2-前置侦察先摸清环境和真实接口)
3. [最小插件结构](#3-最小插件结构)
4. [插件导出契约](#4-插件导出契约)
5. [配置（Config）与参数 Schema](#5-配置config与参数-schema)
6. [工具注册 `ctx.tools.register`](#6-工具注册-ctxtoolsregister)
7. [安装：把插件放进 profile 的 node_modules](#7-安装把插件放进-profile-的-node_modules)
8. [接线：编辑 `cordis.patch.yml`](#8-接线编辑-cordispatchyml)
9. [验证：冒烟测试 + 配置 dump](#9-验证冒烟测试--配置-dump)
10. [生效与热重载](#10-生效与热重载)
11. [常见坑与排查表](#11-常见坑与排查表)
12. [参考：本仓库的 dsh-tool-firecrawl](#12-参考本仓库的-dsh-tool-firecrawl)

---

## 1. 背景：DSH 插件是什么

DSH 是 DeepSeek Harness，一个基于 **Cordis** 的插件化运行时。一个 profile（如
`web`）由多层 patch 组合而成：

```
bundle 层（@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app 等）
  → profile 自己的 cordis.patch.yml
  → home 级 $DSH_HOME/cordis.patch.yml（跨 profile，可选）
  → --patch 覆盖层
```

每个「插件」最终都是 Cordis 插件：一个导出 `apply(ctx, config)`（以及可选的
`name`/`inject`/`Config`）的 ESM 模块。模型能调用的工具，由插件在 `apply` 里通过
`ctx.tools.register(...)` 注册。

关键结论（决定了整个开发姿势）：

- **插件必须能被 Node 从 profile 目录解析**。Loader 的 `baseUrl` 是 profile 目录
  （`$DSH_HOME/profiles/<name>/`），模块名通过 Node 的 parent-walk 解析：先找
  `profile/node_modules`，再往上找到 `$DSH_HOME/profiles/node_modules`（这里是一堆
  指向 DSH 安装目录的 junction/symlink，由 `healProfilesModuleFallback` 维护）。
- **DSH 维护的 fallback 只覆盖 DSH 自身的依赖闭包**（`@deepseek-ai/*`、
  `cordis`、`cosmokit`、`schemastery`、`turndown` 等）。你自己插件里的其它 npm
  依赖不会自动出现在那里 —— 见 [第 7 节](#7-安装把插件放进-profile-的-node_modules)。
- **patch 是整行替换，不是深合并**：后写的一行会替换目标 id 的整个 `config`。
- **`cordis.patch.yml` 受 HMR 监听**，改动会热重载（无需重启，但不保证即时生效）。

本机关键路径（Windows 环境，供参考，你的环境可能不同）：

| 内容 | 路径 |
| --- | --- |
| DSH 安装（CLI 入口） | `D:\npm\node_global\node_modules\@deepseek-ai\dsh` |
| DSH home | `C:\Users\hxy\.dsh`（环境变量 `DSH_HOME`） |
| profile 目录 | `C:\Users\hxy\.dsh\profiles\web` |
| 插件 fallback | `C:\Users\hxy\.dsh\profiles\node_modules` |
| 工作区 | `D:\git\deepseek-tools` |

---

## 2. 前置侦察：先摸清环境和真实接口

**不要凭服务名猜 API。** 开发前必做：

1. 确认 profile 与 patch 现状：

   ```powershell
   Get-Content "C:\Users\hxy\.dsh\profiles\web\package.json"
   Get-Content "C:\Users\hxy\.dsh\profiles\web\cordis.patch.yml"
   ```

2. 读一个「同类」参考插件，照抄其导出形状。工具类插件参考
   `@deepseek-ai/dsh-tool-web`（在 DSH 的 `node_modules` 里，导出
   `name`/`inject`/`Config`/`apply`）；底层 API 参考
   `@deepseek-ai/dsh-tools` 的 `lib/index.js`（`defineTool`、schema 规则）。

3. 如果要接外部 HTTP 服务（像 Firecrawl 这种），**先逐个端点打探**，确认真实
   路径、版本（`/v1` vs `/v2`）、返回结构，而不是照抄官方 SDK 的假设。用
   `Invoke-WebRequest` 或 Node 的 `fetch` 探针。

4. 确认模块 fallback 里有没有你要 import 的包：

   ```powershell
   Test-Path "C:\Users\hxy\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools"
   ```

---

## 3. 最小插件结构

一个插件就是两个文件：

```
my-plugin/
  package.json
  lib/
    index.js
```

### `package.json`

```json
{
  "name": "@deepseek-ai/dsh-tool-myplugin",
  "description": "...",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "files": ["lib/index.js"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/schemastery": "*",
    "@deepseek-ai/dsh-tools": "*"
  }
}
```

要点：

- `"type": "module"`，源码用 ESM（`import`/`export`），因为 loader 用动态
  `import()` 加载。
- `peerDependencies` 声明你 import 的 `@deepseek-ai/*` 包。它们**不**随插件安装，
  而是靠 DSH 的 fallback 解析 —— 这正是「零依赖可运行」的前提。
- **不要**在这里写会新增 npm 安装的 `dependencies`，除非你准备走完整的 pnpm 安装
  流程（见第 7 节）。

---

## 4. 插件导出契约

`lib/index.js` 必须导出一个对象（或 default），包含：

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 诊断用插件名，如 `"tool-firecrawl"` |
| `inject` | `string[]` | 硬依赖的服务名；缺失会让插件进入 waiting |
| `Config` | schemastery `z.object` | 可选，声明配置 schema（带默认值） |
| `apply(ctx, config)` | 函数 | 插件主体，注册工具/服务/事件/UI |

最小骨架：

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-myplugin";
const inject = ["tools"];

const Config = z.object({
  enabled: z.boolean().default(true),
});

function apply(ctx, config) {
  if (!config.enabled) return;
  // 注册工具、服务、事件等
}

export { Config, apply, inject, name };
```

### 依赖注入的正确姿势

- **可选能力**用 `ctx.get(name)` 并判空：

  ```js
  const tools = ctx.get("tools");
  if (tools === undefined) return; // 能力缺席，优雅退出
  ```

- **硬依赖**才写进 `inject`，且只在 `apply` 里通过 `ctx.<name>` 访问：

  ```js
  const inject = ["tools", "systemPrompt"];
  function apply(ctx, config) {
    ctx.tools.register(...);   // OK：inject 里声明过
    ctx.systemPrompt.section(...);
  }
  ```

  > 注意：`inject` 里声明了 `tools`，就**不能用** `ctx.get("tools")` 的判空写法
  > 混着来 —— 二者语义不同。要么 `ctx.get` 判空（软依赖），要么 `inject` + 直接
  > 访问（硬依赖）。工具类插件通常硬依赖 `tools`。

---

## 5. 配置（Config）与参数 Schema

### Config：用 schemastery 的 `z.object`

```js
const Config = z.object({
  apiUrl: z.string().default("http://firecrawl.localhost"),
  apiKey: z.string().default(""),
  timeoutMs: z.number().default(60000),
  searchMaxResults: z.number().default(8),
});
```

Loader 会在 `apply` 前用 `Config` 归一化 patch 里的 `config`，默认值自动补齐。
`apply(ctx, config)` 收到的就是已归一化的对象。

### 工具参数 schema：`defineTool` 的 DSL

`defineTool` 接收 `parameters`（参数对象）+ `output.schema`（输出值）。

```js
ctx.tools.register(defineTool({
  name: "my_tool",
  description: "...",
  parameters: {
    query: { type: "string", required: true, description: "..." },
    limit: { type: "number", description: "..." },
    kind: { type: "string", enum: ["a", "b"] },
  },
  output: {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  },
  async execute(args, exec) {
    return `result for ${args.query}`;
  },
}));
```

Schema 规则（**踩过坑**，务必记住）：

- 支持 `string` / `number` / `integer` / `boolean` / `null` / `array` /
  `object` / `json` / `oneOf`。
- **每个显式 `object` 必须显式写 `additionalProperties: true` 或 `false`**，否则
  报 `JsonSchemaError: parameters.<path>.additionalProperties must be explicitly
  true or false`。参考 `dsh-tool-goal` 的写法，它每个 `object` 都带了
  `additionalProperties: false`。
- `enum` / `const` 的值必须匹配声明类型。
- 没有默认值注入；没有 `properties` 的开放对象、没有 `items` 的数组只做容器校验。
- `timeoutMs` 必须是正的有限数（元数据，不是模型可见 schema）。

### 输出（output）

`output.schema` 描述 execute 的返回值。`output.render(args, value)` 把值转成
`[{ type: "text", text }]` 列表 —— 这是模型看到的内容。

可选增强：

- `output.presentationMeta(args, value)`：给 UI 回放用的结构化元数据。
- `presentCall(args)` / `presentResult(args, result)`：工具自己声明 UI 卡片意图，
  返回 `undefined` 则走通用卡片。
- `finalizeContent(exec, result)`：同步地最终改写 `content`。
- `isConcurrencySafe(args)`：返回 `true` 才允许并行执行；否则独占。

### 系统提示词（可选但推荐）

给模型一段工具使用指引：

```js
ctx.systemPrompt.section({
  name: "tool:my_tool",
  order: 115,
  text: "Use the my_tool tool to ...",
});
```

需要 `inject` 里声明 `systemPrompt`。

---

## 6. 工具注册 `ctx.tools.register`

注册即生效、随插件 fiber 一起 dispose（插件 stop/update 时自动注销），**不需要
手动清理**。

`execute(args, exec)` 的约定：

- `args` 是校验过的参数。
- `exec.signal` 是协作取消用的 `AbortSignal`，**异步工具必须观测或转发它**，并在
  自己工作停止后再 settle。
- 返回值必须是无损 JSON（能 `JSON.stringify`，无 `undefined`/`BigInt`/循环引用），
  并匹配 `output.schema`。

一个带 HTTP 调用 + 取消 + 输出裁剪的真实模式（摘自 firecrawl 插件）：

```js
async function requestJson(config, method, path, body, signal) {
  const res = await fetch(baseUrl(config) + path, {
    method,
    headers: makeHeaders(config),
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
    signal,
  });
  const text = await res.text();
  // ... 解析 + 非 2xx 抛错
}
```

---

## 7. 安装：把插件放进 profile 的 node_modules

有两种方式。**默认用方式 A**（快、可控、零网络）。

### 方式 A：直接复制到 profile 的 node_modules（推荐）

把插件目录拷进 `$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/<包名>/`，
让 Node 能从 profile 目录解析它：

```powershell
$src = "D:\git\deepseek-tools\dsh-tool-myplugin"
$dst = "C:\Users\hxy\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-tool-myplugin"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
```

前提：你的插件**零运行时 npm 依赖**（只 import `@deepseek-ai/*` 和 Node 内置
模块）。这是最省事、最不容易出错的方式。

验证裸名可解析：

```powershell
# 在 profile 目录下跑
node --input-type=module -e "const m = await import('@deepseek-ai/dsh-tool-myplugin'); console.log(m.name)"
```

### 方式 B：pnpm 安装（有外部 npm 依赖时）

如果插件需要 `@deepseek-ai/*` 以外的第三方包，必须让 pnpm 管：

```powershell
dsh plugin --profile web add <你的包>
```

或手动进 profile 目录 `pnpm add <pkg>`（profile 是 pnpm workspace，
`nodeLinker: hoisted`）。这时插件会进 profile 的 `package.json` dependencies，
由 pnpm 解析到 `profiles/web/node_modules`，并且它自己的依赖也会一起落地。

> 判定：**只要插件 import 的都是 `@deepseek-ai/*` + Node 内置模块，就用方式 A**。
> 一旦 import 了 `axios`、`zod` 这类第三方包，就走方式 B（并确认这些包不在 DSH
> fallback 里）。

---

## 8. 接线：编辑 `cordis.patch.yml`

在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里 `insert` 一行：

```yaml
- insert:
    - id: tool-myplugin
      name: '@deepseek-ai/dsh-tool-myplugin'
      config:
        apiUrl: http://firecrawl.localhost
        # 其它 Config 字段...
```

要点：

- `id` 全局唯一，是后续 patch 定位该行的 key。
- `name` 是模块 specifier，`@deepseek-ai/dsh-tool-myplugin` 这种裸名靠第 7 节的
  node_modules 解析。
- `config` 直接对应插件的 `Config` schema；缺的字段由默认值补齐。
- 想**替换**已有插件：再写一个同 `id` 的条目，整行 `config` 会被覆盖（不是合并）。
- 想**禁用**：给条目加 `disabled: true`。禁用不会移除行，只是不启动。
- 想**临时回滚**旧实现：旧行加 `disabled: true`、新行启用，两者并存。

完整例子（本仓库 firecrawl 的接线）：

```yaml
- insert:
    - id: tool-firecrawl
      name: '@deepseek-ai/dsh-tool-firecrawl'
      config:
        apiUrl: http://firecrawl.localhost
```

---

## 9. 验证：冒烟测试 + 配置 dump

### 9.1 独立冒烟测试（脱离 DSH 直接驱动插件）

写一个 `smoke-test.mjs`，构造一个**假 ctx**，直接 `apply()` 并逐个跑
`execute()`。这样能在不重启 DSH 的情况下验证插件逻辑：

```js
const { apply, name, inject } = await import(
  "file:///C:/Users/hxy/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tool-myplugin/lib/index.js"
);

const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
};

apply(ctx, { /* config */ });

console.log("name:", name, "| inject:", JSON.stringify(inject));
console.log("registered:", registered.map((t) => t.name).join(", "));

const signal = AbortSignal.timeout(30000);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const out = await byName.my_tool.execute({ query: "..." }, { signal });
console.log(String(out).slice(0, 500));
```

> 注意：`apply` 直接用（跳过 loader）时，**默认值不会自动补齐** —— 手动传完整
> config，或自己套一层默认值。loader 才负责用 `Config` 归一化。

### 9.2 配置 dump（验证接线正确、无报错）

```powershell
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
```

看输出里有没有你的 `id`、`name`、`config`，以及有没有 `error`/`failed`。

### 9.3 健康检查

```powershell
Invoke-WebRequest "http://127.0.0.1:3080" -UseBasicParsing -TimeoutSec 10
```

---

## 10. 生效与热重载

- `cordis.patch.yml` 受 HMR 监听：保存后 DSH 会热重载，通常无需重启。
- **但热重载不保证即时/必然成功**。最终以「下一轮对话里能看到新工具、且跑一次能
  出结果」为准。若没生效，重启 profile：

  ```powershell
  # 停掉当前 web 进程后
  dsh --profile web
  ```

- 工具名就是插件里注册的 `name`，**没有额外前缀**（原生插件 vs MCP 插件的区别：
  MCP 工具会带 `mcp__<server>__` 前缀，原生插件不会）。

---

## 11. 常见坑与排查表

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| `JsonSchemaError: ...additionalProperties must be explicitly true or false` | `parameters` 里的 `object` 没写 `additionalProperties` | 每个显式 `object` 补 `additionalProperties: true/false` |
| `defineTool(...): timeoutMs must be a positive finite number` | `timeoutMs` 非正或非有限 | 改成正整数 |
| `Cannot find package '@deepseek-ai/xxx'` / 加载失败 | 插件没进 profile 的 node_modules，或 import 了不在 fallback 里的第三方包 | 方式 A 复制；第三方依赖改方式 B |
| 裸名 import 失败但绝对路径成功 | 没从 profile 目录解析（baseUrl 不对） | 确认插件在 `profiles/<name>/node_modules/@deepseek-ai/<pkg>` |
| `service "x" is not declared` | 用了 `ctx.x` 但没 `inject: ['x']` | 加 inject，或改 `ctx.get('x')` + 判空 |
| 工具注册了但模型看不到 | patch 没接线 / id 冲突被覆盖 / HMR 没生效 | 看 dump-config；重启 profile |
| patch 改了没反应 | HMR 未捕获，或改的是 home 层 | 确认文件路径；重启 |
| `!!js` 表达式报错 | YAML `!!js` 语法或作用域不对 | 见 bundle patch 里的 `!!js process.platform === 'win32'` 等范例 |
| 异步工具卡死 | 没转发 `exec.signal` | execute 里把 signal 传给 fetch/子进程 |

---

## 12. 参考：本仓库的 dsh-tool-firecrawl

完整可运行示例在本仓库 `dsh-tool-firecrawl/`：

```
dsh-tool-firecrawl/
  package.json      # 零依赖 ESM 包，peer 依赖 @deepseek-ai/*
  lib/index.js      # name/inject/Config/apply + 7 个 defineTool 注册
  smoke-test.mjs    # 假 ctx 冒烟测试
  README.md         # 工具清单 / 端点 / 配置表
```

另一个同类示例是 `dsh-tool-context7/`，它演示如何**把原本接 MCP 的能力改写成原生
插件**：删掉 `cordis.patch.yml` 里的 `mcp-context7`（`@deepseek-ai/dsh-mcp-client`
streamable-http 条目），改为注册 `tool-context7` 原生插件，直接 `fetch` 调
Context7 的 REST API（`/v2/libs/search`、`/v2/context`），不带 `mcp__` 前缀。
工具名为 `context7_resolve_library_id` / `context7_query_docs`。

它们演示了本指南的每个要点：

- `Config`（`apiUrl`/`apiKey`/逐工具开关/超时/上限）
- `defineTool` 的参数 schema（含 `enum`、带 `additionalProperties` 的嵌套 object）
- `execute` 里 `fetch` + `exec.signal` 协作取消 + 非 2xx 抛错
- 输出渲染与 `maxOutputChars` 裁剪
- `isConcurrencySafe: () => true`（只读工具可并行）
- `systemPrompt.section` 指引
- 对自托管实例缺失能力的降级（`developer_search` 404 → 降级到 web search）

开发新插件时，建议直接复制 `package.json` + 骨架，替换工具定义即可。
