import { getJSON, putJSON } from "@/lib/kv";

/** A protocol repository someone added, and the proofs repository published for it (once there is one). */
export type Project = {
	repo: string;
	proofsRepo: string | null;
	addedAt: string;
};

const key = (sub: string) => `projects:${sub}`;

export async function listProjects(sub: string): Promise<Project[]> {
	return (await getJSON<Project[]>(key(sub))) ?? [];
}

/** Adds a repository to the account's projects; a no-op when it is already there. */
export async function addProject(sub: string, repo: string): Promise<void> {
	const saved = (await getJSON<Project[]>(key(sub))) ?? [];
	if (saved.some((p) => p.repo === repo)) return;
	await putJSON(key(sub), [...saved, { repo, proofsRepo: null, addedAt: new Date().toISOString() }]);
}
