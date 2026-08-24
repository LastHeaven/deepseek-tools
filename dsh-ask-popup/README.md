# dsh-ask-popup — 大模型提问时弹 Windows 系统通知

DSH（DeepSeek Harness）插件：当大模型调用 `ask_user_question` 工具向你提问时，
在 Windows 右下角弹出**系统级气泡通知**（带提示音），提醒你去回答模型的问题。

- **纯 Host 半插件**，无 Client 半、无需刷新浏览器页面。
- 不注册新的 UI provider（`userQuestions` 只允许一个 provider，网页端的
  `ui-user-questions` 已占用）——只是**旁路监听** `session/event` 流，
  完全不干扰网页端的提问卡片。
- 通知通过 `cmd /c start "" /min` + PowerShell `-EncodedCommand` 实现——
  这是经过实测的唯一「无窗口闪现 + 中文不乱码 + 气泡真正显示」组合
  （详见下文「踩坑记录」）。

## 原理

模型通过 `ask_user_question` 工具提问时，agent loop 会在会话日志里追加一条
`tool/call` 事件：

```
{ turn, step, callId, name: "ask_user_question", arguments: "<JSON 字符串>" }
```

插件订阅全局 `session/event` 事件流，命中 `name === "ask_user_question"` 时：

1. 解析 `arguments` 里的 `questions` 数组；
2. 取第一个问题的 `header`/`question` 文本（多问题会标注「共 N 个问题」）；
3. 生成 PowerShell 脚本（NotifyIcon 气泡 + 提示音），Base64 UTF-16LE 编码后
   通过 `cmd /c start "" /min powershell -EncodedCommand` 启动 ——
   `start` 让进程跑在交互桌面（否则气泡被静默丢弃），`/min` + `-WindowStyle
   Hidden` 避免控制台窗口闪现，`-EncodedCommand` 保证中文不因控制台代码页乱码。

## 安装与接线

```powershell
# 1. 复制到 profile 的 node_modules（方式 A，零外部依赖）
$src = "D:\git\deepseek-tools\dsh-ask-popup"
$dst = "C:\Users\hxy\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-ask-popup"
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item "$src\package.json" "$dst\package.json" -Force
Copy-Item "$src\lib\index.js" "$dst\lib\index.js" -Force
```

```yaml
# 2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 追加：
- insert:
    - id: ask-popup
      name: '@deepseek-ai/dsh-ask-popup'
      config:
        enabled: true
        title: DeepSeek Harness   # 通知标题
        timeoutMs: 10000          # 气泡显示时长（毫秒）
        onlyWithOptions: false    # true 时只在问题带选项时通知
        style: bubble             # bubble | toast | popup
```

> **注意**：web profile 里 HMR 是关闭的（`dsh-web-app` bundle 中 `hmr` 被
> `disabled: true`），且插件文件变更不会热加载 —— **改完必须重启 DSH 进程**
> 才能生效。

## 验证

```powershell
# 接线检查（dump 里应有 ask-popup，无 error/failed）
node "D:\npm\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config

# 运行时状态（fiberPhase 应为 active）
# POST /api/pluginInventory/list  →  find include:ask-popup

# 冒烟测试
cd "C:\Users\hxy\.dsh\profiles\web"
node "D:\git\deepseek-tools\dsh-ask-popup\smoke-test.mjs"

# 调试日志（始终写入 %TEMP%\dsh-ask-popup.log，含事件/spawn 记录）
Get-Content "$env:TEMP\dsh-ask-popup.log" -Tail 20
```

真实验证：在聊天里让模型调用 `ask_user_question`（例如要求它「不确定就问我」），
右下角应弹出系统气泡并伴随提示音。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `title` | string | `DeepSeek Harness` | 系统通知标题 |
| `timeoutMs` | number | `10000` | 气泡显示时长（ms） |
| `onlyWithOptions` | boolean | `false` | 为 true 时只在问题带选项时通知 |
| `style` | string | `bubble` | `bubble` 托盘气泡 / `toast` 通知中心 / `popup` 模态弹窗 |

## 踩坑记录（实测）

| 方案 | 结果 |
| --- | --- |
| Node 直接 `spawn` powershell（stdio ignore） | ❌ 气泡不显示（非交互窗口站） |
| Node spawn + `detached: true` | ❌ 同上 |
| 手动 `Start-Process` powershell | ✅ 能显示（交互桌面） |
| `cmd /c start` + `.ps1` 文件（UTF-8 无 BOM） | ⚠️ 能显示但弹 shell 框 + 中文乱码 |
| `explorer.exe` 中介 + `.ps1`（UTF-8 BOM） | ⚠️ 仍有 shell 框 + 乱码 |
| **`cmd /c start "" /min` + `-EncodedCommand`（Base64 UTF-16LE）** | ✅ **无窗口、中文正常、气泡弹出** |

根因：Windows 的 NotifyIcon 气泡 / WinRT toast 只在**交互桌面**的进程里显示；
Node 默认 spawn 的后台进程落在非交互窗口站被静默丢弃。而 PowerShell 5.1
读 `.ps1` 文件时用控制台代码页（GBK），UTF-8 中文必乱码；`-EncodedCommand`
用 Base64 UTF-16LE 传参则字节级精确。

## 文件

```
dsh-ask-popup/
  package.json      # 零依赖 ESM 包
  lib/index.js      # Host 半：监听 session/event → Windows 系统通知
  smoke-test.mjs    # 冒烟测试（假 ctx 驱动各分支）
  README.md
```
