window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-build-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ------------------------------------------------------------------
		// styles
		// ------------------------------------------------------------------
		const css = `.bp_card{position:fixed;z-index:50;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:420px;max-width:calc(100vw - 24px);max-height:60vh;box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;display:flex;overflow:hidden}.bp_header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex}.bp_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}.bp_body{flex:1;min-height:0;padding:0 12px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}.bp_badge{width:100%;height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}.bp_badge:hover{background:var(--dsw-alias-interactive-bg-hover)}.bp_badge:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.bp_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.bp_badgeMeta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}.bp_row{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}.bp_rowHead{display:flex;align-items:center;gap:8px}.bp_rowName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}.bp_rowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}.bp_pre{background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin:0;padding:8px;max-height:180px;overflow:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-all}.bp_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:4px 0}.bp_err{color:var(--dsw-alias-state-error-primary);font-size:12px}.bp_actions{display:flex;gap:8px;margin-top:2px}.bp_btn{cursor:pointer;border:1px solid var(--dsw-alias-border-inverted);background:0 0;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-family:inherit;font-size:13px}.bp_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.bp_btnPrimary{background:var(--dsw-alias-interactive-bg-hover);font-weight:500}.bp_section{color:var(--dsw-alias-label-caption);text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin:4px 0 0}.bp_pager{flex:none;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;display:flex}.bp_pagerInfo{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:16px;text-align:center;min-width:0}`;
		const tagId = "@deepseek-ai/dsh-build-panel/style.css";
		/** Tasks shown per page in the list view. */
		const PAGE_SIZE = 6;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-build-panel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function el(type, props, ...children) {
			return react.createElement(type, props, ...children);
		}

		/** Relative age of a plan.mtime in ms: 刚刚 / N 分钟前 / … . */
		function relativeTime(ms) {
			if (ms === null || ms === void 0) return "";
			const delta = Math.max(0, Date.now() - ms);
			const minute = 60 * 1000;
			const hour = 60 * minute;
			const day = 24 * hour;
			if (delta < minute) return "刚刚更新";
			if (delta < hour) return Math.floor(delta / minute) + " 分钟前更新";
			if (delta < day) return Math.floor(delta / hour) + " 小时前更新";
			return Math.floor(delta / day) + " 天前更新";
		}

		// ------------------------------------------------------------------
		// host transport
		// ------------------------------------------------------------------
		// Browse calls ride the dedicated `buildPanel` Remote service on the
		// shared /api channel — pure UI reads that append no session events and
		// render no chat cards. The wire shape mirrors the generic Connection
		// RPC caller: a `client-request` envelope POSTed to /api/<endpoint>
		// whose payload is exactly `{ args: {...} }`, answered by
		// `{ type: "server-response", rpcId, result }`.
		let rpcSeq = 0;

		async function callBuildPanel(endpoint, args) {
			const rpcId = "bp-" + (++rpcSeq) + "-" + Math.random().toString(36).slice(2, 8);
			const response = await fetch("/api/buildPanel/" + endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "client-request", rpcId, method: "buildPanel/" + endpoint, payload: { args } })
			});
			if (!response.ok) throw new Error("传输失败：HTTP " + response.status);
			const full = await response.json();
			if (full.rpcId !== rpcId) throw new Error("rpcId 不匹配");
			const result = full.result;
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		}

		/** Browse: list every task directory (newest plan first). */
		async function browseList(sessionId) {
			return callBuildPanel("list", { sessionId });
		}

		/** Browse: full overview of one task directory. */
		async function browseOverview(sessionId, id) {
			return callBuildPanel("overview", { sessionId, id });
		}

		/** Drive: hand the workflow instruction for one task to the agent via the /build command. */
		async function runTaskCommand(remote, sessionId, id) {
			return executeBuildCommand(remote, sessionId, "/build " + id + " run");
		}

		/**
		 * Drive: hand the plugin's bundled commit workflow to the agent for this
		 * task. The host reads and binds the template, so a missing file surfaces
		 * here as an error.
		 */
		async function runCommitCommand(remote, sessionId, id) {
			return executeBuildCommand(remote, sessionId, "/build " + id + " commit");
		}

		/** Execute one `/build …` line and unwrap the command result. */
		async function executeBuildCommand(remote, sessionId, line) {
			const res = await remote.commands.execute(sessionId, line, []);
			if (!res.ok) throw new Error(res.error.message);
			if (res.value === void 0) throw new Error("未知或格式错误的命令");
			const r = res.value.result;
			if (r.kind === "error") throw new Error(r.text);
			try {
				return JSON.parse(r.text);
			} catch {
				return r.text;
			}
		}

		/**
		 * The panel card. `position: fixed` detaches it from the sidebar layout
		 * (same technique as the official CordisPanel).
		 */
		function Panel({ remote, sessionId, onClose }) {
			const [state, setState] = react.useState({ phase: "loading", data: null, error: null });
			const [detail, setDetail] = react.useState(null);
			const [page, setPage] = react.useState(0);
			const rootRef = react.useRef(null);

			const refresh = react.useCallback(() => {
				setState({ phase: "loading", data: null, error: null });
				browseList(sessionId).then((data) => {
					setState({ phase: "ready", data, error: null });
				}, (err) => {
					setState({ phase: "error", data: null, error: err instanceof Error ? err.message : String(err) });
				});
			}, [sessionId]);

			react.useEffect(() => {
				refresh();
			}, [refresh]);

			react.useEffect(() => {
				if (rootRef.current === null) return;
				const onPointerDown = (ev) => {
					if (rootRef.current !== null && ev.target instanceof Node && rootRef.current.contains(ev.target)) return;
					onClose();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => document.removeEventListener("pointerdown", onPointerDown, true);
			}, [onClose]);

			const openDetail = (id) => {
				setDetail({ phase: "loading", id, action: null, data: null, error: null });
				browseOverview(sessionId, id).then((data) => {
					setDetail({ phase: "ready", id, action: null, data, error: null });
				}, (err) => {
					setDetail({ phase: "error", id, action: null, data: null, error: err instanceof Error ? err.message : String(err) });
				});
			};

			/**
			 * Drive one task with `command` and fold the settled outcome into the
			 * detail card. `action` labels which button started it, so the result
			 * note can say what was actually handed to the agent.
			 */
			const drive = (command, action) => {
				setDetail({ phase: "running", id: detail.id, action, data: detail.data, error: null });
				command().then((data) => {
					setDetail({ phase: "done", id: detail.id, action, data, error: null });
				}, (err) => {
					setDetail({ phase: "error", id: detail.id, action, data: detail.data, error: err instanceof Error ? err.message : String(err) });
				});
			};

			const runTask = (id) => drive(() => runTaskCommand(remote, sessionId, id), "run");
			const runCommit = (id) => drive(() => runCommitCommand(remote, sessionId, id), "commit");

			let body;
			if (detail !== null) {
				body = el(react.Fragment, null,
					el("div", { className: "bp_row" },
						el("div", { className: "bp_rowHead" },
							el("span", { className: "bp_rowName" }, "任务 " + detail.id),
							el("span", { className: "bp_rowMeta" },
								detail.phase === "loading" ? "加载中" :
								detail.phase === "running" ? (detail.action === "commit" ? "下达 commit 中" : "下达中") :
								detail.phase === "done" ? (detail.action === "commit" ? "已下达 commit" : "已下达执行") :
								detail.phase === "error" ? "出错" : "就绪")
						)
					),
					detail.error !== void 0 && el("div", { className: "bp_err" }, detail.error),
					detail.phase === "ready" && detail.data && detail.data.type === "overview" && el(react.Fragment, null,
						detail.data.plan && el("div", { className: "bp_section" }, "执行目标 plan.md"),
						detail.data.plan && el("pre", { className: "bp_pre" }, detail.data.plan),
						detail.data.todos && detail.data.todos.length > 0 && el("div", { className: "bp_section" }, "待办 todo"),
						detail.data.todos && detail.data.todos.length > 0 && el("pre", { className: "bp_pre" }, detail.data.todos.map((t) => "[" + (t.status || "?") + "] " + t.file).join("\n")),
						detail.data.archiveTail && el("div", { className: "bp_section" }, "最近交接 archive"),
						detail.data.archiveTail && el("pre", { className: "bp_pre" }, detail.data.archiveTail),
						el("div", { className: "bp_actions" },
							el("button", { type: "button", className: "bp_btn", onClick: () => setDetail(null) }, "返回列表"),
							el("button", { type: "button", className: "bp_btn bp_btnPrimary", onClick: () => runTask(detail.id) }, "执行此任务"),
							el("button", {
								type: "button",
								className: "bp_btn",
								title: "按插件内置的提交流程检查变更并提交",
								onClick: () => runCommit(detail.id)
							}, "执行 commit")
						)
					),
					detail.phase === "done" && el(react.Fragment, null,
						el("div", { className: "bp_note" }, detail.action === "commit"
							? "已把 commit 提交流程交给当前会话的 agent 执行，请回到对话查看进度。"
							: "已把工作流指令交给当前会话的 agent 执行，请回到对话查看进度。"),
						el("div", { className: "bp_actions" },
							el("button", { type: "button", className: "bp_btn", onClick: () => setDetail(null) }, "返回列表")
						)
					),
					(detail.phase === "loading" || detail.phase === "running") && el("div", { className: "bp_note" }, "处理中…"),
					detail.phase === "error" && el("div", { className: "bp_actions" },
						el("button", { type: "button", className: "bp_btn", onClick: () => setDetail(null) }, "返回列表")
					)
				);
			} else if (state.phase === "loading") {
				body = el("div", { className: "bp_note" }, "加载任务目录…");
			} else if (state.phase === "error") {
				body = el(react.Fragment, null,
					el("div", { className: "bp_err" }, state.error),
					el("div", { className: "bp_actions" },
						el("button", { type: "button", className: "bp_btn", onClick: refresh }, "重试")
					)
				);
			} else if (state.data && state.data.type === "list") {
				const tasks = state.data.tasks || [];
				// Host already orders tasks newest-plan-first; paging is view-only.
				const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
				const safePage = Math.min(page, totalPages - 1);
				const start = safePage * PAGE_SIZE;
				const visible = tasks.slice(start, start + PAGE_SIZE);
				body = el(react.Fragment, null,
					tasks.length === 0 && el("div", { className: "bp_note" }, "docs/ 目录下没有任务目录"),
					visible.map((t) => el("button", {
						type: "button",
						className: "bp_badge",
						key: t.id,
						onClick: () => openDetail(t.id)
					},
						el("span", { className: "bp_badgeLabel" }, "任务 " + t.id),
						el("span", { className: "bp_badgeMeta" },
							(t.planMtime != null ? relativeTime(t.planMtime) + " · " : "")
							+ (t.todoCount > 0 ? t.todoCount + " 待办 · " : "") + (t.planExists ? "有 plan" : "无 plan")
						)
					)),
					totalPages > 1 && el("div", { className: "bp_pager" },
						el("button", {
							type: "button",
							className: "bp_btn",
							disabled: safePage === 0,
							onClick: () => setPage(safePage - 1)
						}, "上一页"),
						el("span", { className: "bp_pagerInfo" }, (safePage + 1) + " / " + totalPages + " 页 · 共 " + tasks.length + " 个任务"),
						el("button", {
							type: "button",
							className: "bp_btn",
							disabled: safePage >= totalPages - 1,
							onClick: () => setPage(safePage + 1)
						}, "下一页")
					)
				);
			} else {
				body = el("div", { className: "bp_note" }, "无法解析返回数据");
			}

			return el("div", {
				ref: rootRef,
				className: "bp_card",
				style: { right: 12, bottom: 12 }
			},
				el("div", { className: "bp_header" },
					el("span", { className: "bp_title" }, "Build 工作流面板"),
					el("button", { type: "button", className: "bp_btn", onClick: onClose }, "关闭")
				),
				el("div", { className: "bp_body" }, body)
			);
		}

		/**
		 * The footer action: one badge that toggles the panel. `useSessions` is a
		 * standard slot prop delivering the current session id.
		 */
		function BuildPanelAction({ useSessions, remote }) {
			const current = useSessions((s) => s.current);
			const [open, setOpen] = react.useState(false);

			if (current === void 0) {
				return el("button", { type: "button", className: "bp_badge", disabled: true, title: "没有当前会话" },
					el("span", { className: "bp_badgeLabel" }, "Build 工作流"),
					el("span", { className: "bp_badgeMeta" }, "无会话")
				);
			}

			return el(react.Fragment, null,
				el("button", {
					type: "button",
					className: "bp_badge",
					onClick: () => setOpen((v) => !v),
					title: "打开 build 工作流面板"
				},
					el("span", { className: "bp_badgeLabel" }, "Build 工作流"),
					open && el("span", { className: "bp_badgeMeta" }, "已打开")
				),
				open && el(Panel, {
					remote,
					sessionId: current,
					onClose: () => setOpen(false)
				})
			);
		}

		// ------------------------------------------------------------------
		// plugin body
		// ------------------------------------------------------------------
		const inject = ["slots", "remote", "remote.commands"];

		function apply(ctx) {
			// `remote` is a hard dependency here (declared via inject), so access
			// it as `ctx.remote`; `remote.commands` is the nested namespace service
			// that api-remotes mounts for the /commands registry.
			slotsInject(ctx);
		}

		function slotsInject(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "build-panel",
				inject: () => ({ remote: ctx.remote })
			}, BuildPanelAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
