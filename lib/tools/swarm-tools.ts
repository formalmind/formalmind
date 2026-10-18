import { tool } from "ai";
import { z } from "zod";
import { github, SWARM_REPO } from "@/lib/swarm";

/**
 * Read-only tools the swarm chat can call to look things up in the proofs repository
 * while it answers. Nothing here writes to GitHub.
 */

const MAX_TEXT = 6_000;

function clip(text: string | null | undefined, max = MAX_TEXT) {
	const value = text ?? "";
	return value.length > max ? `${value.slice(0, max)}\n…(truncated, ${value.length - max} more characters)` : value;
}

/** Tool failures go back to the model as data so it can say what went wrong instead of crashing the reply. */
async function safely<T>(run: () => Promise<T>): Promise<T | { error: string }> {
	try {
		return await run();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type Comment = { user: { login: string } | null; body: string | null; created_at: string; html_url: string };

/**
 * The tools for one chat. `repos` are the proofs repositories on the board (the swarm's home first); a tool
 * only reads those, so the chat cannot reach other repositories the server's token can see.
 */
export function swarmTools(repos: string[]) {
	const home = repos[0] ?? SWARM_REPO;
	const repo = z.string().describe(`Proofs repository (owner/name), one of: ${repos.join(", ")}. The ledger, notebook, chief, assistant and runs are in ${home}`);
	const allowed = (name: string) => {
		if (!repos.includes(name)) throw new Error(`${name} is not one of the swarm's repositories (${repos.join(", ")})`);
		return name;
	};
	return {
		getIssue: tool({
			description: "Read an issue or pull request in the proofs repository: title, state, labels, body and its latest comments.",
			parameters: z.object({
				repo,
				number: z.number().int().positive().describe("Issue or pull request number"),
				comments: z.number().int().min(0).max(30).describe("How many of the latest comments to include; 10 is usually enough"),
			}),
			execute: ({ repo: name, number, comments }) => safely(async () => {
				const r = allowed(name);
				const issue = await github<{
					number: number; title: string; state: string; html_url: string; body: string | null; comments: number;
					labels: { name: string }[]; user: { login: string } | null; created_at: string; pull_request?: { merged_at: string | null };
				}>(`/issues/${number}`, r);
				const page = Math.max(1, Math.ceil(issue.comments / 100));
				const thread = issue.comments && comments ? await github<Comment[]>(`/issues/${number}/comments?per_page=100&page=${page}`, r) : [];
				return {
					number: issue.number,
					kind: issue.pull_request ? "pull request" : "issue",
					title: issue.title,
					state: issue.pull_request?.merged_at ? "merged" : issue.state,
					labels: issue.labels.map((l) => l.name),
					author: issue.user?.login,
					createdAt: issue.created_at,
					url: issue.html_url,
					body: clip(issue.body),
					totalComments: issue.comments,
					latestComments: thread.slice(-comments).map((c) => ({ author: c.user?.login, at: c.created_at, url: c.html_url, body: clip(c.body, 1_500) })),
				};
			}),
		}),

		getPullRequestFiles: tool({
			description: "List the files a pull request changes, with additions and deletions, and the start of each patch.",
			parameters: z.object({ repo, number: z.number().int().positive() }),
			execute: ({ repo: name, number }) => safely(async () => {
				const files = await github<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(`/pulls/${number}/files?per_page=50`, allowed(name));
				return files.map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: clip(f.patch, 1_200) }));
			}),
		}),

		getRun: tool({
			description: "Inspect one swarm workflow run: its jobs, the status of every step, and how it ended. Run ids come from the live state.",
			parameters: z.object({ runId: z.number().int().positive() }),
			execute: ({ runId }) => safely(async () => {
				const [run, { jobs }] = await Promise.all([
					github<{ id: number; status: string; conclusion: string | null; event: string; run_started_at: string; updated_at: string; html_url: string }>(`/actions/runs/${runId}`),
					github<{ jobs: { name: string; status: string; conclusion: string | null; started_at: string; completed_at: string | null; steps?: { name: string; status: string; conclusion: string | null }[] }[] }>(`/actions/runs/${runId}/jobs`),
				]);
				return {
					id: run.id,
					event: run.event,
					status: run.status,
					conclusion: run.conclusion,
					startedAt: run.run_started_at,
					updatedAt: run.updated_at,
					url: run.html_url,
					jobs: jobs.map((j) => ({
						name: j.name,
						status: j.status,
						conclusion: j.conclusion,
						startedAt: j.started_at,
						completedAt: j.completed_at,
						steps: (j.steps ?? []).filter((s) => s.conclusion !== "skipped").map((s) => `${s.name}: ${s.conclusion ?? s.status}`),
					})),
				};
			}),
		}),

		readFile: tool({
			description: "Read a file from the proofs repository, such as .formal/plan.md (decisions and roadmap; README.md in projects not yet moved), .formal/notebook.json (config), FORMAL_MIND.md (changelog) or a Lean file. Use listFiles to find paths.",
			parameters: z.object({
				repo,
				path: z.string().describe("Path from the repository root, e.g. FORMAL_MIND.md or AsyncSwapProtocol/V2/BalNonNeg.lean"),
				ref: z.string().describe("Branch, tag or commit; the swarm works on dev"),
			}),
			execute: ({ repo: name, path, ref }) => safely(async () => {
				const file = await github<{ content?: string; encoding?: string; size: number; html_url: string; type: string }>(
					`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
					allowed(name),
				);
				if (file.type !== "file" || !file.content) return { error: `${path} is not a file` };
				const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
				return { path, ref, url: file.html_url, size: file.size, content: clip(text, 12_000) };
			}),
		}),

		listFiles: tool({
			description: "List the files and folders at a path in the proofs repository.",
			parameters: z.object({
				repo,
				path: z.string().describe("Folder path from the repository root; empty string for the root"),
				ref: z.string().describe("Branch, tag or commit; the swarm works on dev"),
			}),
			execute: ({ repo: name, path, ref }) => safely(async () => {
				const entries = await github<{ name: string; path: string; type: string; size: number }[]>(
					`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
					allowed(name),
				);
				return entries.map((e) => ({ path: e.path, type: e.type, size: e.size }));
			}),
		}),

		searchIssues: tool({
			description: "Search issues and pull requests in the proofs repository by text and qualifiers, e.g. 'label:fm:blocked', 'is:pr is:merged BalNonNeg'.",
			parameters: z.object({ repo, query: z.string() }),
			execute: ({ repo: name, query }) => safely(async () => {
				const r = allowed(name);
				const token = process.env.GITHUB_TOKEN;
				const res = await fetch(`https://api.github.com/search/issues?per_page=15&q=${encodeURIComponent(`repo:${r} ${query}`)}`, {
					headers: { Accept: "application/vnd.github+json", "User-Agent": "formalmind", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
					cache: "no-store",
				});
				if (!res.ok) throw new Error(`GitHub search: ${res.status} ${res.statusText}`);
				const { total_count, items } = await res.json() as {
					total_count: number;
					items: { number: number; title: string; state: string; html_url: string; labels: { name: string }[]; pull_request?: unknown; updated_at: string }[];
				};
				return {
					total: total_count,
					results: items.map((i) => ({ number: i.number, kind: i.pull_request ? "pr" : "issue", title: i.title, state: i.state, labels: i.labels.map((l) => l.name), updatedAt: i.updated_at, url: i.html_url })),
				};
			}),
		}),
	};
}
