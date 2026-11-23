const fs = require("node:fs"),
  readline = require("node:readline");
let role = "";
const send = (value) => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") return send({ id, result: {} });
  if (method === "thread/start") {
    if (params.sandbox !== "read-only") process.exit(3);
    role = params.developerInstructions.match(/You are the (.*?) in RL/)[1];
    return send({ id, result: { thread: { id: "thread" } } });
  }
  if (method === "turn/steer") {
    fs.appendFileSync(
      process.env.SNIPER_LOG,
      JSON.stringify({ steer: true, role, pid: process.pid }) + "\n",
    );
    return;
  }
  if (method !== "turn/start") return;
  const q = JSON.parse(params.input[0].text.split("\n")[0]);
  fs.appendFileSync(
    process.env.SNIPER_LOG,
    JSON.stringify({ role, task: q.task, seconds: q.seconds }) + "\n",
  );
  send({ id, result: { turn: { id: "turn" } } });
  if (process.env.SNIPER_HANG === role) return;
  const timeoutMarker = process.env.SNIPER_WRITER_TIMEOUT;
  if (role === "writer-1" && timeoutMarker && !fs.existsSync(timeoutMarker)) {
    fs.writeFileSync(timeoutMarker, "first assignment stalled");
    return;
  }
  let result = null,
    extensionSeconds = null;
  if (role === "orchestrator") {
    if (q.task.includes("Frame the objective"))
      result = {
        brief: "Implement task.",
        deadlines: [{ role: "specialist", seconds: 2 }],
      };
    else if (q.task.includes("Decide this extension"))
      result = { seconds: 5, rationale: "One bounded continuation." };
    else if (q.lastReview?.blocker && process.env.SNIPER_TRIM)
      result = {
        deadlines: [],
        action: "write",
        rationale: "Remove excess logic",
        assignments: [
          {
            files: ["feature.ts"],
            instructions: "Remove",
            acceptanceCheck: "feature.ts is absent",
            seconds: null,
          },
        ],
      };
    else if (
      timeoutMarker &&
      q.lastReview?.blocker?.includes("writer assignment")
    )
      result = {
        deadlines: [],
        action: "write",
        rationale: "Retry the unfinished file",
        assignments: [
          {
            files: ["feature.ts"],
            instructions: "Implement",
            acceptanceCheck: "feature.ts contains hello",
            seconds: 15,
          },
        ],
      };
    else if (!q.lastReview)
      result = {
        deadlines: [],
        action: "write",
        rationale: "Deliver changes",
        assignments: [
          {
            files: ["feature.ts"],
            instructions: "Implement",
            acceptanceCheck: "feature.ts contains hello",
            seconds: timeoutMarker ? 2 : null,
          },
          {
            files: ["example.css"],
            instructions: "Style",
            acceptanceCheck: "example.css exists",
            seconds: null,
          },
          {
            files: ["feature.ts"],
            instructions: "Verify",
            acceptanceCheck: "feature.ts exists",
            seconds: null,
          },
        ],
      };
    else
      result = {
        deadlines: [],
        action: "accept",
        rationale: "Reviewed",
        assignments: [],
      };
  } else if (role === "specialist")
    result = [
      {
        confidence: 1,
        claim: "Checked current files",
        evidence: "git ls-files",
      },
    ];
  else if (role === "product-owner" && q.task.includes("Define completion"))
    result = "Feature works.";
  else if (role.startsWith("writer")) {
    const job = JSON.parse(q.task.slice(q.task.indexOf('{"instructions"')));
    if (job.instructions === "Implement" && !q.followup) extensionSeconds = 5;
    else {
      const file = job.files[0];
      result = {
        summary: "Written",
        patch:
          job.instructions === "Verify"
            ? ""
            : "diff --git a/" +
              file +
              " b/" +
              file +
              "\nnew file mode 100644\n--- /dev/null\n+++ b/" +
              file +
              "\n@@ -0,0 +1 @@\n+hello\n",
      };
      if (job.instructions === "Remove")
        result.patch =
          "diff --git a/feature.ts b/feature.ts\ndeleted file mode 100644\n--- a/feature.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n";
      if (job.instructions === "Verify" && !fs.existsSync(file))
        process.exit(8);
    }
  } else {
    const flag = process.env.SNIPER_REJECT;
    const reject = role === "product-owner" && flag && !fs.existsSync(flag);
    if (reject) fs.writeFileSync(flag, "rejected");
    result = {
      approved: !reject,
      reasons: reject ? "Needs clarification" : "Reviewed diff.",
    };
  }
  const gate = process.env.SNIPER_ACCEPT_GATE;
  if (gate && result?.action === "accept" && !fs.existsSync(gate)) {
    fs.writeFileSync(gate + ".ready", "");
    while (!fs.existsSync(gate))
      await new Promise((resolve) => setTimeout(resolve, 30));
  }
  send({
    method: "item/completed",
    params: {
      threadId: "thread",
      item: {
        type: "agentMessage",
        text: JSON.stringify({
          summary: "Final report",
          specialistQuestion: null,
          extensionSeconds,
          result,
        }),
      },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: "thread", turn: { status: "completed" } },
  });
});
