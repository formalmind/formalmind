# 🚀 Get Started with Formal Mind

Welcome, agent operator. You're about to onboard the Formal Mind Agent onto your own repo, where it will watch your commits, model your code, and guide you through human-in-the-loop formal verification.

---

## 🧱 Step 1: Create a GitHub Repo

1. Go to [GitHub](https://github.com/new) and create a public or private repository.
2. Name it something like `lean-agent-demo`.

---

## 🤖 Step 2: Install the GitHub App

[🧠 **Install Formal Mind Agent**](https://github.com/apps/formal-mind-agent/installations/new)

Make sure to:
- Select your newly created repo
- Grant access to **repository contents** and **pull requests**

---

## 📤 Step 3: Push a File

Create a file (e.g. `src/main.ts`) with some meaningful logic, like:

```ts
export function add(x: number, y: number): number {
  return x + y
}
````

Commit and push to `main`.
Wait for the **Push Reviewer Agent** to comment on specific lines or suggest improvements.

---

## 🌱 Step 4: Create a Branch + PR

1. Create a branch: `git checkout -b model-my-code`
2. Add or modify logic, like:

```ts
export function isEven(n: number): boolean {
  return n % 2 === 0
}
```

3. Open a Pull Request to `main`.

---

## 🧠 Step 5: Watch the Modeling Agent Work

The Modeling Agent will leave a comment with:

* A suggested Lean model
* Inferred invariants or preconditions
* A handoff in Lean IR, if applicable

---

## 🔁 Step 6: Trigger Verification with `@agent verify`

Reply to the agent’s comment like:

```
@agent verify
```

The agent will:

* Create a new repo from [`formalmind/lean-template`](https://github.com/formalmind/lean-template)
* Push the Lean specification and proof stubs into it
* Set up CI to build the Lean code

Check your GitHub to find this repo — it should be under your account.

---

## 🧪 Step 7: Add Nested Logic

Create a file like `src/library/math.ts` with complex logic.

Open a new PR. Tag the modeling agent again:

```
@agent verify
```

It will add or update formal specs in the verification repo it created earlier.

---

> [!INFO]
> The agent will respond gradually, modeling and verifying at your pace. You can always pause and return to the process later — the agent’s memory lives in GitHub.

---

## 🧠 That’s It!

You’ve now:

* Created a repo ✅
* Triggered the modeling agent ✅
* Verified Lean code with CI ✅
* Used `@agent verify` to request formal analysis ✅

Need help? [Contact support](mailto:formalmindai@gmail.com)
Or check the [Documentation TOC](/documentation)
