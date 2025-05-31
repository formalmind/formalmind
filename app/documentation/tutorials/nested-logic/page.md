
# 🧩 Nested Logic & Compositional Reasoning

Ready to turn up the heat? This tutorial explores how the agent handles nested modules and more complex logic structures.

---

## ✅ Objective

Add nested modules (e.g. `src/utils/math/`) and verify their behavior using the Modeling Agent and `@agent verify`.

---

## 🧪 Steps

### 1. Create a New Branch

```bash
git checkout -b feature/nested-graph
````

---

### 2. Add a Deeply Nested File

Create `src/utils/math/graph.ts`:

```ts
export type NodeID = number

export class Graph {
  private edges: Map<NodeID, Set<NodeID>> = new Map()

  addEdge(from: NodeID, to: NodeID): void {
    if (!this.edges.has(from)) this.edges.set(from, new Set())
    this.edges.get(from)?.add(to)
  }

  getNeighbors(id: NodeID): Set<NodeID> | undefined {
    return this.edges.get(id)
  }

  hasPath(start: NodeID, end: NodeID): boolean {
    const visited = new Set<NodeID>()
    const dfs = (node: NodeID): boolean => {
      if (node === end) return true
      if (visited.has(node)) return false
      visited.add(node)
      for (const neighbor of this.getNeighbors(node) ?? []) {
        if (dfs(neighbor)) return true
      }
      return false
    }
    return dfs(start)
  }
}
```

---

### 3. Open a Pull Request

```bash
git add .
git commit -m "Add graph traversal logic"
git push origin feature/nested-graph
```

Open a PR targeting `main`.

---

### 4. Wait for the Modeling Agent

Expect it to respond with:

* A model of the graph structure (`Map<NodeID, Set<NodeID>>`)
* Spec stubs for `addEdge`, `hasPath`, etc.
* Invariants such as acyclic properties or reachability

---

### 5. Tag `@agent verify`

In a reply to the Modeling Agent's comment:

```
@agent verify
```

Watch the agent:

✅ Extend your Lean repo with new spec files
✅ Generate proofs or tactics for nested logic
✅ Push changes and trigger CI again

---

## ✅ Success Criteria

* The modeling handles deep folder structures
* Agent comments reference nested paths correctly
* Lean CI builds and includes new modules

---

> \[!IMPORTANT]
> The agent respects modularity. It treats each file as a component — composing their behavior into a larger formal model.

---

## 🧠 Bonus Challenge

Try encoding *cyclic detection* or *topological sort*. See how far the agent can go, and where *you* might step in as the verifier.

---

### You’ve reached the edge of the tutorials 🧵

Feeling brave? Try combining multiple agents across workflows:

* Push → PR → Modeling → Verification → Post-Verify CI

Need help? [Email support](mailto:formalmindai@gmail.com)
