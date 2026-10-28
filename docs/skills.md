# Skills and prior findings

Roadmap item 7: auditors bring their own skills, and Formal Mind runs them inside its loop. Two parts.

## 1. The Skills page

A page (Settings → Skills in the Mac app) listing free auditing skills, each with what it checks, who wrote it, its
licence and its source. **Add** adds a skill for every project on this computer; **Remove** takes it out.

- **What a skill is here:** Markdown checklists, pinned to a commit of their source repository. Added, the files are
  copied into `~/.formalmind/skills/<id>/` with a `SOURCE.md` naming the author, licence, repository and commit.
  Nothing runs: the files are read, never executed.
- **How the swarm uses it:** each agent's system prompt lists the added skills (as `@skills/<id>/<file>`, which
  `read_file` resolves to that folder), the files that apply to its
  role, and when to read them (the reviewer before its verdict, the prover when it looks for what could break). The
  agent reads them with `read_file`. Our own skills and role prompts don't change, and our checks still decide:
  `lake build`, `forge test`, a PoC for every bug.
- **First entries:**
  - Pashov Audit Group, *Hacking lenses* (MIT, [pashov/skills](https://github.com/pashov/skills)
    `solidity-auditor/references/hacking-agents/`): twelve focused checklists (access control, asymmetry,
    boundaries, economic security, execution traces, first principles, flow gaps, invariants, math precision,
    numerical gaps, periphery, trust gaps) and their shared rules, plus the judging guide.
  - Pashov Audit Group, *X-ray threats* (MIT, `x-ray/references/threats.md`): the threat catalogue x-ray uses.
  - Dickson Wu, *Vulnerability classes* (CC BY 4.0,
    [DicksonWu654/web3-audit-findings](https://github.com/DicksonWu654/web3-audit-findings) `taxonomy.yaml`): the
    corpus's 17 bug classes and 58 sub-classes, each with a definition, what it includes and excludes, and links to
    past findings of that kind. Only the taxonomy is copied; the findings' text stays with their publishers (below).
- **Auditing from the chat:** ask the assistant in the chat to audit something ("audit `Lending.liquidate` with the
  lenses"). It reads the lenses that fit, writes a Foundry PoC for each real issue, runs it and files it with
  `report_bug`, so the finding appears on the Bugs page, naming the lens that led to it.
- **Not included:** skills that orchestrate their own subagents (Pashov's `solidity-auditor` SKILL.md itself) or
  run scripts. The swarm already is the orchestrator; only the checklists plug in.
- **Licences:** only skills whose licence allows redistribution (MIT, Apache-2.0, CC BY). Each entry names its
  licence, and `SOURCE.md` keeps the attribution.

## 2. Prior findings

[DicksonWu654/web3-audit-findings](https://github.com/DicksonWu654/web3-audit-findings): 180,907 findings from
13,979 public audit reports by 65 firms, as plain text with metadata and a graph for agents.

- **As an agent tool, not a listing:** `prior_findings` takes a function's shape (what it guards, writes, calls, its
  arithmetic) and returns the closest past findings: title, firm, severity, a short snippet and a link to the report.
  The hunter and the reviewer use it; a bug report can cite the findings that led to it.
- **Licence:** the derived metadata is CC BY 4.0 (attribution: "Web3 Audit Corpus, Dickson Wu", and say what we
  changed). The finding text stays the publishers' copyright; some bodies are withheld at their request, and Oak
  Security's are CC BY-ND (no changes). So: index the metadata, show short snippets, always link the original report,
  never re-host report text in this public repository.
- **Quality:** the corpus is new. Check its `quality.csv` (measured extraction agreement) before relying on it, and
  show each result's quality flag.

## Order

1. The Skills page with the two Pashov entries and the corpus's vulnerability classes; Add and Remove per folder; the prompt note per role. *(first version)*
2. `prior_findings` over a local index built from the corpus (metadata and snippets only), with citations.
3. Bug reports that cite the prior findings and the lens that led to them.
