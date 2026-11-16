const HOST =
  "Claude host: use only native capabilities exposed in the current session. Record messaging, read-only controls and model availability in preflight. RL does not install a tool allowlist. Unsupported preferences must be disclosed, never silently substituted. Missing messaging supports explicit sequential Light execution. Follow repository instructions and report actual check output; no commits or global configuration changes without authorization.";
export const CLAUDE_WRITER_INSTRUCTIONS = HOST;
export const CLAUDE_REVIEWER_INSTRUCTIONS = `${HOST} Stay behaviorally read-only even when this host cannot restrict tools; record that limitation.`;
export const CLAUDE_DRY_INSTRUCTIONS = `${HOST} Return focused reuse evidence and limitations. Do not edit or score.`;
export const CLAUDE_QA_INSTRUCTIONS = `${HOST} Use repository-supported QA tools; distinguish mocked from live evidence and clean up only resources you created.`;
