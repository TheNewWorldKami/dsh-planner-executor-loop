[中文](README.zh.md) | English

# dsh-planner-executor-loop

A DeepSeek Harness (DSH) plugin: the **planner-executor loop**.

> The planner model writes the plan and dispatches tasks → the executor model (subagents) carries them out →
> results come back → the planner judges them → a failed round starts a new round →
> finally the planner calls `loop_complete` to declare completion.

- Planner = the main conversation (once a loop is active, its requests are forced onto the planner model)
- Executor = subagents dispatched through the `subagent` tool (forced onto the executor model)
- The planner alone decides completion, and **only** through `loop_complete` (which is guarded)
- Sessions without an active loop are **completely unaffected**: no routing, no behavior change

## Changing models

| Route | How | Notes |
|---|---|---|
| **Settings card** | Settings → Plugins → **"Planner-executor loop"** | Planner and executor each have three dropdowns (Provider / Model / Reasoning effort); model options come from the live model catalog. Save to apply immediately. |
| **In chat** | Tell the model "switch the executor model to deepseek-v4-pro" | The model calls `loop_set_models`; calling it with no arguments shows the current configuration. |
| **Edit the YAML directly** | Edit the `planner-executor-loop` entry in `~/.dsh/profiles/web/cordis.patch.yml` | Takes effect as soon as it is saved (dsh-hmr hot reload). |

All three are equivalent: they are volatile configuration, and the **next request** uses the new routing (switching models mid-loop also applies immediately — the next dispatched round uses the new executor model). Leaving provider/model empty means that role is not configured (pass-through).

### Config fields (flat fields since v0.3.0)

```yaml
- id: planner-executor-loop
  config:
    plannerProvider: zai-coding-cn        # planner: provider
    plannerModel: glm-5.3                 # planner: model
    plannerEffort: high                   # planner: reasoning effort (GLM-5.3 family must set it explicitly)
    executorProvider: deepseek-official   # executor: provider
    executorModel: deepseek-flash         # executor: model
    executorEffort: ""                    # executor: reasoning effort, empty = provider default
    maxRounds: 8                          # maximum loop rounds, ≥1
```

> The v0.2.0 nested form (`planner: { provider, model, … }`) is still readable, but it logs a warning
> and does not appear in the settings card — migrating to the table above is recommended.

## Installation

```sh
dsh plugin --profile web add <absolute path to this directory>
```

Quote the path if it contains spaces. **`dsh web` must be restarted**: the client half (the settings card) is injected at startup, so restart once after iterating on the source (when mounted with `link:`, source changes apply immediately).

## Tools

| Tool | Purpose | Key guard |
|---|---|---|
| `loop_begin` | Register the goal and plan, start the loop | An already active loop requires `restart: true` |
| `round_report` | Register one round's results (pass/partial/fail + evidence per task) | Round numbers must be consecutive; rejected past `maxRounds` |
| `loop_set_models` | View / change model routing and the round limit | No arguments = view; invalid routes are rejected |
| `loop_status` | Status, current routing + token usage per provider/model | Read-only |
| `loop_complete` | Completion verdict (the only valid way) | At least one round required; failed tasks or unmet criteria need waivers |
| `loop_abandon` | Abandon the loop | A reason is required |

## Usage

In a new session, just say:

> Use the planner-executor loop for X: plan first, then dispatch execution, loop through acceptance, and finally declare completion.

The model then calls `loop_begin → subagent(several) → round_report → … → loop_complete`.
The "model usage" section of `loop_status` is the evidence that the planner/executor split really happened.

## Known limitations

- Loop state is **in-process memory**: it is cleared when the harness restarts (`loop_status` reports this faithfully).
- Routing only covers **in-process** subagents (spawn / fork); out-of-process subagents such as acp and codex are unaffected.
- Do not pass `provider` / `model` / `reasoning_effort` in `subagent` calls when dispatching — this plugin enforces the routing.
- When combined with other routing plugins that also listen on `agent/request` (role-router / autotier, etc.), the last one registered wins.
- The settings card is the generic DSH settings form (dropdowns + save); it is not a custom chart component.

## Uninstall

```sh
dsh plugin --profile web remove dsh-planner-executor-loop
```

Also delete the `planner-executor-loop` config entry from `cordis.patch.yml`.

## License

MIT
