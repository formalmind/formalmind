# Contributing to Formal Mind

Thanks for helping. This repository is licensed under **AGPL-3.0-only** (see [LICENSE](LICENSE)); the
`crates/formal-ast` and `crates/formal-ast-wasm` crates remain MIT.

## Before you open a pull request

- Read [AGENTS.md](AGENTS.md) for the repository layout and the rules that keep the app, the Worker, and the docs in
  step.
- Follow [DESIGN.md](DESIGN.md) for anything users see.
- Run `bunx tsc --noEmit -p .` and `bun run build` before pushing.
- Keep the swarm's one-item-per-function loop and the skills (`worker/skills.ts`, the role prompts) as they are unless
  the change is explicitly about them.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/). Use `git commit -s`. By signing off you confirm
that you wrote the contribution, or have the right to submit it, and that it may be distributed under this repository's
license.

We do not require a copyright assignment today. If Formal Mind later offers a commercial license alongside the AGPL, we
may ask contributors for a separate CLA; code already merged under the AGPL stays available under the AGPL.

## Reporting security issues

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on
<https://github.com/formalmind/formalmind> or email the address in the commit history.

## Trademarks

The license does not grant rights to the Formal Mind name or logo. See [TRADEMARK.md](TRADEMARK.md).
