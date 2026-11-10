---
description: "A sidebar panel and a /build command that browse and drive docs/<task> workflows."
kind: "package-bundle"
---

# @deepseek-ai/dsh-build-panel

The DSH equivalent of opencode's `build.md` command, as a two-plane plugin: a
**browse plane** that reads `docs/<task>/` directories for a sidebar panel, and a
**drive plane** that hands one task's workflow instruction to the current Agent.

It ships as a **bundle**: `package.json` declares `dsh.bundle.patch` and
`dsh.client`, the bundled `cordis.patch.yml` mounts the single `build-panel` row,
and the package carries its own locales and icon. One
`dsh plugin --profile <name> add` installs and activates both halves; the
profile's Plugins page then turns them on and off together.

```yaml
- id: build-panel
  name: '@deepseek-ai/dsh-build-panel'
```

---

## What it does

The plugin reads the session's **own working directory** through `node:fs` in the
Host process — not through the sandbox — and treats every direct child of
`docs/` as one task:

| Path | Role |
| --- | --- |
| `docs/<task>/index.md` | Reference-file index the Agent maintains: the source paths involved in the task |
| `docs/<task>/plan.md` | The execution target. Its mtime orders the panel |
| `docs/<task>/todo/*.md` | Pending items; the `状态:` field of each file is read |
| `docs/<task>/finish/*.md` | Completed items, moved here by the workflow |
| `docs/<task>/plans/*.md` | Plans archived by the workflow |
| `docs/<task>/archive.md` | Append-only hand-off table; the panel shows its last lines |

Two planes, deliberately different transports:

| Plane | Surface | Reaches the model? |
| --- | --- | --- |
| **Browse** | `buildPanel/list` and `buildPanel/overview`, a Typert Remote service on the shared `/api` channel | ❌ No — pure UI reads, no session events, no chat cards |
| **Drive** | `/build <task> run [note]`, or the panel's **执行此任务** button | ✅ Yes — queues one model-visible follow-up carrying the full workflow instruction |

That split is the point: browsing a hundred tasks must not enter the transcript,
while actually starting one must be visible — it changes what the Agent does and
belongs in the audit trail.

### The sidebar panel

A **Build 工作流** badge in the sidebar footer opens a floating card
(`position: fixed`, dismissed by clicking outside it, the same technique as the
official Cordis panel). It lists six tasks per page, newest `plan.md` first, each
with its age, pending-todo count and whether a plan exists. Selecting one shows
the plan, the pending todos and the tail of `archive.md`, plus the **执行此任务**
button.

The panel is a plain module-system bundle: `React.createElement` only, no JSX, no
`import`, and `require("react")` alone — `react` is a seed word of the browser
module system, so it is not listed in `dsh.client.inject`.

### The `/build` command

```
/build <任务号> run [补充说明]
```

`run` is the only subcommand. It queues this instruction and reports
`{"type":"run","id":"<task>","ok":true}`:

1. Read `docs/<id>/index.md` as the reference index; if it is missing or empty,
   fall back to the first three other `.md` files in the directory by name.
2. Read `docs/<id>/plan.md` as the execution target; if it is empty, use the
   `todo/` items marked `待办`.
3. Implement, maintaining the source paths in `index.md`.
4. Afterwards, in this order: append to `docs/<id>/archive.md` (never overwrite
   history), move `状态: 已完成` todo files to `finish/`, and move `plan.md` to
   `plans/<timestamp>.md`, leaving `plan.md` empty.

Anything else — a bare `/build`, a task number without `run`, an unknown
subcommand — returns a usage error and queues nothing.

---

## Install

`dsh plugin --profile <name> add <spec>` forwards to pnpm in the profile
directory, links the bundle, and appends it to `dsh.profile.bundles` because the
package declares `dsh.bundle`.

```powershell
dsh plugin --profile web add D:/git/deepseek-tools/dsh-build-panel
```

Verify composition before booting — the bundle contributes its own layer:

```powershell
dsh --profile web --dump-config   # shows a "# == @deepseek-ai/dsh-build-panel" layer
```

Both halves enter the composition from that one row: the Host half as the
plugin's `apply`, the browser half because `dsh.client.platform` is `web`, which
puts `lib/client.js` in the boot module graph.

### Update

Re-run `add` with the new source, then restart the profile. The patch layer is
watched, but a restart is the reliable path for a new `lib/index.js`. A new
`lib/client.js` additionally needs a **page refresh**: an already-loaded browser
bundle is not replaced by a Host-side reload.

### Remove

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-build-panel
```

---

## Enable and disable

The bundle is a normal profile entry once installed. All three paths are
equivalent and reversible:

| Surface | How |
| --- | --- |
| Web sidebar → **Plugins** | Toggle the row; the page writes `disabled` into the profile patch |
| Agent `plugin_manager` tool | Same operation from a conversation (needs `danger-full-access` or approval) |
| Profile `cordis.patch.yml` | Add `- id: build-panel` with `disabled: true` |

Because both halves hang off the same fiber, disabling removes the command, the
Remote service and the sidebar badge in one step, and re-enabling restores all
three from this same row. There is no partial state to reconcile — except the
browser: an already-rendered page keeps its badge until it is refreshed.

Disabling keeps the package itself, so nothing is lost but the registration.
The task directories under `docs/` are yours; the plugin only ever reads them,
apart from the follow-up instruction it queues.

The package is displayed with its own title, description, and icon from
`locale/en.json`, `locale/zh.json`, and `icon.svg`.

### No configuration page

There is nothing to point at and nothing to authenticate, so the plugin declares
no `Config` schema. That has one visible consequence: the row has **only** an
enable/disable switch and no configuration page, because a page is generated from
a config schema. This is the intended shape, not a missing feature.

---

## Checks

Two scripts, neither of which needs the DSH runtime:

```powershell
cd D:/git/deepseek-tools/dsh-build-panel

# Behaviour and packaging contract: the manifest/bundle wiring, localized
# metadata, the icon, the Host half's three code paths, and the browser half's
# registration and render — including the click path open → task → run
node smoke-test.mjs

# Prose contract: re-derives the README's claims from the code and fails when
# they drift — versions, the slot id, the Remote method set, the command surface,
# the packaging fields
node doc-check.mjs
```

`smoke-test.mjs` imports the **installed** bundle by default
(`$DSH_HOME/profiles/<web>/node_modules/@deepseek-ai/dsh-build-panel`), because
the `@deepseek-ai/*` peers resolve from a profile, not from this checkout. It
falls back to the checkout when nothing is installed. Overrides: `DSH_HOME`,
`BUILD_PANEL_PROFILE`, and `BUILD_PANEL_PLUGIN=<file:///…/lib/index.js>`.

Both scripts run the **task fixtures at `F:/work/manager-frontend/docs`**, which
is the workspace this panel was developed against; set
`BUILD_PANEL_FIXTURE=<dir>` to point them at another `docs/` tree. Nothing is
written to it — the tests read, and drive a fake agent.

The offline section is the packaging contract. It fails if `files` stops shipping
`cordis.patch.yml`, the locales, the icon or `lib/client.js`; if `dsh.client`
disappears or its `platform` stops being `web`; if the patch row stops matching
the package name or loses its `id`; if the Remote method set changes; if the
`commit` subcommand and its button come back; or if the browser half starts
importing a Harness Client package.

The browser half is checked by capturing its `window.__ModuleLoader__.load`
registration and rendering against a miniature stateful React, so it needs no
DOM: `useState` really re-renders, `useEffect` really runs, and the assertions
walk the click path — open the panel, pick a task, read the overview, press
**执行此任务** — over a stubbed `/api` channel, then assert the exact
`remote.commands.execute` line it produced. It also fails if the badge renders in
its disabled "无会话" form, which is what a stale session selector produces
silently.

---

## Known limitations

- **The panel is read-only about your files.** It never creates, moves or
  archives anything; those steps are in the instruction handed to the Agent, so a
  human still reviews the result of the workflow rather than a silent file move.
- **Browsing is a UI read, so it is not audited.** Nothing about a browse appears
  in the session log. Only **执行此任务** and `/build … run` queue a message and
  are logged.
- **The badge needs a page refresh after a toggle.** The Host side is
  effect-scoped and switches immediately; the browser bundle is not unloaded from
  an already-open page.
- **The task list is the direct children of `docs/`.** A nested layout
  (`docs/<area>/<task>/`) is not discovered. A missing `docs/` is an empty list,
  not an error; a session without a working directory is an error.
- **The `状态:` scan is a single regex over the file.** A todo file that spells
  the state differently shows as `[?]` in the panel instead of failing loudly.
- **The workflow instruction is fixed in code.** Changing the steps means editing
  `lib/index.js`; there is no configuration field for it, by design — the point of
  the plugin is one canonical workflow.
- **Rendered appearance is unverified in-repo.** Slots, ids, dictionaries,
  styling metrics and both card states were checked programmatically; layout and
  colour in a live browser were not captured by an automated screenshot.

---

## Version history

| Version | Change |
| --- | --- |
| 1.0.0 | Ships as an installable, toggleable bundle: `dsh.bundle.patch`, `dsh.client`, `cordis.patch.yml`, locales, icon, `engines.dsh`. Previously a bare module that had to be copied into the profile and wired by hand, which meant it never appeared on the Plugins page and could not be switched off |
