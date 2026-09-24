import z from "@deepseek-ai/schemastery";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { executorProtocol, loopStatusLine, plannerProtocol } from "./protocol.js";

/**
 * dsh-planner-executor-loop
 *
 * 规划-执行循环：规划大模型制定计划并下达任务，执行大模型（子代理）落地执行，
 * 结果回传后由规划者评判，循环往复，最终由规划者调用 loop_complete 判定完工。
 *
 * 实现落在插件自身（mount-only，不改 harness 内部任何行）：
 *   1. agent/request 路由：循环激活的会话，顶层请求强制 planner 路由，
 *      其子代理请求（header.origin === "subagent"，header.parentSession 指回
 *      该会话）强制 executor 路由；未激活循环的会话原样直通。
 *   2. system-prompt/assemble：同步 persona 变量，使前缀与实际路由一致。
 *   3. systemPrompt section/context：按 origin 注入规划者/执行者协议与实时状态。
 *   4. 六个 loop_* 工具：开启 / 逐轮回报 / 状态 / 模型路由 / 完工判定 / 放弃。
 *   5. llm/stream 瀑布：按 provider/model 累计 token 用量，作为分工证据。
 *
 * 模型路由由用户自行更换，三条途径等价、均即时生效：
 *   a. 设置 → 插件 → 「规划-执行循环」卡片（客户端半边 lib/client.js，
 *      是 volatile 字段的表单，直接写 profile 补丁）；
 *   b. 聊天内让模型调用 loop_set_models（走 settings 服务持久化）；
 *   c. 直接编辑 profile cordis.patch.yml 的配置行（dsh-hmr 热重载）。
 *
 * 配置是**扁平字符串字段**（通用设置表单模型按字段名读写，嵌套对象装不进表单）：
 *   plannerProvider / plannerModel / plannerEffort
 *   executorProvider / executorModel / executorEffort
 *   maxRounds
 * provider 或 model 留空 = 该角色未配置（直通，沿用官方模型选择）。
 * 兼容 v0.2.0 的嵌套写法（planner/executor 对象）作为回退，仅告警不报错。
 *
 * 状态为进程内内存态（该版本 harness 对自定义 session 事件 fail-closed）。
 */

const name = "planner-executor-loop";
const inject = ["systemPrompt", "tools"];

/** 合法的扁平配置键。 */
const CONFIG_KEYS = [
	"plannerProvider", "plannerModel", "plannerEffort",
	"executorProvider", "executorModel", "executorEffort",
	"maxRounds"
];
/** v0.2.0 的嵌套写法，作为回退读取。 */
const LEGACY_KEYS = ["planner", "executor"];

/**
 * 插件配置。所有字段都是 volatile：客户端卡片（lib/client.js）通过
 * SettingsFormModel 读写它们，改动立即生效并写回 profile 补丁。
 */
const Config = z.object({
	plannerProvider: z.string().default("").volatile(),
	plannerModel: z.string().default("").volatile(),
	plannerEffort: z.string().default("").volatile(),
	executorProvider: z.string().default("").volatile(),
	executorModel: z.string().default("").volatile(),
	executorEffort: z.string().default("").volatile(),
	maxRounds: z.number().default(8).volatile()
});

/** 校验一条嵌套路由（兼容写法用）。 */
function checkRoute(label, route) {
	if (route === undefined || route === null) throw new Error(`dsh-planner-executor-loop needs a ${label} route`);
	if (typeof route.provider !== "string" || route.provider.trim() === "") throw new Error(`dsh-planner-executor-loop ${label} 路由需要非空 provider`);
	if (typeof route.model !== "string" || route.model.trim() === "") throw new Error(`dsh-planner-executor-loop ${label} 路由需要非空 model`);
	if (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== "string" || route.reasoningEffort.trim() === "")) throw new Error(`dsh-planner-executor-loop ${label} 路由的 reasoningEffort 需为非空字符串`);
	return {
		provider: route.provider,
		model: route.model,
		...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
	};
}

/** volatile 包装值在每次读取时解包（表单改动由此实时可见）。 */
function unwrapVolatile(value) {
	return isVolatile(value) ? value.get() : value;
}

/**
 * 把一条已解析的请求配置切到目标路由（照抄 dsh-role-router 的既证语义）。
 * 路由变化时丢弃继承的 adapter 侧 reasoningEffort，除非目标显式给了档位。
 */
function switchRoute(resolved, target) {
	const sameRoute = resolved.provider === target.provider && resolved.model === target.model;
	const effort = target.reasoningEffort;
	if (sameRoute && effort === undefined) return resolved;
	const { reasoningEffort: _inherited, ...rest } = resolved;
	return {
		...(sameRoute ? resolved : rest),
		provider: target.provider,
		model: target.model,
		...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) })
	};
}

/** 工具侧的会话键：拿不到 agent 时退回全局单例。 */
function toolSessionKey(exec) {
	const id = exec?.agent?.session?.id;
	return id === undefined ? "__global__" : String(id);
}

/** 文本型工具输出。 */
const textOutput = {
	schema: { type: "string" },
	render: (_args, result) => [{ type: "text", text: String(result) }]
};

/** 路由的展示文本。 */
function routeLabel(route) {
	return route === undefined ? "未配置（直通，沿用官方模型选择）" : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : `（effort ${route.reasoningEffort}）`}`;
}

/** 把一条路由拆成扁平字段（loop_set_models 写入用）。 */
function routeToFields(prefix, route) {
	return {
		[`${prefix}Provider`]: route.provider,
		[`${prefix}Model`]: route.model,
		[`${prefix}Effort`]: route.reasoningEffort ?? ""
	};
}

function apply(ctx, config) {
	// ── 加载期严格校验：未知键、初始值错误早暴露 ─────────────────────────────
	const unknown = Object.keys(config ?? {}).filter((key) => !CONFIG_KEYS.includes(key) && !LEGACY_KEYS.includes(key));
	if (unknown.length > 0) throw new Error(`dsh-planner-executor-loop config 有未知键 ${unknown.join(", ")} —— 合法键为 ${CONFIG_KEYS.join(" / ")}`);
	for (const label of LEGACY_KEYS) {
		const legacy = unwrapVolatile(config[label]);
		if (legacy !== undefined && legacy !== null) {
			ctx.logger.warn("dsh-planner-executor-loop: config.%s 是 v0.2.0 的嵌套写法，已按回退值读取；建议改用扁平字段（%sProvider / %sModel / %sEffort）或设置页卡片", label, label, label, label);
		}
	}
	{
		const initialRounds = unwrapVolatile(config.maxRounds) ?? 8;
		if (!Number.isInteger(initialRounds) || initialRounds < 1) throw new Error("dsh-planner-executor-loop 的 maxRounds 必须是不小于 1 的整数");
	}

	// ── settings 服务（可选）：loop_set_models 的持久化通道 ──────────────────
	let settingsService = null;
	ctx.inject(["settings"], (settingsCtx) => { settingsService = settingsCtx.settings; });
	// 无 settings 服务时的内存回退（重启失效）。
	const runtimeOverrides = {};

	/**
	 * 每次使用时重新解析当前组合：volatile 字段实时解包，运行期改动优先。
	 * 单条路由无效时降级为"未配置"并告警，绝不在请求路径上抛错。
	 */
	function currentComposition() {
		const read = (key) => {
			const raw = runtimeOverrides[key] !== undefined ? runtimeOverrides[key] : unwrapVolatile(config[key]);
			if (raw === undefined || raw === null) return "";
			return String(raw).trim();
		};
		/** 嵌套回退值（v0.2.0 写法）。 */
		const legacyRoute = (label) => {
			const raw = unwrapVolatile(config[label]);
			if (raw === undefined || raw === null) return undefined;
			try {
				return checkRoute(label, raw);
			} catch (error) {
				ctx.logger.warn("dsh-planner-executor-loop: %s 回退路由无效，已忽略：%s", label, error);
				return undefined;
			}
		};
		const routeFromFlat = (label) => {
			const provider = read(`${label}Provider`);
			const model = read(`${label}Model`);
			const effort = read(`${label}Effort`);
			if (provider !== "" && model !== "") return { provider, model, ...(effort === "" ? {} : { reasoningEffort: effort }) };
			if (provider !== "" || model !== "") ctx.logger.warn("dsh-planner-executor-loop: %s 的 provider/model 只填了一半，按未配置（直通）处理", label);
			return legacyRoute(label);
		};
		let maxRounds = runtimeOverrides.maxRounds !== undefined ? runtimeOverrides.maxRounds : unwrapVolatile(config.maxRounds);
		if (!Number.isInteger(maxRounds) || maxRounds < 1) {
			ctx.logger.warn("dsh-planner-executor-loop: maxRounds 无效，回退为 8");
			maxRounds = 8;
		}
		return { planner: routeFromFlat("planner"), executor: routeFromFlat("executor"), maxRounds };
	}

	// ── 循环状态：sessionId → state（进程内，重启即失） ─────────────────────
	const loops = new Map();

	// ── 按 provider/model 的 token 用量（进程内累计） ────────────────────────
	const usageByRoute = new Map();

	function recordUsage(provider, model, usage) {
		if (usage === undefined || usage === null) return;
		const key = `${provider}\0${model}`;
		let entry = usageByRoute.get(key);
		if (entry === undefined) {
			entry = { provider, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
			usageByRoute.set(key, entry);
		}
		entry.inputTokens += usage.inputTokens ?? 0;
		entry.outputTokens += usage.outputTokens ?? 0;
		entry.cacheReadTokens += usage.cacheReadTokens ?? 0;
		entry.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		entry.requests += 1;
	}

	// llm/stream 是所有模型调用都要经过的瀑布；global: true 覆盖子代理。
	ctx.on("llm/stream", (options, next) => {
		const provider = options.provider;
		const model = options.model;
		return (async function* () {
			for await (const chunk of next()) {
				if (chunk.type === "usage" && chunk.usage !== undefined) recordUsage(provider, model, chunk.usage);
				yield chunk;
			}
		})();
	}, { global: true });

	// ── 该 agent 是否处在激活循环中（子代理看父会话） ───────────────────────
	function activeLoopFor(agent) {
		const header = agent?.session?.header;
		if (header === undefined || header === null) return undefined;
		if (header.origin === "subagent") {
			const parent = header.parentSession;
			if (parent === undefined) return undefined;
			const st = loops.get(String(parent));
			return st !== undefined && st.status === "active" ? st : undefined;
		}
		const id = agent?.session?.id;
		if (id === undefined) return undefined;
		const st = loops.get(String(id));
		return st !== undefined && st.status === "active" ? st : undefined;
	}

	// 该 agent 在循环中的目标路由：子代理 → executor，顶层 → planner。
	function routeTargetFor(agent, composition) {
		const header = agent?.session?.header;
		if (header === undefined || header === null) return undefined;
		if (header.origin === "subagent") return composition.executor;
		return composition.planner;
	}

	// ── 模型路由：只在循环激活的会话里接管，其余会话零影响 ──────────────────
	ctx.on("agent/request", async ({ agent }, next) => {
		const resolved = await next();
		if (agent === undefined) return resolved;
		if (activeLoopFor(agent) === undefined) return resolved;
		const target = routeTargetFor(agent, currentComposition());
		return target === undefined ? resolved : switchRoute(resolved, target);
	});

	// persona 变量同步：让 "powered by the {{model}} model" 与实际路由一致。
	ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
		const assembled = await next();
		const agent = context?.agent;
		if (agent === undefined) return assembled;
		if (activeLoopFor(agent) === undefined) return assembled;
		const target = routeTargetFor(agent, currentComposition());
		if (target === undefined) return assembled;
		return { ...assembled, variables: { ...assembled.variables, provider: target.provider, model: target.model } };
	});

	// ── 协议注入：一个全局 section 按 origin 分支 ────────────────────────────
	ctx.systemPrompt.section({
		name: "planner-executor-loop",
		order: 400,
		text: (context) => {
			const header = context?.agent?.session?.header;
			if (header !== undefined && header !== null && header.origin === "subagent") {
				const parent = header.parentSession;
				const st = parent === undefined ? undefined : loops.get(String(parent));
				return st !== undefined && st.status === "active" ? executorProtocol() : "";
			}
			return plannerProtocol(currentComposition());
		}
	});

	// ── 运行时状态行：循环激活时每回合可见 ──────────────────────────────────
	ctx.systemPrompt.context({
		name: "planner-executor-loop",
		order: 300,
		text: (context) => {
			const loop = activeLoopFor(context?.agent);
			return loop === undefined ? "" : loopStatusLine(loop, currentComposition());
		}
	});

	// ── 用量文本 ─────────────────────────────────────────────────────────────
	function usageLines() {
		const rows = [...usageByRoute.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
		if (rows.length === 0) return ["（本进程尚无模型调用记录）"];
		return rows.map((r) => `- ${r.provider}/${r.model}：输入 ${r.inputTokens}，输出 ${r.outputTokens}，缓存读 ${r.cacheReadTokens}，请求 ${r.requests} 次`);
	}

	// ── 工具：loop_begin ─────────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "loop_begin",
		description: "开启一个规划-执行循环：登记目标与计划。之后由你（规划者）拆解任务并用 subagent 工具派发给执行模型，循环验收直至 loop_complete 判定完工。本会话已有激活循环时，需要 restart: true 才能重开。",
		parameters: {
			goal: { type: "string", required: true, description: "一句话目标，含可判定的成功标准" },
			plan: { type: "string", required: true, description: "结构化计划 markdown：步骤 / 涉及文件 / 每步完成判据" },
			restart: { type: "boolean", description: "本会话已有激活循环时传 true 覆盖重开" }
		},
		output: textOutput,
		isConcurrencySafe: () => false,
		execute(args, exec) {
			const key = toolSessionKey(exec);
			const existing = loops.get(key);
			if (existing !== undefined && existing.status === "active" && args.restart !== true) {
				return `拒绝：本会话已有激活循环（目标：${existing.goal}；已登记到第 ${existing.round} 轮）。如需重开，以 restart: true 再次调用。`;
			}
			const goal = String(args.goal ?? "").trim();
			const plan = String(args.plan ?? "").trim();
			if (goal === "" || plan === "") return "拒绝：goal 与 plan 都必须非空。";
			loops.set(key, { goal, plan, round: 0, rounds: [], status: "active", startedAt: new Date().toISOString() });
			const composition = currentComposition();
			const plannerLine = composition.planner === undefined
				? "规划模型沿用本会话当前选择。"
				: `本会话的规划请求自下一步起路由到 ${routeLabel(composition.planner)}。`;
			const executorLine = composition.executor === undefined
				? "执行模型沿用子代理默认（未配置 executor 路由）。"
				: `执行模型已固定为 ${routeLabel(composition.executor)}，派发时不要传 provider/model 参数。`;
			return [
				`循环已开启（第 0 轮，上限 ${composition.maxRounds}）。${plannerLine}`,
				executorLine,
				"下一步：用 subagent 工具派发第一批任务——prompt 必须自包含（子代理看不到本对话）并写明完成判据；相互独立的任务并行派发。任务全部返回后调用 round_report 登记第 1 轮。"
			].join("\n");
		}
	}));

	// ── 工具：round_report ───────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "round_report",
		description: "登记循环中一轮的执行结果：每个派发任务的判定（pass/partial/fail）与证据，以及下一轮打算解决什么。轮次编号从 1 开始逐轮 +1；达到 maxRounds 后本工具会拒绝，只能 loop_complete 或 loop_abandon。",
		parameters: {
			round: { type: "integer", required: true, description: "轮次编号（= 已登记轮数 + 1）" },
			results: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						task: { type: "string", required: true, description: "任务标题，与派发时一致" },
						status: { type: "string", required: true, description: "pass | partial | fail" },
						evidence: { type: "string", required: true, description: "判定依据：命令与输出 / 文件与行号" }
					}
				}
			},
			next_action: { type: "string", description: "下一轮要解决什么；无则留空" }
		},
		output: textOutput,
		isConcurrencySafe: () => false,
		execute(args, exec) {
			const key = toolSessionKey(exec);
			const st = loops.get(key);
			const composition = currentComposition();
			if (st === undefined || st.status !== "active") return "拒绝：本会话没有激活的循环。先调用 loop_begin。";
			if (st.round + 1 > composition.maxRounds) return `拒绝：已达最大轮数 ${composition.maxRounds}。现在只能 loop_complete（对未达标项给出 waivers 豁免理由）或 loop_abandon。`;
			const round = args.round;
			if (!Number.isInteger(round) || round !== st.round + 1) return `拒绝：round 应为 ${st.round + 1}（当前已登记到第 ${st.round} 轮）。`;
			const results = Array.isArray(args.results) ? args.results : [];
			if (results.length === 0) return "拒绝：results 不能为空——本轮每个派发任务都要有判定。";
			for (const r of results) {
				const task = String(r?.task ?? "").trim();
				const status = String(r?.status ?? "").trim();
				if (task === "") return "拒绝：存在 task 为空的结果条目。";
				if (!["pass", "partial", "fail"].includes(status)) return `拒绝：任务「${task}」的 status 必须是 pass / partial / fail。`;
			}
			st.round = round;
			st.rounds.push({
				round,
				results: results.map((r) => ({ task: String(r.task), status: String(r.status), evidence: String(r.evidence ?? "") })),
				nextAction: String(args.next_action ?? "")
			});
			const pass = results.filter((r) => String(r.status) === "pass").length;
			const remaining = composition.maxRounds - st.round;
			const tail = remaining <= 0
				? "已达轮次上限：下一步只能是 loop_complete（附豁免理由）或 loop_abandon。"
				: `剩余轮次预算 ${remaining}。继续派发修正任务，或验收后 loop_complete。`;
			return `第 ${round} 轮已登记：${pass}/${results.length} 个任务通过。${tail}`;
		}
	}));

	// ── 工具：loop_set_models ────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "loop_set_models",
		description: "查看或更改规划-执行循环的模型路由与轮次上限。不传任何字段时仅查看当前配置。仅在用户明确要求更换模型/档位/轮数时调用；改动立即生效并持久化到 profile 配置。",
		parameters: {
			planner: {
				type: "object",
				additionalProperties: false,
				properties: {
					provider: { type: "string", required: true, description: "规划模型供应商 id，如 zai-coding-cn、deepseek-official" },
					model: { type: "string", required: true, description: "规划模型 id，如 glm-5.3、deepseek-v4-pro" },
					reasoningEffort: { type: "string", description: "推理档位：off | low | high | max（GLM-5.3 系必须显式给）" }
				}
			},
			executor: {
				type: "object",
				additionalProperties: false,
				properties: {
					provider: { type: "string", required: true, description: "执行模型供应商 id" },
					model: { type: "string", required: true, description: "执行模型 id，如 deepseek-flash、deepseek-v4-pro" },
					reasoningEffort: { type: "string", description: "推理档位：off | low | high | max" }
				}
			},
			maxRounds: { type: "integer", description: "循环轮次上限（≥1）" },
			reset: { type: "boolean", description: "true 时先把此前改动重置回配置文件的基础值，再应用本次给出的字段" }
		},
		output: textOutput,
		isConcurrencySafe: () => false,
		async execute(args, _exec) {
			const hasChange = args.planner !== undefined || args.executor !== undefined || args.maxRounds !== undefined;
			if (!hasChange && args.reset !== true) {
				const composition = currentComposition();
				return [
					"当前配置（未做改动）：",
					`- planner：${routeLabel(composition.planner)}`,
					`- executor：${routeLabel(composition.executor)}`,
					`- maxRounds：${composition.maxRounds}`,
					"要更换时传入对应字段，例如 executor: { provider: \"deepseek-official\", model: \"deepseek-v4-pro\" }；也可在「设置 → 插件 → 规划-执行循环」卡片里直接选。"
				].join("\n");
			}
			const patch = {};
			for (const role of ["planner", "executor"]) {
				if (args[role] === undefined) continue;
				let route;
				try {
					route = checkRoute(role, args[role]);
				} catch (error) {
					return `拒绝：${String(error)}`;
				}
				Object.assign(patch, routeToFields(role, route));
			}
			if (args.maxRounds !== undefined) {
				if (!Number.isInteger(args.maxRounds) || args.maxRounds < 1) return "拒绝：maxRounds 必须是不小于 1 的整数。";
				patch.maxRounds = args.maxRounds;
			}
			let persisted;
			if (settingsService !== null) {
				try {
					if (args.reset === true) await settingsService.replace("planner-executor-loop", patch);
					else await settingsService.update("planner-executor-loop", patch);
					persisted = "已持久化到 profile 配置（重启后仍生效）。";
				} catch (error) {
					return `拒绝：写入配置失败（${String(error)}）。未做任何改动；可改用设置页卡片或直接编辑 profile 的 cordis.patch.yml。`;
				}
			} else {
				if (args.reset === true) for (const key of CONFIG_KEYS) delete runtimeOverrides[key];
				Object.assign(runtimeOverrides, patch);
				persisted = "当前环境没有 settings 服务，改动仅在本进程内生效（重启后回到配置文件的基础值）。";
			}
			const composition = currentComposition();
			return [
				`配置已更新。${persisted}`,
				`- planner：${routeLabel(composition.planner)}`,
				`- executor：${routeLabel(composition.executor)}`,
				`- maxRounds：${composition.maxRounds}`,
				"路由即刻生效：循环激活的会话按新配置接管，未激活的会话不受影响。"
			].join("\n");
		}
	}));

	// ── 工具：loop_status ────────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "loop_status",
		description: "查看当前会话的规划-执行循环状态：目标、轮次、各轮任务判定、下一步、当前模型路由，以及按 provider/model 累计的 token 用量（验证规划/执行分工是否真的发生）。",
		parameters: {},
		output: textOutput,
		isConcurrencySafe: () => true,
		execute(_args, exec) {
			const composition = currentComposition();
			const lines = [
				`模型路由：planner=${routeLabel(composition.planner)}；executor=${routeLabel(composition.executor)}；maxRounds=${composition.maxRounds}（更换用 loop_set_models 或设置页卡片）`
			];
			const key = toolSessionKey(exec);
			const st = loops.get(key);
			if (st === undefined) {
				lines.push("当前会话没有循环记录（进程内状态，重启后清空）。");
				lines.push("模型用量（本进程累计，含非循环会话）：", ...usageLines());
				return lines.join("\n");
			}
			lines.push(`目标：${st.goal}`, `状态：${st.status}（第 ${st.round}/${composition.maxRounds} 轮，开始于 ${st.startedAt}）`);
			if (st.rounds.length === 0) {
				lines.push("尚未登记任何轮次。");
			} else {
				for (const r of st.rounds) {
					const pass = r.results.filter((x) => x.status === "pass").length;
					lines.push(`- 第 ${r.round} 轮：${pass}/${r.results.length} 通过${r.nextAction === "" ? "" : `；下一步：${r.nextAction}`}`);
					for (const item of r.results) lines.push(`    · ${item.task} [${item.status}]`);
				}
			}
			if (st.status === "complete" && st.summary !== undefined) lines.push(`完工摘要：${st.summary}`);
			if (st.status === "abandoned" && st.reason !== undefined) lines.push(`放弃原因：${st.reason}`);
			lines.push("模型用量（本进程累计，含非循环会话）：", ...usageLines());
			return lines.join("\n");
		}
	}));

	// ── 工具：loop_complete ──────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "loop_complete",
		description: "宣告循环完工（唯一有效的完工方式）。要求：至少登记过一轮结果；每条验收标准要么 met: true，要么在 waivers 中给出豁免理由；每个未通过（partial/fail）的任务同样需要豁免。守卫不通过会拒绝并指出缺什么。",
		parameters: {
			summary: { type: "string", required: true, description: "最终交付摘要" },
			acceptance: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						criterion: { type: "string", required: true, description: "验收标准（来自 goal/plan）" },
						met: { type: "boolean", required: true, description: "是否满足" },
						evidence: { type: "string", required: true, description: "证据：命令与输出 / 文件与行号" }
					}
				}
			},
			waivers: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						criterion: { type: "string", required: true, description: "未达标项（任务标题或验收标准）" },
						reason: { type: "string", required: true, description: "豁免理由" }
					}
				}
			}
		},
		output: textOutput,
		isConcurrencySafe: () => false,
		execute(args, exec) {
			const key = toolSessionKey(exec);
			const st = loops.get(key);
			if (st === undefined || st.status !== "active") return "拒绝：本会话没有激活的循环。";
			if (st.rounds.length === 0) return "拒绝：还没有执行过任何一轮（round_report 为空），不能宣告完工。规划-执行循环必须先执行再判定。";
			const acceptance = Array.isArray(args.acceptance) ? args.acceptance : [];
			if (acceptance.length === 0) return "拒绝：acceptance 不能为空——完工判定必须逐条对照验收标准。";
			const waivers = Array.isArray(args.waivers) ? args.waivers : [];
			const waiverSet = new Set(waivers.map((w) => String(w?.criterion ?? "").trim()).filter((s) => s !== ""));
			// 任务以「最后一次出现的状态」为准。
			const lastByTask = new Map();
			for (const r of st.rounds) for (const item of r.results) lastByTask.set(item.task, item.status);
			const problems = [];
			for (const [task, status] of lastByTask) {
				if (status !== "pass" && !waiverSet.has(task)) problems.push(`任务未通过且未豁免：${task}（${status}）`);
			}
			for (const a of acceptance) {
				const criterion = String(a?.criterion ?? "").trim();
				if (criterion === "") return "拒绝：acceptance 存在空的 criterion。";
				if (a?.met !== true && !waiverSet.has(criterion)) problems.push(`验收标准未满足且未豁免：${criterion}`);
			}
			if (problems.length > 0) {
				return ["拒绝完工，以下问题需要处理（补齐豁免理由，或继续派发修正任务后重新判定）：", ...problems.map((p) => `- ${p}`)].join("\n");
			}
			st.status = "complete";
			st.summary = String(args.summary ?? "");
			st.completedAt = new Date().toISOString();
			return [
				`循环已判定完工（第 ${st.round} 轮，共 ${st.rounds.length} 轮登记）。`,
				`摘要：${st.summary}`,
				"模型用量（本进程累计）：",
				...usageLines()
			].join("\n");
		}
	}));

	// ── 工具：loop_abandon ───────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		name: "loop_abandon",
		description: "放弃当前循环（无法在轮次预算内达标、或目标本身不可行时使用）。需要给出原因；放弃后本会话可重新 loop_begin。",
		parameters: {
			reason: { type: "string", required: true, description: "放弃原因与已完成/未完成的边界" }
		},
		output: textOutput,
		isConcurrencySafe: () => false,
		execute(args, exec) {
			const key = toolSessionKey(exec);
			const st = loops.get(key);
			if (st === undefined || st.status !== "active") return "拒绝：本会话没有激活的循环。";
			const reason = String(args.reason ?? "").trim();
			if (reason === "") return "拒绝：reason 必须非空——说清楚为什么放弃、做到哪一步。";
			st.status = "abandoned";
			st.reason = reason;
			st.abandonedAt = new Date().toISOString();
			return `循环已放弃（第 ${st.round} 轮）。原因：${reason}`;
		}
	}));
}

export { Config, apply, inject, name };
