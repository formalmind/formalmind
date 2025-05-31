
# ✅ Formal Verification with @agent verify

Once the Modeling Agent suggests a spec, you can reply to trigger full formal verification.

This will create a new repository with Lean code, pre-filled with specification stubs, proof scaffolds, and Lean CI built-in.

---

## ✅ Objective

Use `@agent verify` to generate a formal verification repo from your PR.

---

## 🧪 Steps

### 1. Open a Pull Request (if you haven’t already)

If you're continuing from the [Modeling Tutorial](/documentation/tutorials/pr-modeling), just stay in that PR.

If not, open a new one with meaningful logic, like:

```ts
export function safeDivide(a: number, b: number): number {
  if (b === 0) return 0
  return a / b
}
````

---

### 2. Wait for the Agent to Comment

Let the Modeling Agent respond with:

* A spec suggestion
* Lean IR
* Pre/postconditions
* A question for clarification

---

### 3. Reply With the Magic Words

Leave a comment **replying** to the agent:

```
@agent verify
```

That’s it! The agent will:

✅ Fork from [`formalmind/lean-template`](https://github.com/formalmind/lean-template)
✅ Create a new Lean project in your GitHub
✅ Push modeled specs into the Lean project
✅ Open a PR if needed
✅ Trigger GitHub Actions to verify the Lean code

---

### 4. Check the Lean Verification Repo

You’ll find a new repo in your GitHub account (e.g. `lean-agent-verification`).

Explore it:

* See the folder structure (`src`, `Specs`, `Theorems`)
* Look at the `.github/workflows/lean.yml` CI file
* Open `lakefile.lean` to see the Lean package metadata

> \[!TIP]
> The Lean repo will grow over time — as you update the main repo and re-verify, the agent will extend or refine the specs!

---

## ✅ Success Criteria

* A new Lean repo is created and accessible
* It contains at least one `.lean` spec file
* GitHub Actions run and report CI status ✅

---

### Next Up

Want to model deeper logic or multiple modules?

➡️ [Try Nested Logic & Compositional Specs →](/documentation/tutorials/nested-logic)

---

> \[!WARNING]
> If verification fails, check the agent's output for tactic errors or unsupported patterns. You can always adjust your implementation or modeling assumptions.

Need help? [Email support](mailto:formalmindai@gmail.com)
