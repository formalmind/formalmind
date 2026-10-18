import { getJSON, putJSON } from "@/lib/kv";
import { SWARM_REPO } from "@/lib/swarm-repo";

/** A protocol repository someone set up, and the proofs repository its swarm works in (once it has one). */
export type Project = {
	repo: string;
	proofsRepo: string | null;
	addedAt: string;
};

/** The swarm that is already running, on asyncswap/v2. Every account sees it until per-account swarms exist. */
export const LIVE_PROJECT: Project = { repo: "asyncswap/v2", proofsRepo: SWARM_REPO, addedAt: "2026-10-13T00:00:00.000Z" };

const key = (sub: string) => `projects:${sub}`;

export async function listProjects(sub: string): Promise<Project[]> {
	const saved = (await getJSON<Project[]>(key(sub))) ?? [];
	return [LIVE_PROJECT, ...saved.filter((p) => p.repo !== LIVE_PROJECT.repo)];
}

/** Adds a repository to the account's projects; a no-op when it is already there. */
export async function addProject(sub: string, repo: string): Promise<void> {
	const saved = (await getJSON<Project[]>(key(sub))) ?? [];
	if (repo === LIVE_PROJECT.repo || saved.some((p) => p.repo === repo)) return;
	await putJSON(key(sub), [...saved, { repo, proofsRepo: null, addedAt: new Date().toISOString() }]);
}

/** Records the proofs repository a project's swarm works in. */
export async function setProofsRepo(sub: string, repo: string, proofsRepo: string): Promise<void> {
	const saved = (await getJSON<Project[]>(key(sub))) ?? [];
	const exists = saved.some((p) => p.repo === repo);
	const next = exists
		? saved.map((p) => (p.repo === repo ? { ...p, proofsRepo } : p))
		: [...saved, { repo, proofsRepo, addedAt: new Date().toISOString() }];
	await putJSON(key(sub), next);
}
