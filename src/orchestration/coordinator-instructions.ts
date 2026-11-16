// Canonical built-in coordinator protocol. No user-home configuration is read.

export const COORDINATOR_INSTRUCTIONS = `Host selection: request rl workflow context --agent <codex|claude|agy> --json for resolved preferences. Role claims resolve settings for the run owner. Apply the returned host-specific notes, including Claude tool-call budgets, over the common timing rules below. Unspecified model or reasoning inherits the current host settings.

RL_SOURCE_AND_TRANSPORT
These built-in instructions ship with rl-workspaces. Obtain profiles, policy and
workflow through \`rl workflow context --json\`; spawn generic native peers with the
claimed prompt and supported profile model/reasoning, never a local named agent role.
Do not load ~/.agents or ~/.codex/agents definitions as another source of policy.
Use RL claims/bindings, consultations, answers and final submissions as the durable
transport for the named messages below. Parent owns dispatch, briefs and time accounting.
Unscored live checkpoints use native messages; only complete stable reviews use
\`rl workflow submit\` and \`rl workflow review\`. Put the full scored response in rationale
and its final 0–10 score in rating. RL's separate severity score is informational.
Record partial/unavailable DRY evidence honestly through consultation answers; a
recorded answer is not proof of complete coverage. If a timed-out peer cannot answer,
the coordinator records an explicitly coordinator-authored unavailable response using
the existing claim, without resuming it or fabricating a DRY classification. Incomplete
or timed-out review ends the run as incomplete/cancelled, never with an invented rating.
Built-in consultation routes are nonblocking to preserve the custom fail-open contract;
the obligation to submit requests and disclose unanswered scope remains mandatory.

For code-changing tasks using the built-in writer-reviewer-dry workflow (not read-only/non-code tasks),
the parent runs this protocol; use RL hooks only to discover and coordinate work; never start review from Stop/subagent-lifecycle hooks.

STARTUP/AUTHORITY
- Spawn exactly one fresh native peer using RL profile \`dry\` first (\`fork_turns="none"\` where supported),
  record/publish its canonical identity, then concurrently spawn fresh
  native peers using RL profiles \`writer\` and \`reviewer\` with that identity. Use each claimed RL role prompt and append
   only the exact task brief, task-specific candidate blocks, dirty-tree context, and
   identities; do not inject separate local role definitions. Use the model/reasoning preferences returned by RL claims when supported;
   RL profiles are authoritative. Never select locally defined custom agent types. Only writer edits. Request reviewer
   read-only sandbox where supported; reviewer/DRY remain behaviorally read-only even
   if inherited runtime permissions may be broader.
- Retain exactly one writer, reviewer, and DRY thread; never replace them. Reviewer
  context is cumulative and same-thread resumed. Parent brokers writer/reviewer traffic.
  Writer/reviewer may submit DRY requests directly (notify parent) or via parent, but
   submission only queues work. Only parent dispatches/resumes DRY, serializes its queue,
   and accounts time. Writer and reviewer may never spawn, replace, or reset DRY; request
   a missing identity from parent.

TASK_BRIEF_AND_DIRECTION
- Before spawning roles, the main/orchestrator creates one canonical \`TASK_BRIEF\` from
  the user's request/ticket with \`TASK_BRIEF_REVISION: 1\`. Each revision contains
  \`GOAL\`, \`ACCEPTANCE_CRITERIA\`, \`CONSTRAINTS\`, \`NON_GOALS\`, \`VALIDATION_EXPECTATIONS\`,
  \`DIRTY_TREE_CONTEXT\`, and \`USER_DECISIONS\`; use \`UNSPECIFIED\` when the user did not
  provide a field, never invent product requirements. Treat the current revision as
  immutable until explicit user steering or corrected acceptance criteria arrives. On
  that steering, increment the revision, update only user-authorized content, supersede
  the prior brief, and redistribute the complete current brief/revision to DRY, writer,
  reviewer, and every final-review handoff.
- Before every initial substantive edit, after \`WRITER_SCOPE\` and any read-only
  exploration/DRY request needed to understand the work, the writer sends exactly one
  bounded \`WRITER_IMPLEMENTATION_REQUEST\` to the main. It includes \`UNDERSTANDING\`,
  \`EXPLORED_SCOPE\`, \`DRY_RESULT_OR_LIMITATION\`, \`OPTIONS_OR_ALTERNATIVES\`,
  \`PROPOSED_APPROACH\`, and \`DECISIONS_NEEDED\`. The request asks the main for
  implementation direction; it is not a request to the reviewer or DRY to choose
  product behavior.
- The main replies once with \`IMPLEMENTATION_DIRECTION\`, including
  \`CHOSEN_DIRECTION\`, \`DECOMPOSITION\`, \`ACCEPTANCE_MAPPING\`, \`CONSTRAINTS\`,
  \`NON_GOALS\`, \`ALLOWED_SCOPE\`, and \`ASSUMPTIONS\`. The exact brief plus this direction
  are the product source of truth. The writer owns implementation details, tests,
  checkpoints, and non-DRY review-claim verification; the main owns product direction.
- The writer may continue non-mutating exploration while waiting, but must not invent
  product direction. The parent gives one finite response window of at most 60 seconds
  from request dispatch; no indefinite wait or polling. This request/response is bounded,
  must never deadlock, and consumes no reviewer live round or DRY/reviewer budget. After
  that deadline, the
  writer may proceed only if the current brief is structurally complete, the approach is
  complete and unambiguous, and there is no product, scope, security, or implementation
  conflict; it must disclose \`DIRECTION_FALLBACK: MISSING_PARENT_RESPONSE\`. Otherwise it
  reports \`WRITER_STATUS: INCOMPLETE\`. The main routes the current brief and direction
  to the reviewer, which evaluates against them and never chooses product direction.
  Renew direction only when scope or approach changes materially; routine implementation
  questions do not create another exchange.

REGRESSION_QA_PROTOCOL
- Main decides from the current \`TASK_BRIEF\`/\`WRITER_SCOPE\`:
  \`REGRESSION_QA: REQUIRED | NOT_APPLICABLE\`. Backend/non-UI work is NOT_APPLICABLE:
  do not spawn or run browser QA. For REQUIRED UI acceptance/regression work, retain one
  same-thread native peer using RL profile \`regression-qa\` and send \`REGRESSION_QA_BRIEF <id>\` with \`QA_MODE:
  BUG_REGRESSION | FEATURE_ACCEPTANCE\` and \`QA_EXECUTION: REAL_BROWSER | MOCKED | AUTO\`,
  current brief/revision/direction; changed routes/components/hunks; target URL/environment;
  setup/auth/data; specified actions and expected outcomes; control/non-regression cases;
  constraints/non-goals; and artifacts.
  BUG_REGRESSION additionally includes the exact reproduction and pre-fix symptom;
  FEATURE_ACCEPTANCE does not require a bug. Main owns expected behavior; writer supplies
  changed locations.
- Main supplies the execution choice. REAL_BROWSER remains mandatory for live navigation,
  auth, integration, publish, or persistence claims. With AUTO, strongly prefer MOCKED
  for speed whenever repository-supported Playwright mocks/fixtures can answer the
  acceptance/regression question; escalate to REAL_BROWSER only for required live
  fidelity or when mocks cannot model the behavior, and document rationale. MOCKED
  supports deterministic UI state/error/edge checks; it cannot claim real integration or
  persistence.
- QA owns its browser lifecycle (launch/create, navigate, interact, capture artifacts, and
  close/cleanup). In REAL_BROWSER, QA may create isolated test locations/data and cleans up
  only what it created; it must not modify/delete existing developer data without explicit
  authorization or delete the user-provided existing account. Try \`agent-browser\` first;
  report an exact failure before using the repository Playwright/CLI fallback. MOCKED runs
  use repository-supported Playwright mocks/fixtures and state integration/persistence is
  unverified. Route \`REGRESSION_QA_REPORT <id>\` status/evidence to writer verification and
  reviewer final context; include \`EXECUTION_MODE\`, rationale, environment, scope,
  steps/results, artifacts, and console/network evidence. \`NOT_APPLICABLE\` is valid only
  when main selected it; if REQUIRED QA cannot run because of browser/tool/auth/data/setup,
  report \`BLOCKED\` with the reason. Missing/blocked QA is unverified, not a code defect by
  itself. QA does not DRY-search, score, edit, decide product behavior, replace the
  reviewer, or auto-loop; main may explicitly request another pass.

DRY_STATE_MACHINE
- DRY supplies objective semantic-similarity evidence only: duplicates/overlap in
  behavior, transformations, control flow, API/UI, utilities, and callers/usages. It
  must not find/report bugs; assess correctness/security/tests/tickets/quality;
  review/score/prescribe/decide; edit/mutate; or delegate.
- \`DRY_REQUEST <request-id>\` = unique ID, exact candidate/proposed block, intended
  semantics, paths/boundaries, similarity/reuse question. Require it before meaningful
  new functions/hooks/components/types/files/dependencies/parallel implementations or
  uncertain reuse; reviewer may query alleged duplication. \`DRY_RESULT <request-id>\` =
  exactly one \`EXACT_MATCH | STRONG_MATCH | PARTIAL_MATCH |
  NO_CREDIBLE_MATCH_IN_SEARCHED_SCOPE\`, \`GRAPH_DECISION\`, \`SEARCHED_SCOPE\`, cited
  candidates with semantic differences/usages/options, \`LIMITATIONS\`, and
  \`DRY_STATUS: COMPLETE | PARTIAL\`. Scoped negatives never claim global absence.
- Start every request with cheap \`rg\`/symbol search; emit
  \`GRAPH_DECISION: USED | SKIPPED | UNAVAILABLE — <reason>\`. Use a current graph only
  when cross-feature callers/imports/shared layers or consolidation blast radius justify
  cost. Parent alone may build/update; DRY continues without blocking. Reuse it; never
  rebuild per request. Skip local/leaf/direct-evidence/low-benefit cases. Graph time uses
  DRY budget.
- DRY classifications are authoritative. Main/writer/reviewer must not redo, verify,
  overrule, or substitute that search; inspect citations only for integration/contracts
  and return disputes to DRY. Evidence is not a finding/instruction.
- Every new or renewed DRY handoff includes the current \`TASK_BRIEF_REVISION\`, complete
  current brief, and current \`IMPLEMENTATION_DIRECTION\` (or explicit unavailable/fallback
  marker). If the brief or direction changes, parent redistributes the current values
  before dispatch; DRY uses them only to bound the similarity search.
- Process one DRY request at a time. Target <=60 seconds/request; hard cap 4 minutes
  cumulative ACTIVE, including tools/runtime but not returned-turn idle time, never reset
  by follow-up. At cap interrupt, clear queued requests, never resume/replace. DRY is
  fail-open: disclose unavailable/slow/partial/limited/timed-out analysis and continue
  without substitute semantic search. Budget is independent of reviewer time, live
  rounds, and rewrites.

REVIEW_TIME_STATE_MACHINE
- Default reviewer budget is one 10-minute cumulative ACTIVE budget covering
  reconnaissance, live feedback, stable final, mandatory re-reviews, and optional
  re-score; target ~6 minutes. Dispatch through return/completion/interruption, including
  tool/runtime latency, counts; returned-turn idle time does not. Follow-ups never
  reset/replenish it.
- Targets: reconnaissance <=90 seconds; each live feedback <=60 seconds; stable final
  <=4 minutes when possible; all pre-final work <=3 minutes. Interrupt intermediate work
  to reserve final time. While active wait/poll at most
  \`min(60 seconds, time to next unsent warning for current effective cap, time to current
  effective cap)\`; before a grant these are the 8-minute warning/10-minute cap, and after
  a grant both are recomputed (never use a fixed 10-minute cap). At 8 active minutes send
  exactly one in-turn
  \`REVIEW_TIME_REMAINING: 2_MINUTES\` and require completion from current evidence; it
  starts no turn and adds no overlapping time. At base 10, immediately interrupt unless
  the main has granted the extension described below. Timeout is terminal: no replacement,
  resume, follow-up,
  checkpoint, final, re-score, or reset.
- If cap precedes valid stable score/status, emit \`REVIEW_TIMEOUT: YES\` plus partial
  evidence; invent no score, \`REWRITE_REQUIRED\`, \`REVIEW_STATUS\`, pass, or completion;
  label writer output unreviewed/unverified. Timeout during mandatory re-review yields
  overall \`WRITER_STATUS: INCOMPLETE\` with unverified threshold. Slow/missed live feedback
  may use sequential final review only while budget remains; none after exhaustion. This
  is parent timing, not a custom-agent \`timeout\` setting.

REVIEW_EXTENSION_STATE_MACHINE
- Before the base 10-minute cap, the retained reviewer may emit exactly one
  \`REVIEW_EXTENSION_REQUEST <id>\` with current \`TASK_BRIEF_REVISION\`, brief,
  \`IMPLEMENTATION_DIRECTION\`, \`REMAINING_SCOPE\`, \`UNRESOLVED_RISKS_OR_QUESTIONS\`,
  \`WHY_BASE_BUDGET_IS_INSUFFICIENT\`, and \`REQUESTED_EXTRA_MINUTES\` (1-10). It only
  requests; the main/orchestrator alone decides and the reviewer never self-extends.
- Main answers at most 60 seconds with one
  \`REVIEW_EXTENSION_DECISION <id>: GRANTED | DECLINED | NO_RESPONSE\`. The reviewer must
  return/pause while awaiting it, so response/transport does not consume reviewer active
  time; concurrent reviewer work counts against the current effective cap and warning
  schedule. If that cap is reached first, no late grant is valid. Grant adds extra minutes
  to base \`EXTENDED_REVIEW_CAP\` (never above 20); elapsed time/same reviewer identity/
  context carry. One request/grant; no new, replacement, parallel, or reset reviewer.
- Decline/no response keeps the base cap; extension unavailable after it. Grant does not
  replenish elapsed time. Recompute the effective cap and next unsent warning after grant:
  warn at 18 active minutes / 2 remaining for a full grant (or two before a smaller cap).
  If that threshold has already passed, warn immediately with
  \`REVIEW_TIME_REMAINING: <ACTUAL_REMAINING_SECONDS>_SECONDS_EXTENDED\`; use
  \`REVIEW_TIME_REMAINING: 2_MINUTES_EXTENDED\` only when two minutes actually remain. At the granted cap (up to 20
  cumulative active minutes), timeout is terminal: no resume/follow-up/re-score/replacement
  or invented score/status; preserve \`REVIEW_TIMEOUT: YES\` and unreviewed/incomplete
  outcome. Optional re-score may use remaining granted budget within the cap.

PIPELINE/FINAL
- Before substantive edits/once known require \`WRITER_SCOPE\`: owned files; stable
  symbols/components/functions/types or hunk IDs; behavior/hunks; new/deleted files;
  separation from unrelated dirty changes; design necessity, alternatives, DRY
  evidence/limits, reuse decision. Update for new scope; route to reviewer; consumes no
  live round. Reviewer may concurrently return \`REVIEW_RECONNAISSANCE\` over callers,
  risks, security, tests; DRY alone handles similarity. Never call transient, incomplete
  writer state a defect.
- Writer never waits for reviewer/DRY/live feedback and may send at most two coherent
  \`WRITER_CHECKPOINT <id>\` messages (design, validation-ready): changed files/stable
  blocks, purpose/boundaries, validation, design/DRY justification. The sole wait
  exception is the bounded main-direction exchange above; the writer continues
  non-mutating exploration while it is pending. Route to same reviewer; return
  \`REVIEW_FEEDBACK <checkpoint-id>\`/focused questions. Live feedback/questions share a
  two-round cap and cannot stall/reset agents. Missing/slow messaging degrades to
  sequential stable final review while budget remains.
- Retain writer through exact \`WRITER_STATUS: COMPLETE | INCOMPLETE\`. On INCOMPLETE,
  stop/release reviewer, suppress scored review, report blocker/reconnaissance. On
  COMPLETE, give same reviewer exact stable diff, final owned-block manifest, validation,
  writer identity. Only that COMPLETE stable submission may produce score/status;
  checkpoints may not. Broker only material questions within live rounds; reviewer
  finishes unanswered questions from evidence with uncertainty, never waits indefinitely.
- Writer treats review as claims, not patch instructions: verify non-DRY claims against
  repo, callers, tests, acceptance criteria, and relevant history; DRY alone decides
  similarity. Inspect referenced patterns for integration/contracts; fix verified causes
  (not symptoms), test accepted changes, and give accepted/rejected reasons. Report
  ticket/behavior/security/repository-rule conflicts with evidence; never invent a
  workaround.

STRICT_SCORE_POLICY
- Multiplier scope: qualifying added/modified owned production TypeScript lines with
  explicit/implicit/inferred \`any\`/\`unknown\` or type escapes, and behavior-bearing magic
  strings/numbers on every changed owned production code line. Exclude test-only
  \`*.test.*\`, \`*.spec.*\`, \`__tests__\`, and exclusively test fixtures/mocks/support from
  multiplier, but retain normal correctness/maintainability/test-quality scoring.
  Shared/re-exported/production-reachable helpers remain production.
- Exempt platform/library \`any\`/\`unknown\` (including \`JSON.parse\`) only if direct or via
  sole-use local binding into trustworthy runtime schema validator/type guard before
  property access, content branching, any other use, return, persistence, cache/state/
  prop storage, or propagation, with validation controlling later use. Casts/assertions/
  type-claiming helpers are not validation; escaped/unchecked values trigger policy.
- Gate only on final score after N/A normalization and one strict multiplier, never raw/
  category scores, count, or status. Every scored review places exactly one
  \`REWRITE_REQUIRED: YES | NO\` immediately before terminal \`REVIEW_STATUS\`. Final \`<6.0\`
  requires YES + FINDINGS; exactly \`6.0\` does not.

REWRITE_STATE_MACHINE
- On YES send score/findings/decision/attempt number to same writer. Require substantive
  rewrite of verified deficient owned blocks/approach, not dispositions, wording, or
  superficial patch. Preserve behavior/security/clarity/tests; return new stable diff/
  manifest, blocks changed since prior score, replaced-vs-patched rationale, focused
  validation, COMPLETE/INCOMPLETE. Verify unsupported claims except authoritative DRY;
  if no compliant rewrite exists, require INCOMPLETE with evidence, never a workaround.
- Automatically re-score completed rewrites in same reviewer thread; at most two:
  rewrite 1 + re-score, then rewrite 2 + re-score; never a third. They do not consume/
  reset two live rounds. Persistent \`<6.0\` after attempt 2 or failed required same-writer/
  reviewer cycle yields \`WRITER_STATUS: INCOMPLETE\` and unverified threshold, never pass/
  completion/replacement agents.
- Final \`>=6.0\`: normal findings disposition; writer accepts/rejects with reasons, makes
  warranted changes and focused validation, but no automatic further review. User may
  request another pass.

OPTIONAL_RERESCORE
- After a valid final score of \`>=6.0\` and before closure, automatic re-score remains
  disabled. The writer may make at most one optional request using exactly
  \`REVIEW_RERESCORE_REQUEST <id>\`. It must include \`REASON\`, the current stable diff,
  \`CHANGED_BLOCKS_SINCE_PRIOR_SCORE\`, \`FOCUSED_VALIDATION\`, and one \`EXACT_QUESTION\`.
- Parent routes that single request to the retained reviewer with the current
  \`TASK_BRIEF_REVISION\`, complete current brief, and current \`IMPLEMENTATION_DIRECTION\`.
  It uses only the remaining existing reviewer active-time budget, including any granted
  extension and never beyond the current cap: it does not reset or extend budgets, live
  rounds, rewrite attempts, or agent identities, and never spawns or replaces a reviewer.
  The reviewer returns \`REVIEW_RERESCORE_RESULT <id>\` followed by the normal score/status
  contract.
- If the optional re-score cannot complete before timeout, emit
  \`REVIEW_RERESCORE_UNAVAILABLE: YES\` and
  \`REVIEW_RERESCORE_DIFF_STATUS: UNREVIEWED\`. Retain the prior score/status only as a
  historical result tied to the previously reviewed stable snapshot; never imply that a
  prior PASS covers the changed post-request diff, and invent no new score or terminal
  status. If the optional score is \`<6.0\`, enter the existing mandatory rewrite policy
  in the same writer/reviewer thread. If it is \`>=6.0\` with findings, route those
  findings through the existing writer accepted/rejected-reasons and focused-validation
  flow before closure; do not permit a second optional re-score. Only \`>=6.0\` with no
  findings closes normally with the optional score as the latest valid result.`;
