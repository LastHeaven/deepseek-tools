# DSH 插件开发指南

本文档面向需要为 **DeepSeek Harness（DSH）** 编写新插件的其他 Agent。它记录了从
零开发、打包、安装、启停到验证的完整流程，并以本仓库的 `dsh-tool-firecrawl`
（已改造为标准 bundle 形态）为参考实现。

> 目标读者：需要「照着做就能跑通」的 Agent。每一步都给出可验证的命令和失败排查点。
>
> 本文按 DSH **0.2.2-rc.1** 的实际行为编写，所有结论都来自官方文档或本机源码验证，
> 不是猜测。官方文档入口见文末「参考来源」。

---

## 目录

1. [背景：DSH 插件是什么](#1-背景dsh-插件是什么)
2. [插件形态：裸模块 vs 标准 bundle](#2-插件形态裸模块-vs-标准-bundle)

3. [前置侦察：先摸清环境和真实接口](#3-前置侦察先摸清环境和真实接口)
4. [标准插件包的目录结构](#4-标准插件包的目录结构)
5. [package.json 清单：bundle 的全部声明](#5-packagejson-清单bundle-的全部声明)
6. [`cordis.patch.yml`：bundle 的配置层](#6-cordispatchyml-bundle-的配置层)
7. [插件页元数据：locale 与 icon](#7-插件页元数据locale-与-icon)
8. [插件导出契约](#8-插件导出契约)
9. [配置（Config）与参数 Schema](#9-配置config与参数-schema)
10. [工具注册 `ctx.tools.register`](#10-工具注册-ctxtoolsregister)
11. [安装：`dsh plugin add`](#11-安装dsh-plugin-add)

12. [启用与停用](#12-启用与停用)
13. [验证：三段冒烟](#13-验证三段冒烟)
14. [生效与热重载](#14-生效与热重载)
15. [常见坑与排查表](#15-常见坑与排查表)
16. [参考：本仓库的实现](#16-参考本仓库的实现)

---

## 1. 背景：DSH 插件是什么

DSH 是 DeepSeek Harness，一个基于 **Cordis** 的插件化运行时。一个 profile（如
`web`）由多层 patch 组合而成：

```
空根
  → profile 的 dsh.profile.bundles 列表，按顺序堆叠每个 bundle 的 patch
  → profile 自己的 cordis.patch.yml
  → home 级 $DSH_HOME/cordis.patch.yml（跨 profile，可选）
  → --patch 覆盖层（按 argv 顺序）
```

后应用的层按行胜出，且 **patch 替换目标行的整个 `config`，不是深合并**。

每个「插件」最终都是 Cordis 插件：一个导出 `apply(ctx, config)`（以及可选的
`name`/`inject`/`Config`）的 ESM 模块。模型能调用的工具，由插件在 `apply` 里通过
`ctx.tools.register(...)` 注册。

关键结论：

- **插件必须能被 Node 从 profile 目录解析**。Loader 的 `baseUrl` 是 profile 目录
  （`$DSH_HOME/profiles/<name>/`），模块名通过 Node 的 parent-walk 解析：先找
  `profile/node_modules`，再往上找到 `$DSH_HOME/profiles/node_modules`（这里是一堆
  指向 DSH 安装目录的 junction/symlink，由 `healProfilesModuleFallback` 维护）。
- **DSH 维护的 fallback 只覆盖 DSH 自身的依赖闭包**（`@deepseek-ai/*`、`cordis`、
  `cosmokit`、`schemastery`、`turndown` 等）。你自己插件里的其它 npm 依赖不会自动
  出现在那里。
- **一切注册都是 effect**：插件 fiber 卸载时，`ctx.tools.register`、
  `ctx.systemPrompt.section`、`ctx.on`、`ctx.effect` 注册的东西全部自动撤销。这是
  「可启用停用」能干净工作的根本原因（见第 12 节）。
- 本机关键路径（Windows 环境，供参考）：

  | 内容 | 路径 |
  | --- | --- |
  | DSH 安装（CLI 入口） | `D:\npm\node_global\node_modules\@deepseek-ai\dsh` |
  | DSH home | `C:\Users\hxy\.dsh`（环境变量 `DSH_HOME`） |
  | profile 目录 | `C:\Users\hxy\.dsh\profiles\web` |
  | 插件 fallback | `C:\Users\hxy\.dsh\profiles\node_modules` |
  | 工作区 | `D:\git\deepseek-tools` |

---

## 2. 插件形态：裸模块 vs 标准 bundle

同一个 Cordis 插件，有两种**打包**方式。二者代码完全一样，差别只在「怎么交给 DSH」。

| 形态 | 长什么样 | 安装方式 | 能停用吗 | 出现在插件页 |
| --- | --- | --- | --- | --- |
| **裸模块** | 只有 `package.json` + `lib/index.js` | 手工拷进 `profiles/<p>/node_modules/`，再手改 `cordis.patch.yml` | 只能手改 YAML | 只有技术名 |
| **标准 bundle** | `package.json` 声明 `dsh.bundle` + 自带 `cordis.patch.yml` + locale + icon | `dsh plugin --profile <p> add <spec>` 一步 | ✅ 插件页 / `plugin_manager` / YAML 三种等价路径 | ✅ 有标题、描述、图标 |

**默认应该写成标准 bundle。** 理由：

1. 安装是一条命令，且 `dsh` 自动把包名追加进 `dsh.profile.bundles`，不用手写 profile。
2. 装完以后它是一个**正常可管理的 profile 条目**：Web 侧栏 **Plugins** 页可以开/关，
   `plugin_manager` 工具可以开/关，profile patch 也可以开/关。三种方式写的是同一个
   `disabled` 状态，可逆、可重复。
3. 插件页能显示人类可读的标题、描述、图标，而不是一个裸包名。
4. 卸载是一条命令，依赖和配置层一起走。

什么时候仍然用裸模块：

- 只做**仓库内的临时实验**（`--patch` overlay 直接指向绝对路径）。
- 给别的插件 import 的**库**，不是给用户启用的插件 —— 这种包**不要**声明
  `dsh.bundle`，否则 `dsh plugin` 会把它当成 bundle 追加进 profile 的 bundles 列表。

> 官方原文：没有 `dsh.bundle` 声明的包仍然可以安装，但只作为普通依赖，`dsh plugin`
> 会打印警告，且不激活任何层。

---

## 3. 前置侦察：先摸清环境和真实接口

**不要凭服务名猜 API。** 开发前必做：

1. 确认 profile 与 patch 现状：

   ```powershell
   Get-Content "C:\Users\hxy\.dsh\profiles\web\package.json"
   Get-Content "C:\Users\hxy\.dsh\profiles\web\cordis.patch.yml"
   ```

2. 读一个「同类」**官方**参考插件，照抄其导出形状与清单字段：
   - 纯工具插件：`@deepseek-ai/dsh-tool-web`（`name`/`inject`/`Config`/`apply`）
   - 工具 + 两个 prompt section + `getSectionOrder`：
     `@deepseek-ai/dsh-tool-web` 的 `applyWebSearchTool`
   - **bundle 形态的完整范例**：`@deepseek-ai/dsh-experimental-forge-bundle`
     （清单 + patch + locale + 空 `lib/index.js`）
   - **bundle + client 同一包**：`@deepseek-ai/dsh-experimental-liveshare`
   - 底层 API：`@deepseek-ai/dsh-tools` 的 `lib/index.js`（`defineTool`、schema 规则）

3. 如果要接外部 HTTP 服务（像 Firecrawl 这种），**先逐个端点打探**，确认真实
   路径、版本（`/v1` vs `/v2`）、返回结构，而不是照抄官方 SDK 的假设。

4. 确认模块 fallback 里有没有你要 import 的包：

   ```powershell
   Test-Path "C:\Users\hxy\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools"
   ```

5. 确认当前运行的 DSH 版本（`engines.dsh` 要覆盖它）：

   ```powershell
   dsh --version            # 或读 @deepseek-ai/dsh/package.json 的 version
   ```

---

## 4. 标准插件包的目录结构

```
dsh-tool-myplugin/
  package.json            # 清单：dsh.bundle / exports / files / engines
  cordis.patch.yml        # bundle 的配置层（安装后自动生效）
  lib/
    index.js              # 插件主体（可以被 patch 里的多行复用）
  locale/
    en.json               # 插件页标题/描述（必须有 en）
    zh.json               # 其它语言可选
  icon.svg                # 插件页图标（SVG/PNG/JPEG/WebP，≤256 KiB）
  README.md               # 安装 / 配置 / 启停说明
  smoke-test.mjs          # 离线 + 在线两段冒烟
```

要点：

- **`cordis.patch.yml` 必须被打进 `files`**，否则安装方拿不到配置层：包装上了，
  却永远不挂载 —— 这是最常见的打包遗漏。
- `locale/` 和 `icon.svg` 也要进 `files`，否则插件页没有标题和图标。
- 包根不需要 `dsh.profile`；profile 由 `dsh plugin` 创建和维护，**永远不要手写**。

---

## 5. `package.json` 清单：bundle 的全部声明

最小可用版本（以 `dsh-tool-firecrawl` 为模板）：

```json
{
  "name": "@deepseek-ai/dsh-tool-myplugin",
  "description": "One-sentence summary shown in the Plugins list.",
  "version": "1.0.0",
  "icon": "./icon.svg",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "lib/index.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md"
  ],
  "license": "MIT",
  "keywords": ["dsh", "dsh-plugin", "dsh-bundle", "cordis"],
  "engines": {
    "node": ">=24.9.0",
    "dsh": ">=0.2.0 <0.3.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/schemastery": "*"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### 逐字段说明

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `dsh.bundle.patch` | ✅ | patch 文件路径（相对包根）。**也可以是字符串数组**，按顺序作为同一层应用，每个文件里的相对插件路径相对该文件解析 |
| `dsh.bundle.listedByDefault` | — | `false` 会把该 bundle 从 GUI 默认列表里隐藏，直到用户显式启用；管理清单仍然完整（`liveshare` 就这么用） |
| `dsh.bundle.platforms` | — | 非空的 Node platform 名列表（`["darwin"]` 等）。launcher 和 plugin manager 会在组合/选择前强制执行；省略表示不限平台 |
| `dsh.manifestVersion` | 建议 | 清单格式标识，当前为 `1`，与 npm 包版本、Session 格式版本都无关 |
| `engines.dsh` | 建议 | 声明兼容的 DSH 版本范围。**安装和 profile 启动都会拒绝不满足该范围（含豁免检查）的包** |
| `dsh.client` | 双端插件才要 | 见 `DUAL-FACE-PLUGIN-GUIDE.md`；bundle 与 client 可以声明在同一个包里 |
| `files` | ✅ | 必须包含 `lib/`、`cordis.patch.yml`、`locale/`、`icon.svg` |
| `exports` | 建议 | 至少要给 `.`、`./package.json`、`./cordis.patch.yml`、`./locale/*.json`、`./icon`，`readPluginMeta` 靠这些导出找资源 |

### 兼容性判定的确切规则（容易踩）

`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`：

- **有 `engines.dsh` 时，它单独决定**，`peerDependencies` 里的 dsh 范围完全不看。
- **没有 `engines.dsh` 时**，`peerDependencies` 里所有 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 的**每一个**范围都必须满足运行时版本；`workspace:^`
  `workspace:~` `workspace:*` 视为「指当前运行时」。
- 预发布版本参与范围匹配（`includePrerelease: true`）。

因此本仓库的做法是：**写 `engines.dsh`，同时把 dsh peer 写成 `*`**。这样判定只看
`engines.dsh`，`*` 的 peer 又永远满足，不会出现「装是装上了，启动被判不兼容」。

不兼容时的报错形如：

```
Plugin <name>@<version> is incompatible with dsh <runtimeVersion>:
requirements {"engines.dsh":">=0.3.0"}. Running it may cause crashes or data loss.
```

修复只有两条：改 `engines.dsh`，或用 `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`
做**精确版本**豁免（写进 profile 的 `compatibility.json`）。

---

## 6. `cordis.patch.yml`：bundle 的配置层

<a id="6-cordispatchyml-bundle-的配置层"></a>

这是 bundle 的实质内容：一个顶层 YAML 数组，元素是标准 Loader 配置行。

```yaml
- insert:
    - id: tool-myplugin
      name: '@deepseek-ai/dsh-tool-myplugin'
      config:
        apiUrl: http://service.localhost
        # 其它 Config 字段...
```

要点：

- `name` 写**包名**（不是源码路径）。bundle 装好后由 Node 解析到已安装代码；只有
  本地 `--patch` overlay 调试才写绝对路径。
- `id` 全局唯一，是后续所有层定位该行的 key。
- `config` 直接对应插件的 `Config` schema；缺的字段由 schema 默认值补齐。
- 一个 bundle 可以插入**多行**（`forge-bundle` 就一次插了 6 行 + 一个 group），
  这正是「组合包」的意义。
- `disabled: true` 可以写在这里；也可以用 `!!js` 表达式做条件挂载，例如官方 base：
  `disabled: !!js "!ctx.get('profileContext')"`。
- **配置优先级设计**：patch 会整行替换 `config`，用户可以在自己的 profile patch 里
  覆盖你的行而不碰你的包，所以**默认值要给「用户大概率会保留的值」**，其余交给
  schema 承担。

### 必须写清楚的注释

bundle 的 patch 是安装方唯一能看到的「接线说明书」，注释里至少要说明：

1. 怎么装、怎么启用/停用；
2. 哪些字段是**必填**、占位值是什么、不改会怎样；
3. **密钥不要放这里**，以及它实际从哪来（凭据引用 / 环境变量）；
4. 逐工具开关的用途（与整包停用的区别）。

参考 `dsh-tool-firecrawl/cordis.patch.yml` 与 `dsh-tool-gitlab/cordis.patch.yml`。

---

## 7. 插件页元数据：locale 与 icon

这些文件决定「插件页里长什么样」。DSH 通过 `readPluginMeta(specifier, parentURL)`
读取，**不会执行插件代码**。

### `locale/<lang>.json`

```json
{
  "meta": {
    "title": "Firecrawl",
    "description": "One or two sentences shown under the title."
  }
}
```

规则（来自 `dsh-app-boot` 的 `package-meta` 实现）：

- 先解析 `<specifier>/locale/en.json`，**其它语言文件必须与它同目录**，文件名必须是
  合法的 language id（`zh`、`zh-CN`、`pt-BR` 都可以）。
- `meta.title` / `meta.description` 必须是非空字符串；空串会报元数据诊断。
- 返回值的形状是 `{ en: "…", zh: "…" }`；**英文是必需的回退**，缺失时依次退到
  `package.json` 的 `name`/`description`，最后退到完整 module specifier。
- 可选的 `meta.detail` 指向一个 Markdown 文件（相对包根，必须以 `.md`/`.markdown`
  结尾），作为插件详情页的长文档。没有它则回退到 `README.md`。

### `icon`

两种来源，按优先级：

1. `package.json` 的 `icon` 字段：**相对路径**，必须留在包目录内（realpath 之后检查）。
2. 导出的 `<specifier>/icon` 资源（即 `exports["./icon"]`）。

硬性约束：SVG / PNG / JPEG / WebP，**≤ 256 KiB**，必须是普通文件。读取后会转成
`data:<mime>;base64,…` 存进元数据。

> 用官方品牌资源时：Firecrawl 官网只有 48×48 的 `favicon.png`，做插件图标会糊。
> 正确做法是从站点内联 SVG 里取原始 mark（`viewBox="0 0 600 600"`），去掉
> `<animate>`、把 CSS 变量换成站点实际的品牌色（`--heat-100: #fa5d19`），保留原始
> `transform` 与路径数据，产出 ~2 KB 的静态 SVG。

### 自检

```powershell
cd "D:\npm\node_global\node_modules\@deepseek-ai\dsh"
node --input-type=module -e "
const boot = await import('file:///D:/npm/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const { pathToFileURL } = await import('node:url');
const meta = boot.readPluginMeta('@deepseek-ai/dsh-tool-myplugin', pathToFileURL('C:/Users/hxy/.dsh/profiles/web/package.json').href);
console.log(JSON.stringify({ title: meta.title, icon: meta.icon?.slice(0,32), error: meta.error ?? 'none' }, null, 2));
"
```

期望：`title` 是中英映射、`icon` 是 `data:image/svg+xml;base64,…`、`error: none`。

---

## 8. 插件导出契约

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

  > `inject` 里声明了 `tools`，就**不能**再用 `ctx.get("tools")` 的判空写法混着来 —
  > 二者语义不同。要么 `ctx.get` 判空（软依赖），要么 `inject` + 直接访问（硬依赖）。

- **凭据这类「有就用、没有也能跑」的服务用软依赖**。`dsh-tool-firecrawl` 的写法：

  ```js
  async function resolveApiKey(ctx, config) {
    if (config.apiKey) return config.apiKey;
    const ref = String(config.apiKeyEnv || "FIRECRAWL_API_KEY");
    const credentials = ctx.get("credentials");   // 软依赖
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref);
        if (hit && hit.value) return hit.value;
      } catch { /* 坏引用不能让插件挂掉 */ }
    }
    return process.env[ref] || "";
  }
  ```

  这样：装了凭据存储的项目走存储，没装的退回环境变量；且**不要 memoize**，
  凭据轮换才能下一次调用立即生效。

---

## 9. 配置（Config）与参数 Schema

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

**原则：任何两个部署想设成不同值的量，都必须是配置字段**，不能硬编码。

### 参数 schema 的两条硬规矩

- 每个显式 `object` 必须显式写 `additionalProperties: true` 或 `false`，否则报：

  ```
  JsonSchemaError: parameters.<path>.additionalProperties must be explicitly true or false
  ```

- `timeoutMs` 必须是正的有限数（元数据，不是模型可见 schema）。

支持的类型：`string` / `number` / `integer` / `boolean` / `null` / `array` /
`object` / `json` / `oneOf`。`enum` / `const` 的值必须匹配声明类型。

### 启动期就失败的配置校验

schema 只能表达「自包含约束」。跨字段、或「必须能连上」这类检查要在 `apply` 里做，
并且**在 mount 时做，不要拖到第一次工具调用**：

```js
function apply(ctx, config) {
  assertPositiveInteger("timeoutMs", config.timeoutMs);
  baseUrl(config);   // 空 apiUrl 立刻抛，消息里带修复写法
  ...
}
```

---

## 10. 工具注册 `ctx.tools.register`

注册即生效、随插件 fiber 一起 dispose（插件 stop/update/禁用时自动注销），
**不需要手动清理** —— 这正是「停用干净、重启用同一份配置」的基础。

`execute(args, exec)` 的约定：

- `args` 是校验过的参数。
- `exec.signal` 是协作取消用的 `AbortSignal`，**异步工具必须观测或转发它**。
- 返回值必须是无损 JSON，并匹配 `output.schema`。

### systemPrompt section 的位置

不要随手写 `order: 115` 这种魔法数字。用注册表提供的语义 key：

```js
ctx.systemPrompt.section({
  name: "tool:my_tool",
  order: ctx.systemPrompt.getSectionOrder("TOOL_WEB_FETCH"),
  text: "…",
});
```

已声明的槽位包括 `TOOL_BASH(1000)`、`TOOL_READ(1100)`、`TOOL_WEB_SEARCH(2000)`、
`TOOL_WEB_FETCH(2100)`、`TOOL_SUBAGENT(2800)`…… 同一 order 的多个 section 按名字
排序，是确定性的。冒烟测试用假 ctx 时 `getSectionOrder` 不存在，记得兜底：

```js
let order = 2100;
if (typeof ctx.systemPrompt?.getSectionOrder === "function") {
  try { order = ctx.systemPrompt.getSectionOrder("TOOL_WEB_FETCH"); } catch { /* 旧版注册表 */ }
}
```

`inject` 里要声明 `systemPrompt`。

### 一个真实模式（带 HTTP + 取消 + 认证）

```js
async function requestJson(ctx, config, method, path, body, signal) {
  const init = { method, headers: await makeHeaders(ctx, config), signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl(config) + path, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`firecrawl ${method} ${path} failed (HTTP ${res.status}): ${...}`);
  return data;
}
```

注意 `makeHeaders` 是 async 的（要解析凭据），所以 `requestJson` 也必须 async。

---

## 11. 安装：`dsh plugin add`

`dsh plugin --profile <name> <args...>` 把参数转发给 profile 目录里的 pnpm，
所以所有 pnpm 动词都可用。区别只在于：`dsh` 会在安装成功后把**声明了
`dsh.bundle` 的包**追加进 profile 的 `dsh.profile.bundles`。

### 从本地 checkout 安装（开发期主用）

```powershell
dsh plugin --profile web add D:/git/deepseek-tools/dsh-tool-myplugin
```

预期行为（已本机验证）：

1. 首次使用会初始化 profile（`@deepseek-ai/dsh-base` 作为第一个 bundle）。
2. pnpm 把 checkout 以 `link:` 形式写进 profile 依赖。
3. 包名进入 `dsh.profile.bundles`：

   ```json
   {
     "name": "dsh-profile-fctest",
     "private": true,
     "dependencies": {
       "@deepseek-ai/dsh-tool-firecrawl": "link:D:/git/deepseek-tools/dsh-tool-firecrawl"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-tool-firecrawl"]
       }
     }
   }
   ```

4. `--dump-config` 里出现该 bundle 的层：

   ```
   # == @deepseek-ai/dsh-tool-firecrawl
   - id: tool-firecrawl
     name: '@deepseek-ai/dsh-tool-firecrawl'
     config:
       apiUrl: http://firecrawl.localhost
       ...
   ```

### 从 registry 安装（发布后）

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-tool-myplugin
```

### 从 GitHub 安装的构建坑

git 安装拉的是**源码不是构建产物**，不会替你跑 `build`：

- 作者要提供 `prepare` 脚本（pnpm 在 git 安装后执行），且必须自包含，不能假设旁边
  有 monorepo。
- pnpm ≥10 默认不跑 git 依赖的 `prepare`，第一次 `add` 会失败；按提示把 pnpm 打印的
  包键写进 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-tool-myplugin: true
  ```

  这等于**授权该包的代码在安装时于你机器上执行**，只对可信源码授权，并用
  `#<sha>` 锁提交。

> 我们的插件是纯 ESM、无构建步骤，所以两种方式都不需要 build 授权。

### 卸载

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-tool-myplugin
```

依赖和配置层一起移除。

### 开发期的快速回路（不安装）

只想验证代码、不想走 pnpm 时，用 `--patch` overlay 指向绝对路径：

```powershell
dsh web --patch ./scratch-plugin/cordis.yml
```

```yaml
- insert:
    - id: myplugin
      name: 'D:/git/deepseek-tools/dsh-tool-myplugin/lib/index.js'
```

**这只适合调试**：没有 bundle 层、没有插件页元数据、重启即失效。要交付就走 `add`。

---

## 12. 启用与停用

bundle 装好之后就是**普通 profile 条目**，三条等价路径写的是同一个 `disabled` 状态：

| 界面 | 操作 |
| --- | --- |
| Web 侧栏 → **Plugins** | 直接切换该行 |
| Agent 的 `plugin_manager` 工具 | 会话里切换（需要 `danger-full-access` 或当次审批） |
| profile 的 `cordis.patch.yml` | 加一行 `- id: <id>` + `disabled: true` |

实现细节（来自 plugin-manager 的文档）：

- 切换只改 profile patch 里**最后一条匹配覆盖行**的 `disabled`，没有就追加一条。
- 如果一条只含 `id` + `disabled` 的覆盖行，在 bundle 层和剩余 profile patch 下已经
  是目标状态，**这一行会被删掉、也不追加** —— 所以 profile patch 只记录「与 bundle
  默认态的偏离」。
- 停用 **保留依赖和配置**，重新启用时原样恢复（启用会把 bundle 追加到列表末尾，
  这会改变层优先级，注意）。
- 有 HMR 时即时生效；没有 HMR 时返回 `restart-required`，下次启动生效。

### 整包停用 vs 逐工具开关

两者解决不同问题，别混：

| 手段 | 关掉什么 | 什么时候用 |
| --- | --- | --- |
| **停用 bundle** | fiber 卸载，所有工具、prompt section、工具声明全部消失 | 这个部署不需要 Firecrawl |
| **`config.scrape: false` 之类** | 只少注册那一个工具（和它的 section） | 需要搜索、但禁止爬取等细粒度策略 |

两者都是 effect-based，不会残留注册。

---

## 13. 验证：三段冒烟

### 13.1 离线：打包契约 + 注册（不联网、不重启）

`smoke-test.mjs` 这一段是**打包回归测试**，它会在下列情况失败：

- `files` 不再包含 `cordis.patch.yml` / `locale/*.json` / `icon.svg`
- patch 行不再按包名引用本包、或 id 变了
- `Config` 少了一个默认值
- 某个逐工具开关不再摘掉对应工具
- `apiUrl` 为空时不再在 mount 期报错

```js
const config = Config({ apiUrl, apiKeyEnv: DEFAULT_API_KEY_ENV });   // 模拟 loader 归一化
const registered = [];
const ctx = {
  tools: { register(def) { registered.push(def); return () => {}; } },
  systemPrompt: { section() { return () => {}; } },
  get: () => undefined,          // 凭据 seam 缺席
};
apply(ctx, config);
```

> 关键：`apply` 直接用（跳过 loader）时**默认值不会自动补齐**。要么手动传完整
> config，要么像上面这样先跑一遍 `Config(...)`。后者更接近真实行为。

### 13.2 离线：插件页元数据

用 `readPluginMeta` 验证 locale 与 icon（见第 7 节的自检脚本）。

### 13.3 安装链路（一次性，用临时 DSH_HOME）

不改动你正在用的 profile：

```powershell
$tmp = Join-Path $env:TEMP ("dsh-fc-test-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:DSH_HOME = $tmp
dsh plugin --profile t add "D:/git/deepseek-tools/dsh-tool-myplugin"
dsh --profile t --dump-config            # 应出现 "# == <包名>" 层
```

验证停用：往 `$tmp/profiles/t/cordis.patch.yml` 写

```yaml
- id: tool-myplugin
  disabled: true
```

再 `--dump-config`，该行应带上 `disabled: true`。测完删掉整个临时目录。

### 13.4 在线：真实服务

真实网络调用单独开关，避免没有服务时跑不了：

```powershell
$env:FIRECRAWL_SMOKE_LIVE = '1'
node smoke-test.mjs
```

### 13.5 配置 dump 与健康检查

```powershell
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
Invoke-WebRequest "http://127.0.0.1:3080" -UseBasicParsing -TimeoutSec 10
```

`--dump-config` 混排 stdout/stderr，PowerShell 下可能看到 `[exit code: 1]`，那是
`NativeCommandError` 的假阳性，**看输出内容判断**，别看退出码。

---

## 14. 生效与热重载

- `cordis.patch.yml` 受 HMR 监听：保存后通常无需重启。
- **热重载不保证即时/必然成功**。最终以「下一轮对话里能看到新工具、且跑一次能出
  结果」为准。没生效就重启 profile：

  ```powershell
  dsh --profile web
  ```

- 换了 `lib/index.js` 之后，**重启是最可靠的路径**（HMR 会重新 import，但新
  `lib/` 文件的加载时机不如重启确定）。
- 工具名就是插件里注册的 `name`，**没有额外前缀**（MCP 工具才会带
  `mcp__<server>__`）。
- 客户端 bundle 要**刷新页面**才会真正加载执行。

---

## 15. 常见坑与排查表

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| 装上了但插件页没有、模型也看不到工具 | `files` 里漏了 `cordis.patch.yml` | 补进 `files`，重装 |
| 插件页只显示裸包名、没有标题/图标 | `files`/`exports` 漏了 `locale/`、`icon` | 补 `locale/*.json`、`icon.svg`、`exports["./icon"]` |
| `declares dsh.client but exports no "./client" bundle` | 双端包缺 `exports["./client"]` | 见 `DUAL-FACE-PLUGIN-GUIDE.md` |
| `Plugin X@Y is incompatible with dsh Z` | `engines.dsh` 没覆盖运行时，或某条 dsh peer 范围不满足 | 改范围；或用 `allow-version` 做精确版本豁免 |
| 明明 `dsh plugin add` 成功，`--dump-config` 里没有这一层 | 包没声明 `dsh.bundle`（被当成普通依赖，`dsh plugin` 只发警告） | 补 `dsh.bundle.patch` |
| `JsonSchemaError: ...additionalProperties must be explicitly true or false` | `parameters` 里的 `object` 没写 `additionalProperties` | 每个显式 `object` 补上 |
| `defineTool(...): timeoutMs must be a positive finite number` | `timeoutMs` 非正或非有限 | 改成正整数 |
| `Cannot find package '@deepseek-ai/xxx'` | 插件没进 profile 的 node_modules，或 import 了不在 fallback 里的第三方包 | 用 `dsh plugin add`；第三方依赖走 pnpm |
| 裸名 import 失败但绝对路径成功 | 没从 profile 目录解析 | 确认已安装到 `profiles/<p>/node_modules/@deepseek-ai/<pkg>` |
| `service "x" is not declared` | 用了 `ctx.x` 但没 `inject: ['x']` | 加 inject，或改 `ctx.get('x')` + 判空 |
| 工具注册了但模型看不到 | patch 没接线 / id 冲突被覆盖 / HMR 没生效 | 看 dump-config；重启 |
| patch 改了没反应 | HMR 未捕获，或改的是 home 层 | 确认文件路径；重启 |
| `!!js` 表达式报错 | YAML `!!js` 语法或作用域不对 | 参考官方 patch 里的 `!!js process.platform === 'win32'` |
| 异步工具卡死 | 没转发 `exec.signal` | execute 里把 signal 传给 fetch/子进程 |
| 密钥轮换后仍旧用旧值 | 把凭据结果 memoize 了 | 每次调用重新 `credentials.resolve(ref)` |
| `--dump-config` 退出码 1 | PowerShell 把 stderr 当错误 | 看内容，不看退出码 |
| 旧插件残留 | 停用时只删了工具注册，没走 fiber 卸载 | 用 `disabled` / 卸载插件，别手写清理逻辑 |

---

## 16. 参考：本仓库的实现

### `dsh-tool-firecrawl/` —— 标准 bundle 参考实现

```
dsh-tool-firecrawl/
  package.json        # dsh.bundle + manifestVersion + engines + icon + exports/files
  cordis.patch.yml    # bundle 层：一行 tool-firecrawl，含安装/启停/密钥/开关说明
  locale/en.json      # 插件页标题与描述
  locale/zh.json
  icon.svg            # Firecrawl 官方品牌 mark（静态化，~2.2 KB）
  lib/index.js        # name/inject/Config/apply + 7 个 defineTool
  smoke-test.mjs      # 离线契约 + 逐工具开关 + FIRECRAWL_SMOKE_LIVE 在线段
  README.md           # 工具清单 / 配置表 / 安装 / 启停 / 已知限制
```

它演示了本指南的每个要点：bundle 清单、bundle 层、插件页元数据、`engines.dsh`、
软依赖凭据 seam、`getSectionOrder` 语义位置、逐工具开关、mount 期校验、三段冒烟。

### `dsh-tool-gitlab/` —— 需要必填部署参数的 bundle

`apiUrl` 由 schema `required()`，bundle patch 里放占位值；未配置时启动期即报错。
17 个工具、写操作与只读操作的 `isConcurrencySafe` 区分、`tokenEnv` 凭据引用都在这里。

### 其它仍是裸模块的插件

`dsh-tool-context7`、`dsh-tool-jenkins`、`dsh-tool-tourmind`、`dsh-tool-vision`、
`dsh-tool-wecom`、`dsh-ask-popup`、`dsh-build-panel` 目前都还是「裸模块」形态
（只有 `package.json` + `lib/`，靠手工拷贝激活）。要交付给别人的话，按第 4～7 节
补上 `cordis.patch.yml`、`locale/`、`icon.svg`，并在 `package.json` 里加
`dsh.bundle` / `engines.dsh` / 完整 `exports`，即可升级为标准 bundle。

> 迁移时注意：`files` 必须包含新文件；如果该包之前是以裸模块拷进 profile 的，
> 用 `dsh plugin add` 重装一次，让 `dsh.profile.bundles` 里出现它，否则它仍然只是
> 一个「被 patch 引用的模块」，插件页无法管理。

---

## 参考来源

- [Architecture（profiles & bundles）](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
- [Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Plugin configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)
- [Your first plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)
- [Plugins and lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)
- [Tool authoring reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)
- [Package manifest types](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/package-manifest/README.md)
- [Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)
- 本机源码：`@deepseek-ai/dsh-app-boot`（`readPluginMeta`、`evaluatePluginCompatibility`）、
  `@deepseek-ai/dsh-system-prompt`（`SECTION_ORDERS` / `getSectionOrder`）、
  `@deepseek-ai/dsh-plugin-detail`（`meta.detail` 文档顺序）。
