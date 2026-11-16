# Packaged agent profiles

`rl workflow context --json` is the source of truth for the built-in writer,
reviewer, DRY and optional regression-QA profiles. Their instructions are compiled
from `src/orchestration/role-instructions.ts`; the parent protocol lives in
`src/orchestration/coordinator-instructions.ts`. These modules are included in the
published JavaScript package. Neither discovery nor role claims load user-home
agent definitions. `.rl` configuration remains an explicit workspace override.

The coordinator claims RL roles, spawns generic native peers with their returned
instructions and supported model/reasoning preferences, and binds their handles.
It must not select a locally registered `independent_writer`,
`independent_reviewer`, `dry_searcher` or `regression_qa` role. Model preferences
that a host cannot support must be reported rather than silently substituted.

## Host compatibility

Use `rl workflow context --agent codex --json` (or `claude` / `agy`) to see
resolved profiles. Claims resolve against the owning host automatically.
Discovery without a host returns the canonical profiles with optional `hosts`
settings. Workspace overrides can use the same `hosts` structure; host settings
override common model/reasoning preferences and append host instructions.
Access permissions cannot be overridden by host settings.

| Host   | Writer              | Reviewer          | DRY / QA         |
| ------ | ------------------- | ----------------- | ---------------- |
| Codex  | gpt-6-astra, medium | gpt-6-astra, high | gpt-6-astra, low |
| Claude | Inherit             | opus              | sonnet           |
| agy    | Inherit             | Inherit           | Inherit          |

Claude inherits reasoning and receives its original harness-specific messaging
and tool-call budgets from `src/orchestration/host-instructions.ts`. agy inherits
both model and reasoning. The host must expose native peers and support requested
settings; RL does not provide missing host capabilities or install local role
tool allowlists. Read-only roles request supported host restrictions and remain
behaviorally read-only. Configuration tests do not establish live host behavior.

## Migrated custom policy

The built-ins retain the custom task-brief and direction exchange, one retained
writer/reviewer/DRY team, scoped optional browser QA, DRY evidence-only boundary,
nonblocking consultations, four-minute cumulative DRY budget, ten-minute reviewer
budget with a bounded extension, two live rounds, and at most two mandatory
rewrites plus one optional re-score. Parent accounting enforces active-time and
round distinctions; the workflow engine's wall-clock timeout is a separate limit.

The reviewer rates complete stable work from 0 to 10 using the six weighted
categories, N/A normalization and one strict type/literal multiplier. The rewrite
threshold is 6.0. Severity counts do not independently trigger rewrites, so the
separate RL severity score is informational. Incomplete evidence still cannot
produce an accepted review. Live checkpoints remain unscored native messages;
`rl workflow submit`/`review` record complete stable submissions only.

Consultation records transport `DRY_REQUEST` and `DRY_RESULT`. Optional routes
preserve the original nonblocking/fail-open policy; they do not remove the duty to
request reuse evidence. The coordinator records unavailable analysis explicitly
if a timed-out peer cannot answer, without claiming the peer performed a search.
Never represent missing coverage as a clean result.

## Retiring legacy local definitions

After installing a package containing these profiles, verify the workspace's RL
hooks with `rl doctor codex --json` (or the relevant host). Back up and disable only
the old manual review hook, preserving permission and workspace-boundary hooks.
Archive the four corresponding `~/.agents` source files and generated Codex/Claude
role files outside their discovery directories so a later local sync cannot
restore them. Start a new native session: existing sessions retain already-loaded
instructions and role registrations.

This migration preserves the custom rules. It does not claim to fix the separate
exhaustive-DRY-coverage issue or change its time budget or reasoning settings.
