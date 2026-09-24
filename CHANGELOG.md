# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added

- Flat configuration fields for model routing and the round limit:
  `plannerProvider`, `plannerModel`, `plannerEffort`, `executorProvider`,
  `executorModel`, `executorEffort`, `maxRounds`.
- The six `loop_*` tools:
  - `loop_begin` — register the goal and plan and start the loop (an active loop needs `restart: true`).
  - `round_report` — register one round's per-task verdicts (pass/partial/fail) plus evidence and the next action.
  - `loop_set_models` — view or change the planner/executor routing and the round limit.
  - `loop_status` — status, current routing, and token usage per provider/model.
  - `loop_complete` — the only way to declare completion; it is guarded (at least one round, and every unmet criterion or failed task needs a waiver).
  - `loop_abandon` — abandon the loop with a reason.
- Settings card ("Settings → Plugins → Planner-executor loop") with Provider / Model /
  Reasoning-effort dropdowns for the planner and the executor plus the maximum-rounds field;
  model options come from the live model catalog.
- In-process routing: requests in a loop session use the planner route, and dispatched
  in-process subagents use the executor route; sessions without an active loop are unaffected.
- Token usage accounting per provider/model as evidence that the planner/executor split happened.

### Changed

- The nested v0.2.0 form (`planner: { provider, model, … }`) is still read as a fallback,
  but it now logs a warning and does not appear in the settings card.

[0.3.0]: https://github.com/YOUR_GH_USER/dsh-planner-executor-loop/releases/tag/v0.3.0
