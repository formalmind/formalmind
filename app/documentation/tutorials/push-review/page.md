# 📤 Push-Based Suggestions

In this tutorial, you'll experience how the **Push Reviewer Agent** analyzes code changes and suggests edge cases or invariants — right after a simple `git push`.

---

## ✅ Objective

Push a new file or function to your repo and trigger the agent’s feedback.

---

## 🧪 Steps

### 1. Create or Choose a Repository

If you haven’t already:

- [Create a repo](https://github.com/new)
- [Install the Formal Mind GitHub App](https://github.com/apps/formal-mind-agent/installations/new) and give it access to this repo.

---

### 2. Add a New File

Create a new file like `src/counter.ts` with the following logic:

```ts
export class Counter {
  private value = 0

  increment(): void {
    this.value += 1
  }

  reset(): void {
    this.value = 0
  }

  get(): number {
    return this.value
  }
}
````

Commit and push to the `main` branch:

```bash
git add .
git commit -m "Add Counter class"
git push origin main
```

---

### 3. Wait for the Agent

The **Push Reviewer Agent** should leave a comment on the commit or open an issue in the repo suggesting:

* Pre/postconditions for methods
* Potential edge cases
* Initial formal observations or questions

---

### 4. Respond to the Agent (Optional)

You can reply to the comment with questions, thoughts, or even try tagging `@agent verify` to see what happens 👀

---

### ✅ Success Criteria

* You see a comment from the agent with insights
* It references specific lines or functions
* Bonus: it suggests a Lean formalization idea or invariant

---

> \[!INFO]
> The Push Reviewer is designed to be fast and lightweight — no repo forking or modeling yet. Just fast, local context-based feedback.

---

### Next Up

Ready to go deeper? Try [Modeling with Pull Requests →](/documentation/tutorials/pr-modeling)

Need help? [Email support](mailto:formalmindai@gmail.com)
