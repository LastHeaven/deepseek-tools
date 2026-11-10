// @deepseek-ai/dsh-tool-firecrawl — browser half.
//
// Registers this bundle's row configuration page on the Web Plugins page, so the
// parameters in `Config` are edited in the UI instead of by hand in the profile's
// `cordis.patch.yml`. The row gains a Configure control on the bundle's page; the
// page it opens is this form.
//
// How the pieces fit together:
//
// - The page owner supplies `form` (`PluginConfigViewProps`): the settings
//   service's live view of this entry plus its write queue. It is present only
//   while the entry projects editable fields, which is why the Host half declares
//   them `.volatile()`.
// - `form.state.value` is the effective value (schema defaults → composition
//   base → user layer), `form.state.base` is what clearing a field reverts to,
//   and a key's PRESENCE in `form.state.user` is what marks it overridden — an
//   override equal to the default is still an override.
// - Nothing is written until Save: drafts live in component state and Save sends
//   one `mutate` carrying every staged edit under the revision that was read. A
//   staged value equal to the base layer is sent as `unset`, so the profile patch
//   keeps recording only departures from the bundle.
// - The API key itself never rides this form. The page edits `apiKeyEnv` (a
//   reference name) and writes the secret through the credentials namespace, so a
//   literal key stays out of `cordis.patch.yml` and out of every response.
//
// Plain JavaScript, no JSX, no Harness Client package imports: every element is
// built with `React.createElement` and styled through the host theme tokens. The
// switch and button markup mirrors the host controls (`role="switch"` with
// `aria-checked`) because the primitives package is deliberately not imported.
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-tool-firecrawl",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = "toolFirecrawl";
    /** The bundle's package name. */
    const PACKAGE = "@deepseek-ai/dsh-tool-firecrawl";
    /** The row id the bundled patch declares: the `plugins.row.config` key suffix. */
    const ROW_ID = "tool-firecrawl";
    /** Key the Plugins page dispatches for this row's configuration page. */
    const ROW_CONFIG_KEY = `${PACKAGE}#${ROW_ID}`;
    /** Reference the Host half resolves when `apiKeyEnv` names none. */
    const DEFAULT_API_KEY_ENV = "FIRECRAWL_API_KEY";
    /** Fallback base URL the schema and the bundled patch both declare. */
    const DEFAULT_API_URL = "http://firecrawl.localhost";

    // -------------------------------------------------------------------------
    // Dictionaries
    // -------------------------------------------------------------------------

    const en = {
      summary: "Firecrawl instance endpoint, API key reference, tool switches and default limits.",
      endpoint: "Firecrawl base URL",
      endpointHint: "Tools request {url}/v1/scrape, {url}/v2/search, {url}/v1/map, {url}/v1/crawl and {url}/v2/parse. Self-hosted instances usually need no key; the cloud service needs one.",
      keyReference: "API key reference",
      keyReferenceHint: "Name of the credential the tools resolve, e.g. {ref}. The key itself is stored below, never in this form.",
      keyStatus: "API key",
      keyConfigured: "Configured",
      keyMissing: "Not set",
      keyUnknown: "Unavailable",
      keyLoading: "Checking…",
      keySource: "Source: {source}",
      keyEditable: "Stored in the credential store at $DSH_HOME/.credentials.yaml. Pasting a key here replaces it; the value never enters this form's saved configuration.",
      keyUnwritable: "The credential store reports this reference as read-only, so it cannot be written from this page. Set it in the environment named above.",
      keyError: "Could not read the credential store: {message}",
      keyValue: "New key",
      keyValuePlaceholder: "Paste the Firecrawl key (fc-…)",
      keySave: "Save key",
      keySaving: "Saving…",
      keySaved: "Key stored.",
      keyClear: "Remove key",
      tools: "Tools",
      scrape: "Scrape one URL",
      scrapeHint: "Registers firecrawl_scrape. Turns a known page into markdown, HTML, links or JSON.",
      search: "Web search",
      searchHint: "Registers firecrawl_search. Ranked web results with source filters.",
      developerSearch: "Developer search",
      developerSearchHint: "Registers firecrawl_developer_search. Cloud-only index; degrades to a developer-category web search elsewhere.",
      map: "Map a site",
      mapHint: "Registers firecrawl_map. Enumerates a site's URLs without fetching every page.",
      parse: "Parse a local file",
      parseHint: "Registers firecrawl_parse. Uploads a local PDF, Office or HTML file and returns its content.",
      crawl: "Start a crawl",
      crawlHint: "Registers firecrawl_crawl. Starts a multi-page crawl and returns its job id.",
      checkCrawlStatus: "Crawl status",
      checkCrawlStatusHint: "Registers firecrawl_check_crawl_status. Polls a crawl job started above.",
      limits: "Default limits",
      searchMaxResults: "Search results",
      searchMaxResultsHint: "Applied when firecrawl_search is called without a limit.",
      mapMaxResults: "Mapped URLs",
      mapMaxResultsHint: "Applied when firecrawl_map is called without a limit.",
      crawlMaxResults: "Crawled pages",
      crawlMaxResultsHint: "Applied when firecrawl_crawl is called without a limit.",
      maxOutputChars: "Maximum output characters",
      maxOutputCharsHint: "Truncation limit applied to every tool result.",
      advanced: "Takes effect after a reload",
      advancedHint: "timeoutMs and a literal apiKey cannot be edited here: they only apply when the plugin is rebuilt. Set them in cordis.patch.yml.",
      overridden: "Overridden",
      reset: "Reset",
      save: "Save",
      saving: "Saving…",
      saved: "Configuration saved.",
      saveFailed: "Could not save the configuration. {message}",
      discard: "Discard",
      loading: "Reading the current configuration…",
      unavailable: "This profile does not expose this plugin's configuration.",
      readOnly: "This profile does not accept configuration writes.",
      invalidUrl: "Enter the Firecrawl base URL.",
      invalidNumber: "{field} must be a positive whole number.",
    };

    const zh = {
      summary: "Firecrawl 实例地址、API 密钥引用、工具开关与默认上限。",
      endpoint: "Firecrawl 基础地址",
      endpointHint: "工具会请求 {url}/v1/scrape、{url}/v2/search、{url}/v1/map、{url}/v1/crawl 与 {url}/v2/parse。自建实例通常无需密钥，云服务需要。",
      keyReference: "API 密钥引用名",
      keyReferenceHint: "工具解析凭据时使用的名称，例如 {ref}。密钥本身存在下方，不经过这个表单。",
      keyStatus: "API 密钥",
      keyConfigured: "已配置",
      keyMissing: "未设置",
      keyUnknown: "不可用",
      keyLoading: "检查中…",
      keySource: "来源：{source}",
      keyEditable: "保存在凭据库 $DSH_HOME/.credentials.yaml 中。在此粘贴密钥会覆盖旧值；密钥不会写进本表单保存的配置里。",
      keyUnwritable: "凭据库报告该引用为只读，无法在此页面写入。请在上方指定的环境变量中设置。",
      keyError: "无法读取凭据库：{message}",
      keyValue: "新密钥",
      keyValuePlaceholder: "粘贴 Firecrawl 密钥（fc-…）",
      keySave: "保存密钥",
      keySaving: "保存中…",
      keySaved: "密钥已保存。",
      keyClear: "删除密钥",
      tools: "工具",
      scrape: "抓取单个页面",
      scrapeHint: "注册 firecrawl_scrape。把已知页面转成 markdown、HTML、链接或 JSON。",
      search: "网页搜索",
      searchHint: "注册 firecrawl_search。返回排序后的网页结果，支持来源过滤。",
      developerSearch: "开发者搜索",
      developerSearchHint: "注册 firecrawl_developer_search。仅云端提供索引，其他部署会退化为开发者分类的网页搜索。",
      map: "枚举站点链接",
      mapHint: "注册 firecrawl_map。列出站点 URL，不抓取每个页面内容。",
      parse: "解析本地文件",
      parseHint: "注册 firecrawl_parse。上传本地 PDF、Office 或 HTML 文件并返回内容。",
      crawl: "启动批量爬取",
      crawlHint: "注册 firecrawl_crawl。启动多页爬取并返回任务 ID。",
      checkCrawlStatus: "爬取状态",
      checkCrawlStatusHint: "注册 firecrawl_check_crawl_status。查询上面启动的爬取任务。",
      limits: "默认上限",
      searchMaxResults: "搜索结果数",
      searchMaxResultsHint: "firecrawl_search 未指定 limit 时使用。",
      mapMaxResults: "枚举链接数",
      mapMaxResultsHint: "firecrawl_map 未指定 limit 时使用。",
      crawlMaxResults: "爬取页数",
      crawlMaxResultsHint: "firecrawl_crawl 未指定 limit 时使用。",
      maxOutputChars: "输出字符上限",
      maxOutputCharsHint: "每次工具结果应用的截断长度。",
      advanced: "重载后生效",
      advancedHint: "timeoutMs 与直接填写的 apiKey 无法在此编辑：它们只在插件重建时生效，请在 cordis.patch.yml 中设置。",
      overridden: "已覆盖",
      reset: "重置",
      save: "保存",
      saving: "保存中…",
      saved: "配置已保存。",
      saveFailed: "配置保存失败。{message}",
      discard: "放弃修改",
      loading: "正在读取当前配置…",
      unavailable: "当前 profile 未暴露该插件的配置。",
      readOnly: "当前 profile 不接受配置写入。",
      invalidUrl: "请填写 Firecrawl 基础地址。",
      invalidNumber: "{field} 必须是正整数。",
    };

    // -------------------------------------------------------------------------
    // Styles — theme tokens only, classes under this plugin's own prefix
    // -------------------------------------------------------------------------

    const CSS = `
.fcw-form { display: flex; flex-direction: column; gap: 18px; }
.fcw-field { display: flex; flex-direction: column; gap: 6px; }
.fcw-labelRow { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.fcw-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.fcw-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }

/* Inputs follow the host's field metrics: 28px tall, 13px text, radius-sm. */
.fcw-input {
  box-sizing: border-box; width: 100%; height: 28px; padding: 0 10px;
  font: inherit; font-size: 13px; line-height: 26px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm);
}
.fcw-input::placeholder { color: var(--dsw-alias-label-secondary); }
.fcw-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.fcw-input:disabled { opacity: .55; }
.fcw-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }

.fcw-row { display: flex; align-items: flex-start; gap: 10px; }
.fcw-rowText { display: flex; flex-direction: column; gap: 4px; }
.fcw-switch {
  position: relative; flex: 0 0 auto; width: 34px; height: 20px; margin-top: 1px;
  padding: 0; border: none; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-state-idle-primary); transition: background .15s ease;
}
.fcw-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.fcw-switch:disabled { opacity: .55; cursor: default; }
.fcw-knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-bg-base); transition: transform .15s ease;
}
.fcw-switch[aria-checked="true"] .fcw-knob { transform: translateX(14px); }

.fcw-badge {
  padding: 1px 7px; font-size: 11px; border-radius: 999px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}

/* Buttons copy the host's sm size: inline-flex, 28px, 12px text, never wrapped. */
.fcw-button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto; height: 28px; padding: 0 10px; margin: 0;
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm);
}
.fcw-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.fcw-button:disabled { opacity: .55; cursor: default; }
.fcw-buttonPrimary {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill);
}
@media (hover: hover) {
  .fcw-buttonPrimary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
}
.fcw-buttonText {
  height: 20px; padding: 0 6px; border-color: transparent; background: transparent;
  color: var(--dsw-alias-label-secondary); text-decoration: underline;
}
.fcw-buttonText:hover:not(:disabled) { background: transparent; color: var(--dsw-alias-label-primary); }

.fcw-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fcw-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.fcw-statusError { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.fcw-statusOk { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.fcw-divider { height: 1px; margin: 0; border: 0; background: var(--dsw-alias-border-l1); }
.fcw-group { display: flex; flex-direction: column; gap: 14px; }
.fcw-groupTitle {
  margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .02em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary);
}
.fcw-keyLine { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fcw-keyValue { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-primary); }
/* The key row is one line: the field grows, the button keeps its own width. */
.fcw-secretRow { display: flex; align-items: center; gap: 8px; }
.fcw-secretRow > .fcw-input { flex: 1 1 auto; min-width: 0; }

/* The count fields are four short numbers; a grid keeps them aligned without
   letting any one of them stretch to the page width. */
.fcw-counts { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.fcw-note {
  margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm);
}
`;

    function Styles() {
      return h("style", null, CSS);
    }

    // -------------------------------------------------------------------------
    // Controls (authored here; the primitives package is not imported)
    // -------------------------------------------------------------------------

    function Switch(props) {
      return h("button", {
        type: "button",
        role: "switch",
        className: "fcw-switch",
        "aria-checked": props.checked ? "true" : "false",
        "aria-label": props.label,
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked)
      }, h("span", { className: "fcw-knob" }));
    }

    function Field(props) {
      return h("div", { className: "fcw-field" },
        h("div", { className: "fcw-labelRow" },
          h("label", { className: "fcw-label", htmlFor: props.id }, props.label),
          props.overridden ? h("span", { className: "fcw-badge" }, props.t("overridden")) : null,
          props.overridden && props.onReset !== undefined
            ? h("button", {
                type: "button",
                className: "fcw-button fcw-buttonText",
                disabled: props.disabled,
                onClick: props.onReset
              }, props.t("reset"))
            : null),
        props.children,
        props.hint === undefined ? null : h("p", { className: "fcw-hint" }, props.hint));
    }

    function ToggleRow(props) {
      return h("div", { className: "fcw-row" },
        h(Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange
        }),
        h("div", { className: "fcw-rowText" },
          h("span", { className: "fcw-label" }, props.label),
          h("p", { className: "fcw-hint" }, props.hint)));
    }

    // -------------------------------------------------------------------------
    // Credential state — describe and write, never reading a value back
    // -------------------------------------------------------------------------

    function messageOf(error) {
      if (error === null || error === undefined) return "";
      if (typeof error === "string") return error;
      if (typeof error.message === "string") return error.message;
      return String(error);
    }

    /**
     * Track one credential reference without ever receiving its value.
     *
     * `describe` answers configured/source/writable only; `set` and `unset` are
     * the write path. The reference is re-read when the name changes and whenever
     * the Host announces a committed change to it.
     *
     * Two wire details decide the shape of this code:
     *
     * - `describe` returns a `RemoteResult` envelope — `{ ok, value }` or
     *   `{ ok: false, error }` — not the mapping itself. Reading it as the mapping
     *   silently yields `undefined` for every field, which renders as
     *   "not set / cannot be changed here" at once. `set` and `unset` are plain
     *   promises that reject instead.
     * - `ctx.get("remote.credentials")` names the namespace service in full.
     *   `ctx.get` returns `undefined` for a name nobody provided, whereas reaching
     *   through `ctx.get("remote").credentials` re-enters service resolution with
     *   the dotted key and throws `cannot get property "remote.credentials"
     *   without inject`. A throw here blanks the whole slot entry.
     */
    function credentialNamespace(ctx) {
      if (ctx === undefined || ctx === null) return undefined;
      const service = ctx.get("remote.credentials");
      if (service === undefined || service === null) return undefined;
      // Guard the shape, not just presence: an older Host could expose the name
      // with a different surface, and calling a missing method throws later.
      if (typeof service.describe !== "function") return undefined;
      return service;
    }

    function useCredential(ctx, ref) {
      const [state, setState] = React.useState({ status: "loading" });
      // Bumped by a successful write so the badge re-reads even if the Host's
      // `credentials/reference-updated` event is missed.
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        const name = String(ref ?? "").trim();
        if (name === "") {
          setState({ status: "ready", configured: false, writable: false });
          return undefined;
        }
        const service = credentialNamespace(ctx);
        if (service === undefined) {
          setState({ status: "unavailable" });
          return undefined;
        }
        let live = true;
        const read = async () => {
          try {
            const result = await service.describe([name]);
            if (!live) return;
            // Unwrap the RemoteResult envelope; a refusal carries no view.
            if (result === null || typeof result !== "object" || result.ok !== true) {
              const message = result?.error?.message ?? result?.error?.code ?? "credentials.describe failed";
              setState({ status: "error", message: String(message) });
              return;
            }
            const view = result.value === null || result.value === undefined ? undefined : result.value[name];
            setState({
              status: "ready",
              configured: view?.configured === true,
              source: view?.source,
              writable: view?.writable === true
            });
          } catch (error) {
            if (!live) return;
            setState({ status: "error", message: messageOf(error) });
          }
        };
        read();
        // `remote` is declared in `inject` and `$on` is an ordinary method of that
        // facade, so this read is safe — it is the same call the shipped web-search
        // settings page makes. Only an unknown *namespace* name trips the trap.
        // A page rendered without a context (the summary view) skips the subscription.
        const facade = ctx === undefined || ctx === null ? undefined : ctx.remote;
        const off = facade === undefined ? undefined : facade.$on("credentials/reference-updated", (changed) => {
          if (changed === name) read();
        });
        return () => {
          live = false;
          if (typeof off === "function") off();
        };
      }, [ctx, ref, nonce]);

      return [state, () => setNonce((value) => value + 1)];
    }

    // -------------------------------------------------------------------------
    // The configuration page
    // -------------------------------------------------------------------------

    /** Text of one field: the staged draft when one exists, else the accepted Host value. */
    function textOf(draft, value, name, fallback) {
      if (Object.prototype.hasOwnProperty.call(draft, name)) return draft[name];
      const current = value[name];
      return current === undefined || current === null ? fallback : String(current);
    }

    /** Boolean of one field, with the schema default as the fallback. */
    function boolOf(draft, value, name, fallback) {
      if (Object.prototype.hasOwnProperty.call(draft, name)) return draft[name] === true;
      const current = value[name];
      return typeof current === "boolean" ? current : fallback;
    }

    /** The seven per-tool switches, in the order the page shows them. */
    const TOOL_FIELDS = ["scrape", "search", "developerSearch", "map", "parse", "crawl", "checkCrawlStatus"];
    /** The four numeric limits, in the order the page shows them. */
    const COUNT_FIELDS = ["searchMaxResults", "mapMaxResults", "crawlMaxResults", "maxOutputChars"];
    /** Schema defaults for the numeric limits, used when the Host value is absent. */
    const COUNT_DEFAULTS = {
      searchMaxResults: "8",
      mapMaxResults: "100",
      crawlMaxResults: "50",
      maxOutputChars: "200000"
    };

    const NOTICE = { ok: "fcw-statusOk", error: "fcw-statusError" };

    /**
     * Render one row's configuration.
     *
     * Every hook runs before any early return: the summary and the not-ready
     * branches below are ordinary renders of a component that already ran its
     * hooks, which keeps the hook order stable across status changes.
     */
    function SettingsPage(props) {
      const { t, form, view, ctx } = props;
      const state = form === undefined ? undefined : form.state;
      const loaded = state !== undefined && state.status === "ready";
      const editable = loaded && state.writable === true && state.revision !== undefined;

      const value = loaded ? (state.value ?? {}) : {};
      const base = loaded ? (state.base ?? {}) : {};
      const user = loaded ? (state.user ?? {}) : {};

      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [secret, setSecret] = React.useState("");
      const [keyBusy, setKeyBusy] = React.useState(false);
      const [keyNotice, setKeyNotice] = React.useState(null);

      const urlId = React.useId();
      const refId = React.useId();
      const keyId = React.useId();
      const countIds = [React.useId(), React.useId(), React.useId(), React.useId()];

      const apiUrl = textOf(draft, value, "apiUrl", DEFAULT_API_URL);
      const apiKeyEnv = textOf(draft, value, "apiKeyEnv", DEFAULT_API_KEY_ENV);
      const reference = apiKeyEnv.trim() || DEFAULT_API_KEY_ENV;

      const [credential, refreshCredential] = useCredential(ctx, reference);
      const dirty = Object.keys(draft).length > 0;
      const disabled = !editable || saving;

      /**
       * Turn the staged drafts into path operations.
       *
       * A staged value equal to the base layer becomes `unset`, so the profile
       * patch keeps recording only what actually departs from the bundle.
       */
      const buildOperations = () => {
        const ops = [];
        const problems = [];
        const stage = (name, next) => {
          if (next === base[name]) ops.push({ op: "unset", path: [name] });
          else ops.push({ op: "set", path: [name], value: next });
        };
        if (Object.prototype.hasOwnProperty.call(draft, "apiUrl")) {
          const trimmed = String(draft.apiUrl).trim();
          if (trimmed === "") problems.push(t("invalidUrl"));
          else stage("apiUrl", trimmed);
        }
        if (Object.prototype.hasOwnProperty.call(draft, "apiKeyEnv")) {
          const trimmed = String(draft.apiKeyEnv).trim();
          stage("apiKeyEnv", trimmed === "" ? DEFAULT_API_KEY_ENV : trimmed);
        }
        for (const field of COUNT_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
          const parsed = Number(String(draft[field]).trim());
          if (!Number.isInteger(parsed) || parsed < 1) problems.push(t("invalidNumber", { field: t(field) }));
          else stage(field, parsed);
        }
        for (const field of TOOL_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
          stage(field, draft[field] === true);
        }
        return { ops, problems };
      };

      const submit = async (ops, problems) => {
        if (problems.length > 0) {
          setNotice({ kind: "error", text: problems.join(" ") });
          return;
        }
        if (ops.length === 0) return;
        setSaving(true);
        setNotice(null);
        try {
          const accepted = await form.mutate(ops, state.revision);
          if (accepted) {
            setDraft({});
            setNotice({ kind: "ok", text: t("saved") });
          } else {
            setNotice({ kind: "error", text: t("saveFailed", { message: t("readOnly") }) });
          }
        } catch (error) {
          setNotice({ kind: "error", text: t("saveFailed", { message: messageOf(error) }) });
        } finally {
          setSaving(false);
        }
      };

      /** Stage an edit; only Save writes it. */
      const edit = (name, next) => {
        setNotice(null);
        setDraft((current) => ({ ...current, [name]: next }));
      };

      /** Clear one field's profile override: an immediate `unset` write. */
      const resetField = async (name) => {
        setDraft((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        await submit([{ op: "unset", path: [name] }], []);
      };

      const saveSecret = async () => {
        const service = credentialNamespace(ctx);
        if (service === undefined || secret.trim() === "") return;
        setKeyBusy(true);
        setKeyNotice(null);
        try {
          await service.set(reference, secret.trim());
          setSecret("");
          setKeyNotice({ kind: "ok", text: t("keySaved") });
          refreshCredential();
        } catch (error) {
          setKeyNotice({ kind: "error", text: messageOf(error) });
        } finally {
          setKeyBusy(false);
        }
      };

      const clearSecret = async () => {
        const service = credentialNamespace(ctx);
        if (service === undefined) return;
        setKeyBusy(true);
        setKeyNotice(null);
        try {
          await service.unset(reference);
          refreshCredential();
        } catch (error) {
          setKeyNotice({ kind: "error", text: messageOf(error) });
        } finally {
          setKeyBusy(false);
        }
      };

      if (view === "summary") {
        return h("p", { className: "fcw-hint" }, t("summary"));
      }
      if (form === undefined) {
        return h("div", null, h(Styles, null), h("p", { className: "fcw-note" }, t("unavailable")));
      }
      if (!loaded) {
        const key = state.status === "unavailable" ? "unavailable" : "loading";
        return h("div", null, h(Styles, null), h("p", { className: "fcw-note" }, t(key)));
      }

      const keyStatus = credential.status === "ready"
        ? (credential.configured ? t("keyConfigured") : t("keyMissing"))
        : credential.status === "error" ? t("keyUnknown") : t("keyLoading");
      // A write is possible exactly when the store reports itself writable. Default
      // to true while the answer is still in flight so the field is not hidden for
      // a moment and then appear, and because this profile's store is writable.
      const keyWritable = credential.status === "loading" || credential.writable === true;

      const countField = (field, id) => h(Field, {
        t,
        id,
        label: t(field),
        hint: t(`${field}Hint`),
        overridden: Object.prototype.hasOwnProperty.call(user, field),
        disabled,
        onReset: () => void resetField(field)
      }, h("input", {
        id,
        className: "fcw-input",
        type: "number",
        min: 1,
        step: 1,
        value: textOf(draft, value, field, COUNT_DEFAULTS[field]),
        disabled,
        onChange: (event) => edit(field, event.target.value)
      }));

      return h("div", { className: "fcw-form" },
        h(Styles, null),

        h(Field, {
          t,
          id: urlId,
          label: t("endpoint"),
          hint: t("endpointHint", { url: apiUrl.trim() || DEFAULT_API_URL }),
          overridden: Object.prototype.hasOwnProperty.call(user, "apiUrl"),
          disabled,
          onReset: () => void resetField("apiUrl")
        }, h("input", {
          id: urlId,
          className: "fcw-input",
          type: "url",
          spellCheck: false,
          value: apiUrl,
          disabled,
          "aria-invalid": apiUrl.trim() === "" ? "true" : undefined,
          onChange: (event) => edit("apiUrl", event.target.value)
        })),

        h(Field, {
          t,
          id: refId,
          label: t("keyReference"),
          hint: t("keyReferenceHint", { ref: reference }),
          overridden: Object.prototype.hasOwnProperty.call(user, "apiKeyEnv"),
          disabled,
          onReset: () => void resetField("apiKeyEnv")
        }, h("input", {
          id: refId,
          className: "fcw-input",
          type: "text",
          spellCheck: false,
          value: apiKeyEnv,
          disabled,
          onChange: (event) => edit("apiKeyEnv", event.target.value)
        })),

        h("hr", { className: "fcw-divider" }),

        h("div", { className: "fcw-field" },
          h("div", { className: "fcw-labelRow" },
            h("span", { className: "fcw-label" }, t("keyStatus")),
            h("span", { className: "fcw-keyValue" }, keyStatus),
            credential.status === "ready" && credential.source !== undefined
              ? h("span", { className: "fcw-badge" }, t("keySource", { source: credential.source }))
              : null,
            credential.status === "ready" && credential.configured && credential.writable
              ? h("button", {
                  type: "button",
                  className: "fcw-button fcw-buttonText",
                  disabled: keyBusy,
                  onClick: () => void clearSecret()
                }, t("keyClear"))
              : null),
          h("p", { className: "fcw-hint" },
            credential.status === "error"
              ? t("keyError", { message: credential.message ?? "" })
              : credential.writable ? t("keyEditable") : t("keyUnwritable")),
          // The input stays visible whenever the store can be written, which is the
          // only condition that decides whether a write can land. An earlier version
          // also required `configured`, so an unset key showed the hint but no way to
          // set one — the one state where the field is most needed.
          keyWritable
            ? h("div", { className: "fcw-secretRow" },
                h("input", {
                  id: keyId,
                  className: "fcw-input",
                  type: "password",
                  autoComplete: "off",
                  spellCheck: false,
                  placeholder: t("keyValuePlaceholder"),
                  "aria-label": t("keyValue"),
                  value: secret,
                  disabled: keyBusy,
                  onChange: (event) => setSecret(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveSecret();
                    }
                  }
                }),
                h("button", {
                  type: "button",
                  className: "fcw-button",
                  disabled: keyBusy || secret.trim() === "",
                  onClick: () => void saveSecret()
                }, keyBusy ? t("keySaving") : t("keySave")))
            : null,
          keyNotice === null ? null : h("p", { className: NOTICE[keyNotice.kind] }, keyNotice.text)),

        h("hr", { className: "fcw-divider" }),

        h("div", { className: "fcw-group" },
          h("h4", { className: "fcw-groupTitle" }, t("tools")),
          ...TOOL_FIELDS.map((field) => h(ToggleRow, {
            key: field,
            label: t(field),
            hint: t(`${field}Hint`),
            checked: boolOf(draft, value, field, true),
            disabled,
            onChange: (next) => edit(field, next)
          }))),

        h("hr", { className: "fcw-divider" }),

        h("div", { className: "fcw-group" },
          h("h4", { className: "fcw-groupTitle" }, t("limits")),
          h("div", { className: "fcw-counts" },
            countField("searchMaxResults", countIds[0]),
            countField("mapMaxResults", countIds[1]),
            countField("crawlMaxResults", countIds[2]),
            countField("maxOutputChars", countIds[3]))),

        h("hr", { className: "fcw-divider" }),

        h("div", { className: "fcw-field" },
          h("span", { className: "fcw-label" }, t("advanced")),
          h("p", { className: "fcw-hint" }, t("advancedHint"))),

        h("div", { className: "fcw-actions" },
          h("button", {
            type: "button",
            className: "fcw-button fcw-buttonPrimary",
            disabled: disabled || !dirty,
            onClick: () => {
              const built = buildOperations();
              void submit(built.ops, built.problems);
            }
          }, saving ? t("saving") : t("save")),
          dirty
            ? h("button", {
                type: "button",
                className: "fcw-button",
                disabled: saving,
                onClick: () => {
                  setDraft({});
                  setNotice(null);
                }
              }, t("discard"))
            : null,
          editable ? null : h("span", { className: "fcw-status" }, t("readOnly")),
          notice === null ? null : h("span", { className: NOTICE[notice.kind] }, notice.text)));
    }

    // -------------------------------------------------------------------------
    // Client plugin entry
    // -------------------------------------------------------------------------

    /** `remote` is a hard dependency because the facade's `$on` carries the
     * credential invalidation; the credential *namespace* is resolved per page
     * through `ctx.get`, so a profile without a controller still renders. */
    const inject = ["slots", "locale", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "tool-firecrawl: dictionaries");
      ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
        name: "plugins.row.config",
        key: ROW_CONFIG_KEY,
        locale: NS,
        inject: () => ({ ctx })
      }, SettingsPage));
    }

    return { inject, apply };
  }
});
