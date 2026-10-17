# formalmind

formalmind keeps a formal specification honest while the code it describes keeps moving.
Today it watches the Async Swap protocol (`asyncswap/v2`, Solidity) and maintains its
Lean 4 + Mathlib specification (`asyncswap/v2-proofs`): every theorem there is machine
checked, no `sorry`, no new axioms, and the bots that maintain it talk on GitHub like
members of the team.

## What we do

- **Reconcile on every protocol push.** A GitHub webhook on the protocol repository goes
  to a Cloudflare Worker, which forwards the commit as a `repository_dispatch` to the
  proofs repository. There the formal-mind bot reads the Solidity diff, updates the Lean
  definitions that model it, re-proves what broke, records the result in `FORMAL_MIND.md`
  (the changelog, including anything it could not prove), and opens a pull request only
  when `lake build` is clean.
- **Answer when tagged.** Mention `@formalmind` in any issue, pull request or review of
  the proofs repository. A triage step answers plain chat in seconds; questions about the
  spec get a run that reads the repository; requests for changes get the full Lean
  toolchain. The bot replies as a normal commenter, posts as `formalmind[bot]`, cites code
  with permalinks that GitHub renders inline, leaves inline review comments with
  suggestion blocks, and pushes to the branch when asked. It reacts 👀 the moment it sees
  a message and 👍 or 😕 when it is done.
- **Work the roadmap on its own.** A swarm of roles owns the open work within a spend
  budget ($2 a day, $50 a month): a **planner** turns the roadmap into small issues, a
  **prover** implements them on branches and opens pull requests, a **reviewer** reads the
  whole diff and suggests changes, and a **merger** builds the exact head, verifies every
  claim made in the thread against the code, decides whether a human must look, and
  merges. Issues and `fm:*` labels are the task queue, a pinned ledger issue is the spend
  log and digest channel, and the roles hand off to each other by tagging `@fm-prover`,
  `@fm-reviewer` and `@fm-merger` in comments. A human is tagged only when a decision is
  needed.

The design of the swarm, its labels and its safety rails are documented in
`asyncswap/v2-proofs/.github/formalmind/README.md`. GitHub webhooks are relayed by a
stateless Cloudflare Worker in `formalmind/webhook-redis/worker`: it verifies push
deliveries, forwards them to the proofs repository as `repository_dispatch`, and starts
the swarm workflow on a schedule. The web app no longer uses Redis.

# Getting Started

First, clone this repo and run

```sh
bun install
```

Project stack:

- Github app - wehooks /api/github/webhook
- Auth0 - Gen AI auth
- LLMs

## Setup

1. Copy .env file to `.env.local` and add environment variables

   ```sh
   cp example.env.local .env.local
   ```

2. Update auth0 secrets

   ```txt
   # auth0
   AUTH0_SECRET='use [openssl rand -hex 32] to generate a 32 bytes value'
   APP_BASE_URL=http://localhost:3000
   AUTH0_DOMAIN=
   AUTH0_CLIENT_ID=
   AUTH0_CLIENT_SECRET=
   AUTH0_M2M_CLIENT_ID=
   AUTH0_M2M_CLIENT_SECRET=

   # llms api
   OPENAI_API_KEY=
   LAMBDA_BASE_URL=https://api.lambda.ai/v1
   LAMBDA_API_KEY=
   GROQ_BASE_URL=https://api.groq.com/openai/v1
   GROQ_API_KEY=
   HF_TOKEN=

   # github app
   GITHUB_APP_ID=
   GITHUB_WEBHOOK_SECRET=
   GITHUB_APP_PRIVATE_KEY=
   ```

> [!TIP]
>
> ### Auth0 setup authentication
>
> Dependencies `npm i @auth0/nextjs-auth0`
>
> - [ ] [User authentication](https://auth0.com/ai/docs/user-authentication)

3. Run the development server:

   ```sh
   bun dev
   ```

## Local chat

The app runs on http://localhost:3001. Set `OPENAI_API_KEY` in `.env.local`
for live chat responses. Chat history currently uses browser localStorage.
GitHub repository tools require a configured Auth0/GitHub connection.

```sh
bun dev --port 3001
```
