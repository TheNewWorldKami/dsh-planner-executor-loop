/**
 * dsh-planner-executor-loop —— 浏览器半边：设置页里的「规划-执行循环」卡片。
 *
 * 卡片注册进 Plugins 页的 `plugins.item` 槽位（设置 → 插件），仅在宿主
 * 提供本命名空间时出现；三个区的控件（规划模型 / 执行模型 / 轮次上限）
 * 通过 SettingsFormModel 暂存并一次保存，写入 profile 补丁后即时生效。
 *
 * 模型下拉的选项来自宿主世代全局模型目录（`remote.session.modelCatalog()`），
 * 无需当前会话；保存的旧值即使已从目录消失也会作为「当前值」保留可选项。
 *
 * 失败策略：挂载问题只记日志绝不抛出——客户端 apply 抛错会让整个 Web 外壳
 * 启动失败，外部插件不得把界面拖下水。
 */
window.__ModuleLoader__.load({
	id: "dsh-planner-executor-loop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		const NS = "planner-executor-loop";
		const EFFORTS = ["", "off", "low", "high", "max"];
		const FIELDS = [
			"plannerProvider", "plannerModel", "plannerEffort",
			"executorProvider", "executorModel", "executorEffort",
			"maxRounds"
		];

		const en = {
			"card.title": "Planner-executor loop",
			"card.description": "Model routing for the planner-executor loop: which model plans and dispatches, which model executes.",
			"unavailable": "This plugin is not loaded, so it cannot be configured right now.",
			"readOnly": "This deployment stores settings read-only.",
			"save": "Save",
			"saving": "Saving…",
			"saveFailed": "The deployment did not accept these values; they were left for you to correct.",
			"planner.title": "Planner model",
			"planner.hint": "Plans the work, dispatches tasks, and judges completion. Requests in a loop session route here.",
			"executor.title": "Executor model",
			"executor.hint": "Every dispatched subagent runs here. The planner must not pass provider/model when dispatching.",
			"loop.title": "Loop",
			"loop.hint": "Maximum rounds before the planner must complete or abandon the loop.",
			"provider.label": "Provider",
			"model.label": "Model",
			"effort.label": "Reasoning effort",
			"maxRounds.label": "Maximum rounds",
			"unset": "Not configured (pass-through)",
			"unsetEffort": "Provider default",
			"currentValue": "current",
			"reset": "Reset",
			"catalog.loading": "Loading models…",
			"catalog.failed": "Could not load the model catalog",
			"catalog.retry": "Retry",
			"catalog.empty": "No model provider currently advertises a model."
		};
		const zh = {
			"card.title": "规划-执行循环",
			"card.description": "规划-执行循环的模型路由：哪个模型负责规划与下达，哪个模型负责执行。",
			"unavailable": "该插件当前未加载，暂时无法配置。",
			"readOnly": "本部署的设置是只读的。",
			"save": "保存",
			"saving": "保存中…",
			"saveFailed": "本部署没有接受这些值，已保留供你修改。",
			"planner.title": "规划模型",
			"planner.hint": "负责制定计划、下达任务、评判结果与判定完工；循环激活后本会话的请求路由到这里。",
			"executor.title": "执行模型",
			"executor.hint": "被派发的每个子代理都跑在这里；规划者派发时不要传 provider/model 参数。",
			"loop.title": "循环",
			"loop.hint": "最大轮数，超过后规划者只能宣告完工或放弃。",
			"provider.label": "供应商",
			"model.label": "模型",
			"effort.label": "推理档位",
			"maxRounds.label": "最大轮数",
			"unset": "未配置（直通）",
			"unsetEffort": "跟随供应商默认",
			"currentValue": "当前值",
			"reset": "重置",
			"catalog.loading": "正在加载模型…",
			"catalog.failed": "无法加载模型目录",
			"catalog.retry": "重试",
			"catalog.empty": "当前没有模型供应商公布模型。"
		};

		const styles = {
			section: { minWidth: 0, padding: "14px 0", borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
			heading: { margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			hint: { margin: "0 0 10px", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 100%), 1fr))", gap: 12 },
			field: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
			labelRow: { display: "flex", alignItems: "center", gap: 6, minHeight: 18 },
			label: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
			select: {
				width: "100%", minWidth: 0, boxSizing: "border-box", font: "inherit", fontSize: 13,
				padding: "6px 8px", borderRadius: 6, color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-primary)", border: "0.5px solid var(--dsw-alias-border-l2)"
			},
			reset: {
				font: "inherit", fontSize: 11, padding: "0 4px", cursor: "pointer", color: "var(--dsw-alias-label-tertiary)",
				background: "transparent", border: "none", textDecoration: "underline"
			},
			notice: { margin: "8px 0 0", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }
		};

		/** 一个下拉字段：标签 + select + 可选重置。 */
		function SelectField(props) {
			const { id, label, value, options, placeholder, disabled, onEdit, onReset, overridden } = props;
			const children = [];
			const hasValue = value !== undefined && value !== null && value !== "";
			const known = (options ?? []).some((option) => option.value === value);
			children.push(React.createElement("option", { key: "__unset", value: "" }, placeholder));
			for (const option of options ?? []) {
				children.push(React.createElement("option", { key: option.value, value: option.value }, option.label));
			}
			if (hasValue && !known) {
				children.push(React.createElement("option", { key: "__current", value }, `${value}`));
			}
			return React.createElement("div", { style: styles.field }, [
				React.createElement("div", { key: "label", style: styles.labelRow }, [
					React.createElement("label", { key: "l", style: styles.label, htmlFor: id }, label),
					overridden === true && onReset !== undefined
						? React.createElement("button", { key: "r", type: "button", style: styles.reset, disabled, onClick: onReset }, props.resetLabel)
						: null
				]),
				React.createElement("select", {
					key: "select", id, style: styles.select, value: hasValue ? value : "", disabled,
					onChange: (event) => onEdit(event.target.value)
				}, children)
			]);
		}

		/** 一个角色（规划者 / 执行者）的三个控件。 */
		function RoleFields(props) {
			const { t, state, groups, disabled, edit, resetField } = props;
			const { prefix, titleKey, hintKey } = props;
			const provider = state[`${prefix}Provider`];
			const model = state[`${prefix}Model`];
			const effort = state[`${prefix}Effort`];
			const group = (groups ?? []).find((candidate) => candidate.id === provider.text);
			const modelOptions = (group?.models ?? []).map((entry) => ({ value: entry.id, label: entry.name ?? entry.id }));
			return React.createElement("section", { style: styles.section }, [
				React.createElement("h3", { key: "h", style: styles.heading }, t(titleKey)),
				React.createElement("p", { key: "p", style: styles.hint }, t(hintKey)),
				React.createElement("div", { key: "g", style: styles.grid }, [
					React.createElement(SelectField, {
						key: "provider", id: `planner-executor-loop-${prefix}-provider`, label: t("provider.label"),
						value: provider.text, placeholder: t("unset"), resetLabel: t("reset"),
						options: (groups ?? []).map((entry) => ({ value: entry.id, label: entry.name ?? entry.id })),
						disabled, overridden: provider.overridden,
						onEdit: (next) => edit(`${prefix}Provider`, next),
						onReset: () => resetField(`${prefix}Provider`)
					}),
					React.createElement(SelectField, {
						key: "model", id: `planner-executor-loop-${prefix}-model`, label: t("model.label"),
						value: model.text, placeholder: t("unset"), resetLabel: t("reset"),
						options: modelOptions, disabled, overridden: model.overridden,
						onEdit: (next) => edit(`${prefix}Model`, next),
						onReset: () => resetField(`${prefix}Model`)
					}),
					React.createElement(SelectField, {
						key: "effort", id: `planner-executor-loop-${prefix}-effort`, label: t("effort.label"),
						value: effort.text, placeholder: t("unsetEffort"), resetLabel: t("reset"),
						options: EFFORTS.filter((value) => value !== "").map((value) => ({ value, label: value })),
						disabled, overridden: effort.overridden,
						onEdit: (next) => edit(`${prefix}Effort`, next),
						onReset: () => resetField(`${prefix}Effort`)
					})
				])
			]);
		}

		/** 卡片本体：摘要行或完整表单。 */
		function PlannerExecutorLoopCard(props) {
			const { t } = props;
			if (props.view === "summary") return React.createElement("span", null, t("card.description"));
			const state = props.usePlannerExecutorLoopCard((snapshot) => snapshot);
			const catalog = props.usePlannerExecutorLoopCatalog((snapshot) => snapshot);
			const groups = catalog.groups ?? [];
			const formState = {
				available: state.available, writable: state.writable, dirty: state.dirty,
				invalid: state.invalid, saving: state.saving, failed: state.failed
			};
			const children = [
				React.createElement(RoleFields, {
					key: "planner", t, state, groups, prefix: "planner",
					titleKey: "planner.title", hintKey: "planner.hint",
					disabled: !state.writable || state.saving, edit: props.edit, resetField: props.resetField
				}),
				React.createElement(RoleFields, {
					key: "executor", t, state, groups, prefix: "executor",
					titleKey: "executor.title", hintKey: "executor.hint",
					disabled: !state.writable || state.saving, edit: props.edit, resetField: props.resetField
				}),
				React.createElement("section", { key: "loop", style: styles.section }, [
					React.createElement("h3", { key: "h", style: styles.heading }, t("loop.title")),
					React.createElement("p", { key: "p", style: styles.hint }, t("loop.hint")),
					React.createElement("div", { key: "g", style: styles.grid }, [
						React.createElement(primitives.SettingsValueField, {
							key: "rounds", id: "planner-executor-loop-max-rounds", label: t("maxRounds.label"),
							numeric: true, text: state.maxRounds.text, invalid: state.maxRounds.invalid,
							overridden: state.maxRounds.overridden, resetLabel: t("reset"),
							disabled: !state.writable || state.saving,
							onEdit: (next) => props.edit("maxRounds", next),
							onReset: () => props.resetField("maxRounds")
						})
					])
				])
			];
			const notices = [];
			if (catalog.status === "loading") notices.push(React.createElement("p", { key: "load", style: styles.notice }, t("catalog.loading")));
			if (catalog.status === "error") {
				notices.push(React.createElement("p", { key: "err", style: styles.notice }, [
					`${t("catalog.failed")}：${catalog.error ?? ""} `,
					React.createElement("button", { key: "retry", type: "button", style: styles.reset, onClick: () => props.reloadCatalog() }, t("catalog.retry"))
				]));
			}
			if (catalog.status === "ready" && groups.length === 0) notices.push(React.createElement("p", { key: "empty", style: styles.notice }, t("catalog.empty")));
			return React.createElement(primitives.SettingsForm, {
				labels: {
					unavailable: t("unavailable"), readOnly: t("readOnly"),
					saveFailed: t("saveFailed"), save: t("save"), saving: t("saving")
				},
				state: formState,
				onSave: props.save,
				onDiscard: props.discard
			}, [...children, ...notices]);
		}

		const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

		function apply(ctx) {
			try {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "planner-executor-loop: dictionaries");

				const form = new primitives.SettingsFormModel(
					ctx.configForms.get(NS),
					[
						primitives.settingsTextField("plannerProvider"),
						primitives.settingsTextField("plannerModel"),
						primitives.settingsTextField("plannerEffort"),
						primitives.settingsTextField("executorProvider"),
						primitives.settingsTextField("executorModel"),
						primitives.settingsTextField("executorEffort"),
						primitives.settingsNumberField("maxRounds")
					]
				);
				const store = form.bind(() => {
					const projected = { ...form.shell() };
					for (const field of FIELDS) projected[field] = form.field(field);
					return projected;
				});
				ctx.effect(() => () => form.dispose(), "planner-executor-loop: form model");

				// ── 模型目录（宿主世代全局目录，无需当前会话） ──────────────────
				const catalog = createSnapshotStore({ status: "idle", groups: [], error: null });
				let generation = 0;
				const loadCatalog = async () => {
					const current = ++generation;
					catalog.update((snapshot) => { snapshot.status = "loading"; snapshot.error = null; });
					let response;
					try {
						response = await ctx.remote.session.modelCatalog();
					} catch (error) {
						if (current !== generation) return;
						catalog.update((snapshot) => { snapshot.status = "error"; snapshot.error = String(error); });
						return;
					}
					if (current !== generation) return;
					if (!response.ok) {
						catalog.update((snapshot) => { snapshot.status = "error"; snapshot.error = response.error?.message ?? response.error?.code ?? "unknown"; });
						return;
					}
					catalog.update((snapshot) => {
						snapshot.groups = response.value.groups ?? [];
						snapshot.status = "ready";
						snapshot.error = null;
					});
				};
				ctx.effect(() => {
					void loadCatalog();
					const disposers = [
						ctx.remote.$on("llm/adapters-updated", () => void loadCatalog()),
						ctx.remote.$on("settings/document-updated", () => void loadCatalog()),
						ctx.on("connection/reset", () => void loadCatalog())
					];
					return () => {
						for (const dispose of disposers) dispose();
					};
				}, "planner-executor-loop: model catalog");

				const face = {
					hooks: { plannerExecutorLoopCard: store, plannerExecutorLoopCatalog: catalog },
					edit: form.actions().edit,
					resetField: form.actions().resetField,
					save: form.actions().save,
					discard: form.actions().discard,
					reloadCatalog: () => void loadCatalog()
				};
				ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: NS,
					order: 60,
					label: () => t("card.title"),
					locale: NS,
					inject: () => face
				}, PlannerExecutorLoopCard))), "planner-executor-loop: settings card");
			} catch (error) {
				ctx.logger?.warn?.("planner-executor-loop: client half failed to mount", error);
			}
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
