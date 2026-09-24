中文 | [English](README.md)

# dsh-planner-executor-loop

DeepSeek Harness（DSH）插件：**规划-执行循环**。

> 规划大模型制定计划并下达任务 → 执行大模型（子代理）执行 → 结果回传 →
> 规划者评判 → 不合格则新一轮循环 → 最终由规划者调用 `loop_complete` 判定完工。

- 规划者 = 主对话（循环激活后其请求强制路由到规划的模型）
- 执行者 = 通过 `subagent` 工具派发的子代理（强制路由到执行模型）
- 完工判定权在规划者，且**只能**通过 `loop_complete` 宣告（带守卫）
- 未开启循环的普通会话**零影响**：不路由、不改变行为

## 更换模型

| 方式 | 操作 | 说明 |
|---|---|---|
| **设置页卡片** | 设置 → 插件 → **「规划-执行循环」** | 规划/执行各有 供应商 / 模型 / 推理档位 三个下拉，模型选项来自实时模型目录；改完点保存，立即生效 |
| **聊天内更换** | 对模型说"把执行模型换成 deepseek-v4-pro" | 模型调用 `loop_set_models`；不带参数为查看当前配置 |
| **直接改 YAML** | 编辑 `~/.dsh/profiles/web/cordis.patch.yml` 的 `planner-executor-loop` 行 | 即改即生效（dsh-hmr 热重载） |

三者等价：都是 volatile 配置，**下一个请求**就用新路由（循环进行中换模型也立即生效，
下一轮派发即用新执行模型）。provider/model 留空 = 该角色未配置（直通）。

### 配置字段（v0.3.0 起为扁平字段）

```yaml
- id: planner-executor-loop
  config:
    plannerProvider: zai-coding-cn        # 规划：供应商
    plannerModel: glm-5.3                 # 规划：模型
    plannerEffort: high                   # 规划：推理档位（GLM-5.3 系必须显式给）
    executorProvider: deepseek-official   # 执行：供应商
    executorModel: deepseek-flash         # 执行：模型
    executorEffort: ""                    # 执行：推理档位，留空=跟随供应商默认
    maxRounds: 8                          # 循环轮次上限，≥1
```

> v0.2.0 的嵌套写法（`planner: { provider, model, … }`）仍可读，但会告警，
> 且不会出现在设置页卡片里——建议按上表迁移。

## 安装

```sh
dsh plugin --profile web add <本目录的绝对路径>
```

路径含空格时加引号。**必须重启 `dsh web`**：客户端半边（设置页卡片）在启动时注入，
源码迭代后重启一次即可（`link:` 挂载时源码即装即生效）。

## 工具

| 工具 | 作用 | 关键守卫 |
|---|---|---|
| `loop_begin` | 登记目标与计划，开启循环 | 已有激活循环需 `restart: true` |
| `round_report` | 登记一轮结果（每任务 pass/partial/fail + 证据） | 轮次必须连续；超 `maxRounds` 拒绝 |
| `loop_set_models` | 查看 / 更换模型路由与轮次上限 | 不带参数=查看；非法路由拒绝 |
| `loop_status` | 状态、当前路由 + 按 provider/model 的 token 用量 | 只读 |
| `loop_complete` | 完工判定（唯一有效方式） | 必须至少一轮；未通过任务/未满足标准须有豁免 |
| `loop_abandon` | 放弃循环 | 必须给原因 |

## 使用

新会话中直接说：

> 用规划-执行循环做 X：先规划，再派发执行，循环验收，最后判定完工。

模型会依次调用 `loop_begin → subagent(若干) → round_report → … → loop_complete`。
`loop_status` 的"模型用量"一节即为规划/执行分工真正发生的证据。

## 已知限制

- 循环状态为**进程内内存态**：重启 harness 后清空（`loop_status` 会如实报告）。
- 路由只覆盖**进程内**子代理（spawn / fork）；acp、codex 等进程外子代理不受影响。
- 派发时不要在 `subagent` 调用里传 `provider` / `model` / `reasoning_effort`——路由由本插件强制。
- 与其他同样监听 `agent/request` 的路由插件（role-router / autotier 等）叠加时，后注册者胜。
- 设置页卡片是 DSH 通用设置表单（下拉 + 保存），不是自定义图表组件。

## 卸载

```sh
dsh plugin --profile web remove dsh-planner-executor-loop
```

并删除 `cordis.patch.yml` 里 `planner-executor-loop` 的配置行。

## License

MIT
