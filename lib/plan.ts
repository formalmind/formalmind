/**
 * The landing page's live plan: read a public Solidity repository and draft what the swarm
 * would verify first. Runs on our key, so the inputs are kept small (a few cents a plan).
 */
import { z } from "zod";

/** The repositories the landing page offers to try; their plans are kept for good and shared with everyone. */
export const EXAMPLE_REPOS = ["Uniswap/v4-core", "morpho-org/morpho-blue", "transmissions11/solmate"];

export const planSchema = z.object({
	summary: z.string().describe("Two sentences on what the protocol does, from the code"),
	contracts: z.array(z.object({
		name: z.string(),
		path: z.string(),
		role: z.string().describe("One short line: what this contract is responsible for"),
	})).describe("The core contracts, most important first, at most 6"),
	invariants: z.array(z.object({
		statement: z.string().describe("A property that must always hold, in plain words with contract and variable names"),
		why: z.string().describe("One line: what breaks if it does not hold"),
	})).describe("4 to 6 invariants worth proving"),
	issues: z.array(z.object({
		title: z.string().describe("Starts with 'spec:'; one provable unit of work"),
		scope: z.string().describe("Two sentences: what to model and what to prove"),
		files: z.array(z.string()),
		size: z.enum(["S", "M", "L"]),
	})).describe("The first 4 to 6 issues for the swarm, in the order to do them"),
	team: z.object({
		preset: z.enum(["solo", "pair", "trio", "squad"]),
		why: z.string().describe("One line on why this team size fits this codebase"),
	}),
});

export type RepoPlan = z.infer<typeof planSchema>;

export type RepoScan = {
	repo: string;
	description: string;
	stars: number;
	branch: string;
	readme: string;
	files: { path: string; size: number; text: string }[];
	solidityFiles: number;
};

/** "owner/repo", or any github.com URL into it. */
export function parseRepo(input: string): string | null {
	const match = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
	return match ? `${match[1]}/${match[2]}` : null;
}

const SKIP = /(^|\/)(lib|node_modules|test|tests|script|scripts|mocks?|interfaces?|examples?|deps|dependencies|out|cache)\//i;
const MAX_FILES = 6;
const MAX_CHARS = 9_000;

async function gh<T>(path: string): Promise<T> {
	const token = process.env.GITHUB_TOKEN;
	const res = await fetch(`https://api.github.com${path}`, {
		// GitHub refuses requests without a User-Agent, and Workers' fetch doesn't send one.
		headers: { Accept: "application/vnd.github+json", "User-Agent": "formalmind", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		cache: "no-store",
	});
	if (res.status === 404) throw new Error("not-found");
	// Out of requests for the hour (a server without GITHUB_TOKEN gets only 60).
	if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") throw new Error("rate-limited");
	if (!res.ok) throw new Error(`GitHub ${res.status}`);
	return res.json() as Promise<T>;
}

async function raw(repo: string, branch: string, path: string) {
	const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" });
	return res.ok ? res.text() : "";
}

/** The repository's README and its largest non-test Solidity files, trimmed. */
export async function scanRepo(repo: string): Promise<RepoScan> {
	const meta = await gh<{ full_name: string; description: string | null; stargazers_count: number; default_branch: string; private: boolean }>(`/repos/${repo}`);
	if (meta.private) throw new Error("not-found");
	const { tree } = await gh<{ tree: { path: string; type: string; size?: number }[] }>(`/repos/${meta.full_name}/git/trees/${meta.default_branch}?recursive=1`);
	const solidity = tree.filter((t) => t.type === "blob" && t.path.endsWith(".sol") && !/\.(t|s)\.sol$/.test(t.path));
	const core = solidity.filter((t) => !SKIP.test(t.path)).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, MAX_FILES);
	const readmePath = tree.find((t) => /^readme\.md$/i.test(t.path))?.path;
	const [readme, ...texts] = await Promise.all([
		readmePath ? raw(meta.full_name, meta.default_branch, readmePath) : Promise.resolve(""),
		...core.map((f) => raw(meta.full_name, meta.default_branch, f.path)),
	]);
	return {
		repo: meta.full_name,
		description: meta.description ?? "",
		stars: meta.stargazers_count,
		branch: meta.default_branch,
		readme: readme.slice(0, 4_000),
		files: core.map((f, i) => ({ path: f.path, size: f.size ?? 0, text: texts[i].slice(0, MAX_CHARS) })),
		solidityFiles: solidity.length,
	};
}

export function planPrompt(scan: RepoScan) {
	return [
		`Repository: ${scan.repo} (${scan.stars} stars, ${scan.solidityFiles} Solidity files). ${scan.description}`,
		`README (start):\n${scan.readme || "(none)"}`,
		...scan.files.map((f) => `--- ${f.path} (${f.size} bytes, start) ---\n${f.text}`),
	].join("\n\n");
}

export const PLANNER_SYSTEM = `You are the planner of Formal Mind, a swarm of agents that writes a Lean 4 specification of a Solidity protocol and proves its invariants, one small GitHub issue at a time.
From the code you are given, draft the first plan: what the protocol does, its core contracts, the invariants worth proving first (conservation of balances, access control, ordering, bounds), and 4 to 6 small, disjoint issues for the swarm in the order to do them. Every issue title starts with "spec:" and is provable on its own.
Use only names that appear in the code. Be concrete and brief. Pick the team preset that fits the size of the codebase: solo for one or two small contracts, pair for most protocols, trio when the code is high-stakes and intricate, squad only for many independent contracts.`;
