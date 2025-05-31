# 🧠 Modeling with Pull Requests

In this tutorial, you'll create a Pull Request and watch the **Modeling Agent** generate formal specifications, invariants, and Lean IR suggestions — based on your code changes.

---

## ✅ Objective

Trigger the Modeling Agent by creating a pull request that adds new behavior or logic.

---

## 🧪 Steps

### 1. Create a New Branch

```bash
git checkout -b add-user-registry
````

---

### 2. Add Some Meaningful Logic

Create a file like `src/registry.ts`:

```ts
type User = { id: number; name: string }

export class Registry {
  private users = new Map<number, User>()

  addUser(user: User): void {
    if (!this.users.has(user.id)) {
      this.users.set(user.id, user)
    }
  }

  getUser(id: number): User | undefined {
    return this.users.get(id)
  }
}
```

Commit the changes:

```bash
git add .
git commit -m "Add user registry"
git push origin add-user-registry
```

---

### 3. Open a Pull Request

Open a PR from `add-user-registry` → `main`.

---

### 4. Wait for the Modeling Agent

The agent will leave a comment analyzing:

* The state structure (e.g. the `Map`)
* Function behavior (e.g. `addUser`, `getUser`)
* Inferred specs or invariants
* A Lean IR or direct spec handoff

> Example output:
>
> ```
> inferred_spec:
> def addUser_spec (r : Registry) (u : User) : Registry :=
>   if u.id ∉ r.users then r.users.insert u.id u else r
> ```

---

## 💬 Reply to the Agent

You can engage with the agent’s comment, e.g.:

```md
Interesting — what happens if I allow overwriting users?

@agent verify
```

This will trigger Lean project generation in the next tutorial 👇

---

## ✅ Success Criteria

* The agent posts a comment in your PR
* It contains inferred logic, Lean IR, or invariants
* You begin to see the formal shape of your implementation

---

> [!TIP]
> The Modeling Agent works best on small, composable modules. Break your logic into files and functions for clearer modeling.

---

### Next Up

➡️ [Triggering Formal Verification with @agent verify →](/documentation/tutorials/formal-verification)

Need help? [Email support](mailto:formalmindai@gmail.com)
