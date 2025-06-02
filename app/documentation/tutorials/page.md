# 🧪 Tutorials

These tutorials walk you through real workflows using the Formal Mind Agent. Start with a basic modeling session, and progress to full-stack verification with Lean 4.

## 🧠 Available Tutorials

### [1. Push-Based Suggestions](/documentation/tutorials/push-review)

> 🧾 Learn how the Push Reviewer Agent responds to code changes.

- Create a new function in `main.ts`
- Push to `main` or `dev`
- See how the agent comments on possible edge cases or logical invariants

### [2. Modeling with Pull Requests](/documentation/tutorials/pr-modeling)

> 🧠 Introduce new logic and see how the Modeling Agent responds.

- Create a new branch
- Add a stateful module (e.g. counter, registry, etc.)
- Open a PR and wait for a Lean IR or spec comment

### [3. Formal Verification Trigger](/documentation/tutorials/formal-verification)

> ✍🏽 Trigger Lean repo generation with `@agent verify`.

- Reply to the modeling comment with `@agent verify`
- Inspect the generated Lean repo
- Understand the template structure and CI results

### [4. Updating Specs Across Commits](/documentation/tutorials/incremental-specs)

> 🔁 Test how the agent tracks changes and expands your spec.

- Add new functions to existing modules
- See if the verification repo is updated with new spec stubs
- Watch how the agent preserves previously verified code

### [5. Nested Logic & Compositional Reasoning](/documentation/tutorials/nested-logic)

> 🧩 Create a library with deep nesting, and model its behavior.

- Add logic to `src/utils/math/graph.ts`
- Open a PR and tag `@agent verify`
- Review how the agent generates structured specs across modules

### 🧠 Bonus Challenge: HK's Exploration Tutorial (Coming Soon)

Want to go deeper?

Soon you'll be able to walk through your repo's entire **Git history** — from the **first commit** to the **latest** — and let the agent model how your logic evolved over time. Each step becomes a checkpoint for symbolic modeling and proof.

Think of it as formal archaeology 🏺✨

> [!INFO]
> You’ll explore your project's evolution **one commit at a time**, letting the agent extract models, refactor specs, and verify step-wise correctness.

#### Coming Soon

* 🧬 Diff-based modeling for each commit
* 🧠 Proof state tracking through Git history
* 🕵🏽‍♂️ Symbol lineage across refactors
* 🔍 GitHub visualizer for commit → theorem mapping

---

Want early access? [Email us](mailto:formalmindai@gmail.com) or [star the project](https://github.com/formalmind/formalmind) to get notified. 🌟

> [!TIP]
> Tutorials are designed to be async — the agent will respond at your pace. You can revisit any branch or commit and verify on demand.

Need help completing a tutorial? [Contact support](mailto:formalmindai@gmail.com)
