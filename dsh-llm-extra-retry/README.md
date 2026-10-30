# @local/dsh-llm-extra-retry

给 DSH 的模型请求补上**官方重试策略没覆盖的那一类失败**的自动重试。

## 它解决什么

`@deepseek-ai/dsh-llm-retry` 会在「durable agent-step 边界」重试失败的模型请求，
但只重试 provider `retryPolicy` 声明的错误码。未声明时用的是 provider 中立默认集合：

```
EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT
```

pi-ai 适配器把所有**没认出来**的错误都归类成兜底的 `PI_AI_ERROR`
（`dsh-llm-pi-ai/lib/index.js` 的 `classifyPiAiError`）。当 SSE 响应体在中途被截断时，
上游通常只报一句：

```
PI_AI_ERROR  "stream read error: unexpected EOF"
```

分类器只把 `stream ended before/without …`、`terminated`、`premature close`、
或提到 connection / socket 的措辞映射成 `TRANSPORT`，`unexpected EOF` 不在其中。
于是错误码是 `PI_AI_ERROR` —— 不在可重试集合里 —— 本轮直接以红色
「本轮运行失败」结束，尽管再发一次请求几乎一定能成功。

这个插件补上这一格：

- 失败码在 `codes`（默认只有 `PI_AI_ERROR`）里 **且**
- 失败消息命中 `messagePatterns` 里任一子串（大小写不敏感）

时，按有界、带抖动、可取消的退避等待后返回 `{ kind: "retry" }`。agent loop 会在
**同一个未结束的 turn 内**、在**同一份 durable 历史**上重跑该 step —— 与内置执行器
完全一样的语义。

**不会**无脑重试所有 `PI_AI_ERROR`：像
`pi-ai deferred response … is not supported`、`stream … ended pending` 这类永久性
失败，只要不命中你配置的模式，就照旧交给 loop 处理。

## 它挂在哪

`agent/request-error` waterfall —— 与 `dsh-llm-retry`、
`dsh-compaction-image-offload` 相同的扩展点：

```ts
'agent/request-error'(
  payload: { agent; turn; step; provider; failure: LlmFailure; retryPolicy; signal },
  next: () => Promise<{ kind: 'retry' } | undefined>,
): Promise<{ kind: 'retry' } | undefined>
```

监听器**先问下游**（`await next()`）：如果下游（例如挂载早于本插件的
`dsh-llm-retry`）已经给出了 `retry` 决定，就直接采用，不叠加自己的等待。所以两者
可以任意先后挂载，内置执行器对自己那批错误码的预算保持不变。

## 预算与取消

- 预算按 **session + turn + step** 记账，新的 step 重新计数；总次数不超过
  `maxRetries`。用完后再失败就原样抛给 loop，不会无限重试。
- 等待是可取消的：用户中断本轮、或插件被卸载（dispose）时，等待立刻结束且**不**
  返回 retry，turn 以没有本插件时的同样方式收尾。
- 上游若给了合法的 `Retry-After`（`failure.providerRetryAfterMs`），优先用它，
  并被 `maxDelayMs` 截断。
- 本插件**不写任何会话事件**：重试后的 attempt 不会进入模型可见历史。框架自己的
  `llm/retry` / `llm/retry-started` 记录仍由 `dsh-llm-retry` 负责。重启后预算归零，
  不会有残留状态。

## 配置

在 profile 的 `cordis.patch.yml` 里按行覆盖即可（`config` 是整行替换，不是深合并）：

```yaml
- id: llm-extra-retry
  config:
    enabled: true
    codes: [PI_AI_ERROR]
    messagePatterns:
      - unexpected eof
      - stream read error
      - eof
      - connection reset
      - econnreset
      - socket hang up
      - other side closed
      - http2 request did not get a response
      - premature close
      - stream ended
      - terminated
    maxRetries: 4
    initialDelayMs: 1500
    maxDelayMs: 30000
    jitterRatio: 0.2
    logRetries: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 则不挂任何监听器。 |
| `codes` | `["PI_AI_ERROR"]` | 可重试的错误码（大小写不敏感）。空数组 = 什么都不重试。 |
| `messagePatterns` | 见上 | 失败消息的**子串**，大小写不敏感。空数组 = 该错误码一律重试。 |
| `maxRetries` | `4` | 每个 step 的额外重试上限，`0`–`20`。 |
| `initialDelayMs` | `1500` | 首次退避毫秒数，必须 > 0 且 ≤ `maxDelayMs`。 |
| `maxDelayMs` | `30000` | 单次退避上限。 |
| `jitterRatio` | `0.2` | 对称抖动比例，`0`–`1`。 |
| `logRetries` | `true` | 每次重试决定 / 预算耗尽写一行 Host 日志。 |

配置在挂载时校验，非法值（未知键、越界数值、空字符串条目）会让插件激活失败并在
Loader 里报错，而不是等到某次真实失败时才炸。

> 本包**不导出 `Config`**：它被以 `link:` 方式装进 profile，而包的源目录在
> `D:\git\deepseek-tools\…` 下没有 `node_modules`，任何 `@deepseek-ai/*` 裸导入
> 都会 `ERR_MODULE_NOT_FOUND`（Cordis 允许插件不声明 `Config`，此时 loader 原样
> 透传 `config`）。因此校验放在 `resolveConfig` 里，行为等价，只是 Settings 面板
> 不会给它生成表单。要改用表单，就把包改成复制到
> `profiles/web/node_modules/@local/…` 并补 `export const Config`。

## 安装

已经以 bundle 形式安装进 `web` profile：

```
profile/package.json  → "dependencies":   "@local/dsh-llm-extra-retry": "link:D:/git/deepseek-tools/dsh-llm-extra-retry"
                      → "dsh.profile.bundles": … "@local/dsh-llm-extra-retry"
```

`cordis.patch.yml` 里的行随 bundle 的 `cordis.patch.yml` 一起注入，行 id 为
`llm-extra-retry`。因为 profile 开着 `patchReload: live`，改动该行会热重载。

安装是 `link:` 形式（`profiles/web/node_modules/@local/dsh-llm-extra-retry` 是指向
本目录的符号链接），所以**源目录就是安装目录**：改完 `index.js` 目前需要重启 Harness
才会换成新的模块代（HMR 的监听根是 profile 目录，且忽略 `node_modules`，不会跟踪
链接出去的源文件）。只是改 `cordis.patch.yml` 里的配置则不重启也会热重载。

## 验证

```powershell
cd D:\git\deepseek-tools\dsh-llm-extra-retry
node smoke-test.mjs          # 12 组断言：重试/否决/预算/取消/卸载/配置校验
node smoke-test-compose.mjs  # 6 组断言：与真实 @deepseek-ai/dsh-llm-retry 共用一个 waterfall
```

`smoke-test.mjs` 覆盖：命中重试、下游 `retry` 优先、下游抛错被吞掉后仍自行判断、
非白名单错误码不动、白名单错误码但消息不匹配（永久性 `deferred`）不动、
预算上限按 step 重置、turn abort 时取消等待、dispose 时取消并注销监听器、
`enabled:false` 空挂载、`codes:[]` / `messagePatterns:[]` 的边界、`Retry-After` 优先、
以及非法配置在挂载期抛错。

`smoke-test-compose.mjs` 直接加载**真实的** `dsh-llm-retry` 执行器，按 profile 里的
注册顺序（内置执行器在外层、本插件在内层）串联，验证：`PI_AI_ERROR` 截断被本插件
接住且不写会话事件；`RATE_LIMIT` 由内置执行器先答且只等一次；`AUTH` 两层都不碰；
永久性 `PI_AI_ERROR` 不重试；预算耗尽后交回 loop；反序挂载时下游 `retry` 不被重复
等待。

宿主侧确认为 `active`：

```
plugin_manager list_plugins → { entryId: "include:llm-extra-retry",
                                 moduleName: "@local/dsh-llm-extra-retry",
                                 patchId: "llm-extra-retry",
                                 enabled: true, fiberPhase: "active" }
```

**尚未做到的验证**：真实触发一次 `PI_AI_ERROR`。要复现这条错误得让上游在流中途
断连，属于不可控的网络故障；两份 smoke test 用同一份决策逻辑、同一份 waterfall
契约、以及**真实的**内置执行器做了确定性验证，但没有在活体 Harness 里跑通一次真实重试。

## 风险

每次重试都是一次**新的、会计费**的 provider 请求，输入 token 可能重复计费。默认
4 次、1.5s 起步、最长 30s 一次，最坏情况给一次失败多叠约 1 分钟等待；嫌慢就把
`maxRetries` 降到 1–2。

## 文件

```
dsh-llm-extra-retry/
  index.js                 # 插件本体（无任何 import，零运行时依赖）
  cordis.patch.yml         # bundle 的 patch 行（带全部配置默认值）
  package.json             # dsh.bundle.patch + locale/icon 导出
  locale/en.json           # Plugin Manager 显示标题/描述
  locale/zh.json
  icon.svg                 # 原创「重来一次」箭头
  smoke-test.mjs
  smoke-test-compose.mjs
```
