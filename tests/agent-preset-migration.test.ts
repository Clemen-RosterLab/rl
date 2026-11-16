import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT, Workspace } from "./helpers.js";

test("RL supplies the migrated team, rubric and coordinator without home agent definitions", (t) => {
  const w = new Workspace(t);
  const context = JSON.parse(
    w.rl(["workflow", "context", "--agent", "codex", "--json"], { cwd: w.a })
      .stdout,
  );
  assert.equal(context.source, "built-in");
  assert.equal(context.configured, false);
  assert.equal(context.agents.dry.model, "gpt-6-astra");
  assert.equal(context.agents.dry.reasoning, "low");
  assert.match(context.agents.dry.instructions, /NEW_FUNCTION_SCRUTINY/);
  assert.match(
    context.agents.writer.instructions,
    /WRITER_IMPLEMENTATION_REQUEST/,
  );
  assert.match(context.agents.reviewer.instructions, /OPTIONAL_RERESCORE/);
  assert.equal(context.agents["regression-qa"].access, "read-only");
  assert.deepEqual(context.policies.review.rating, {
    min: 0,
    max: 10,
    minimum: 6,
    instructions: context.policies.review.rating.instructions,
  });
  assert.match(context.policies.review.instructions, /non-compounding/);
  assert.match(
    context.policies.review.instructions,
    /STRICT_CHANGED_PRODUCTION_LINES/,
  );
  assert.equal(context.policies.review.blockRequired, false);
  assert.match(context.instructions, /TASK_BRIEF_REVISION/);
  assert.match(
    context.instructions,
    /Never select locally defined custom agent types/,
  );
  assert.match(context.instructions, /REVIEW_EXTENSION_STATE_MACHINE/);
  assert.equal(
    context.workflows[context.defaultWorkflow].collaboration.maxRounds,
    4,
  );
});

for (const host of ["codex", "claude", "agy"] as const) {
  test(`packaged profiles resolve ${host} settings in discovery and native claims`, (t) => {
    const w = new Workspace(t);
    const identity = { agent: host, sessionId: randomUUID() };
    const call = (action: string, input: Record<string, unknown> = {}) => {
      const argv =
        action === "start"
          ? ["workflow", "run", "writer-reviewer-dry", "--base", "HEAD"]
          : ["workflow", action];
      if (input.run) argv.push(String(input.run));
      if (input.step) argv.push("--step", String(input.step));
      argv.push(
        "--agent",
        identity.agent,
        "--session",
        identity.sessionId,
        "--json",
      );
      return JSON.parse(w.rl(argv, { cwd: w.a }).stdout);
    };
    const context = call("context");
    const run = call("start", { base: "HEAD" });
    for (const role of ["writer", "reviewer", "dry"]) {
      const claimed = call("claim", { run: run.id, step: role });
      assert.deepEqual(claimed.profile, context.agents[role]);
      const profile = claimed.profile;
      const claudeModels: Record<string, string | undefined> = {
        reviewer: "opus",
        dry: "sonnet",
      };
      const expectedModel = {
        codex: "gpt-6-astra",
        claude: claudeModels[role],
        agy: undefined,
      }[host];
      assert.equal(profile.model, expectedModel);
      assert.equal(
        profile.reasoning,
        host === "codex"
          ? (
              { writer: "medium", reviewer: "high", dry: "low" } as Record<
                string,
                string
              >
            )[role]
          : undefined,
      );
      assert.equal(profile.hosts, undefined);
      assert.equal(
        claimed.prompt.includes("Claude harness notes"),
        host === "claude",
      );
      if (host === "claude" && role === "dry")
        assert.match(claimed.prompt, /6 dispatched requests/);
    }
    assert.equal(
      context.agents["regression-qa"].model,
      { codex: "gpt-6-astra", claude: "sonnet", agy: undefined }[host],
    );
    const raw = JSON.parse(
      w.rl(["workflow", "context", "--json"], { cwd: w.a }).stdout,
    );
    assert.equal(raw.agents.dry.model, undefined);
    assert.equal(raw.agents.dry.hosts.codex.model, "gpt-6-astra");
  });
}

const { AgentProfileSchema } = await import(
  pathToFileURL(path.join(ROOT, "dist/schemas/automation.js")).href
);

test("host settings reject unsupported reasoning, unknown hosts and access overrides", () => {
  const profile = { description: "test", instructions: "test" };
  for (const hosts of [
    { claude: { reasoning: "xhigh" } },
    { codex: { reasoning: "max" } },
    { other: { model: "test" } },
    { claude: { access: "workspace-write" } },
    { agy: { model: "--flag" } },
  ])
    assert.equal(
      AgentProfileSchema.safeParse({ ...profile, hosts }).success,
      false,
    );
  assert.equal(
    AgentProfileSchema.safeParse({
      ...profile,
      hosts: { claude: { model: "opus", reasoning: "max" } },
    }).success,
    true,
  );
});

const { resolveAgentProfile } = await import(
  pathToFileURL(path.join(ROOT, "dist/automation-config.js")).href
);

test("host preferences preserve common workspace settings and never mutate the saved profile", () => {
  const profile = {
    provider: "inherit",
    description: "custom",
    instructions: "common rules",
    model: "custom-model",
    reasoning: "medium",
    access: "read-only",
    hosts: { claude: { model: "opus", instructions: "host rules" } },
  };
  const saved = structuredClone(profile);
  const claude = resolveAgentProfile(profile, "claude");
  assert.equal(claude.model, "opus");
  assert.equal(claude.reasoning, "medium");
  assert.equal(claude.instructions, "common rules\n\nhost rules");
  assert.equal(claude.access, "read-only");
  assert.equal(resolveAgentProfile(profile, "agy").model, "custom-model");
  assert.deepEqual(profile, saved);
});
