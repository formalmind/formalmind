/* Agent Skills published at /.well-known/agent-skills/ (agentskills.io).
 *
 * The index lists each skill with a sha256 digest of the SKILL.md as served,
 * so a client can tell when one changed. Every claim below names its source:
 * the mention workflow and the swarm README in asyncswap/v2-proofs, or the
 * code under lib/ and server/routes/ in this repository. */

import { GITHUB_APP, ORIGIN, PROOFS_REPO, STATUS_LINE, SWARM_DOC } from "./narrative";

interface Skill {
  name: string;
  description: string;
  body: string;
}

const ASK: Skill = {
  name: "ask-formalmind",
  description:
    "Talk to the Formal Mind swarm on GitHub: mention @formalmind in an issue, pull request, review or comment of a proofs repository to get an answer, a review or a change, or comment /ask <role> <question> to put a question to one role (planner, prover, reviewer, merger, rebuilder, editor, chief, assistant). Use when you have a GitHub account and want the swarm to explain, review or update a Lean 4 specification it maintains.",
  body: `# Ask formalmind on GitHub

> **${STATUS_LINE}**

The swarm lives in GitHub issues and pull requests. Today it works ${PROOFS_REPO} (the Lean 4 + Mathlib specification of asyncswap/v2); a repository onboarded through formal.team gets its own \`<owner>/<name>-proofs\` repository worked the same way. Both ways of talking to it below need a GitHub account that can comment on that repository. No Formal Mind credential is involved.

## 1. Mention @formalmind for the bot

Write \`@formalmind\` in an issue, a pull request, a review, or a comment on any of them. The mention workflow (\`.github/workflows/formalmind-mention.yml\`) runs two jobs:

- **triage**, in seconds. It reacts 👀 to your message, then asks a model which of three modes the message is: **chat** (small talk or a question the thread already answers: it replies at once, one to three sentences), **read** (a question about the spec that needs the repository), or **toolchain** (a change: it needs Lean, Mathlib and \`lake build\`).
- **run**, for read and toolchain. It checks out the repository, installs the Lean toolchain for toolchain mode, reads the whole thread with \`gh\`, and acts.

The bot posts as **formalmind[bot]**, like a normal commenter: code in fenced blocks, blob permalinks that GitHub renders inline, inline review comments with suggestion blocks on pull requests, and pushes to the pull request branch when you ask for a change. When the run ends it reacts a second time to your message to say how it went. Phrase requests plainly: "what does \`matchAmounts_sound\` guarantee?", "review this PR", "prove the remaining case in Reduce.lean".

## 2. /ask a role

Comment \`/ask <role> <question>\` on any issue or pull request of the proofs repository, where role is one of \`planner\`, \`prover\`, \`reviewer\`, \`merger\`, \`rebuilder\`, \`editor\`, \`chief\` or \`assistant\`. The comment adds the label \`fm:ask-<role>\`, and the dispatcher gives that role the next turn, before any other work (asyncswap/v2-proofs/.github/formalmind/README.md, "Turns, questions and take-overs"). The role answers in one comment, removes the label, and either hands back or takes the job over when it is the better one to do it. Three answers per item per day; after that the item is parked for a human.

To reach the maintainer, write on the assistant's issue (the "Assistant notebook" in the proofs repository): the assistant picks it up and is the only role that talks to the maintainer.

## 3. Read the state first

Before asking, the swarm's state is public and cheaper to read than to ask for:

- MCP: ${ORIGIN}/mcp, tools \`get_swarm_state\`, \`list_open_work\`, \`get_changelog\`, \`get_role_doc\` (card at ${ORIGIN}/.well-known/mcp/server-card.json).
- GitHub: open issues and pull requests carrying \`fm:*\` labels are the queue (\`fm:todo\` queued, \`fm:in-progress\` being worked, \`fm:review\` waiting for the reviewer, \`fm:approved\` waiting for the merger, \`fm:blocked\` waiting for a human). The labels are listed in ${SWARM_DOC}.
- \`FORMAL_MIND.md\` in the proofs repository is the changelog, including what could not be proved.

## Edge cases

- Do not write \`@fm-<role>\`: those handles are not the swarm's. Use \`/ask <role>\`.
- \`@formalmind\` summons the chat bot; \`/ask\` reaches a swarm role. They are different workflows.
- Only one model job runs at a time, within a budget of $5 a day; when the day's budget is spent the swarm pauses until UTC midnight, and your question waits with it.
- Nothing you ask for is merged without a clean \`lake build\` on the exact head, and never with \`sorry\`, \`admit\` or a new axiom.

Source: asyncswap/v2-proofs/.github/workflows/formalmind-mention.yml, asyncswap/v2-proofs/.github/workflows/formalmind-ask.yml, asyncswap/v2-proofs/.github/formalmind/README.md.
`,
};

const ONBOARD: Skill = {
  name: "onboard-a-repository",
  description:
    "Get the Formal Mind swarm working on a Solidity repository: plan it without signing in (POST /api/onboarding/plan), then, signed in with GitHub at formal.team, choose a team size and a daily budget, add prepaid credits with Stripe, install the formalmind GitHub App, and start the swarm, which creates <owner>/<name>-proofs from the Lean template and lists it for the dispatcher. Use when helping a person set up formal verification for their contracts.",
  body: `# Onboard a repository

> **${STATUS_LINE}**

Onboarding is a browser flow behind GitHub sign-in, with one step open to anyone: the plan. An agent can run the plan itself and walk a person through the rest.

## 1. Plan the repository (no sign-in)

\`\`\`
POST ${ORIGIN}/api/onboarding/plan
Content-Type: application/json

{"repo":"owner/name"}
\`\`\`

\`repo\` may be \`owner/name\` or a github.com URL. The repository must be public and contain Solidity contracts outside tests and libraries (422 otherwise). The response is \`text/plain\`: one JSON object streamed a few characters at a time, with \`summary\` (two sentences on what the protocol does, from the code), the contracts found, and the first issues the planner would open. Read the body to the end, then parse it. Limits: five plans per hour per address (429), and a plan for a repository is cached for a week and replayed to everyone who asks (\`X-Plan-Cache: hit\`). Errors come as JSON with an \`error\` message: 404 (no public repository), 503 (GitHub rate limit), 502 (GitHub did not answer).

Source: server/routes/onboarding/plan/route.ts, lib/plan.ts.

## 2. Sign in and set the swarm up (browser)

At ${ORIGIN}/login the person signs in with GitHub. Onboarding at ${ORIGIN}/onboarding then has six steps (components/onboarding/steps.tsx):

1. **Your plan**: the planner's first pass from step 1; continue with it or plan a different repository.
2. **Team**: how many agents work in parallel. The protocol is the same for every team size; more agents work disjoint issues at once, and the planner and the chief are on call in every team.
3. **Daily budget**: the swarm only starts a run when the run's whole cap fits in what is left today, and pauses until tomorrow when the budget is spent.
4. **Credits**: model usage is paid from prepaid credits bought through Stripe Checkout, $10 to $1,000 per deposit (lib/billing.ts). The daily budget decides how fast they are spent. Metering runs against credits is planned, not live yet.
5. **GitHub**: install the formalmind GitHub App, ${GITHUB_APP}, on the repository's owner, for all repositories, so the App can reach the new proofs repository too. The App is how the swarm works in a repository: it opens issues and pull requests, labels them, and runs its workflows there.
6. **Start**: creates \`<owner>/<name>-proofs\` from the formalmind/lean-template repository under the same owner (an existing one is reused) and lists it in the swarm's \`projects.json\`, so the dispatcher sweeps it on its next half-hourly pass (lib/proofs-repo.ts). Start fails with a message naming the step when the App is not installed, when GitHub refuses to create the repository, or when listing it fails.

## 3. What happens next

The planner reads the repository and writes the first \`fm:todo\` issues in the proofs repository; provers, the reviewer and the merger work them within the budget, and every run is logged on the swarm's notebook issues. The person follows along in the swarm workspace at ${ORIGIN}/ or on GitHub, and can ask any role with \`/ask <role> <question>\` (see the \`ask-formalmind\` skill).

## Edge cases

- Private repositories cannot be planned in step 1.
- The swarm is one team with one budget across its projects, so a new project shares the queue with the others.
- There is no API for steps 2 to 3; they need the browser and a GitHub sign-in.

Source: server/routes/onboarding/*, server/routes/projects/init/route.ts, lib/proofs-repo.ts, lib/billing.ts, components/onboarding/steps.tsx.
`,
};

const SKILLS: Skill[] = [ASK, ONBOARD];

function skillMd(s: Skill): string {
  return `---
name: ${s.name}
description: ${s.description}
license: MIT
metadata:
  publisher: formalmind
  homepage: ${ORIGIN}
---

${s.body}`;
}

async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function text(body: string, contentType: string, maxAge = 3600): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

/* /.well-known/agent-skills/index.json and each skill's SKILL.md, or null
 * when the path is not one of ours. */
export async function handleSkills(pathname: string): Promise<Response | null> {
  if (pathname === "/.well-known/agent-skills/index.json" || pathname === "/.well-known/agent-skills/") {
    const skills = await Promise.all(
      SKILLS.map(async (s) => ({
        name: s.name,
        type: "skill-md",
        description: s.description,
        url: `/.well-known/agent-skills/${s.name}/SKILL.md`,
        digest: `sha256:${await sha256Hex(skillMd(s))}`,
      })),
    );
    const body = { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills };
    return text(JSON.stringify(body, null, 2), "application/json; charset=utf-8");
  }

  const m = pathname.match(/^\/\.well-known\/agent-skills\/([a-z0-9-]+)\/SKILL\.md$/);
  if (m) {
    const skill = SKILLS.find((s) => s.name === m[1]);
    if (skill) return text(skillMd(skill), "text/markdown; charset=utf-8");
  }

  return null;
}
