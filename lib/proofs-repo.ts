import type { Octokit } from "@octokit/rest";
import { getAppOctokit, getInstallationOctokit } from "@/lib/octokit";
import { SWARM_REPO } from "@/lib/swarm-repo";

/** The template every proofs repository starts from. */
export const PROOFS_TEMPLATE = { owner: "formalmind", repo: "lean-template" };
const PROJECTS_FILE = ".github/formalmind/projects.json";

/** `<owner>/<name>-proofs`, the proofs repository for a protocol repository. */
export const proofsRepoFor = (repo: string) => `${repo}-proofs`;

/** A failure the person can act on: which step broke and what to change. */
export class InitError extends Error {
	constructor(readonly step: "install" | "create" | "register", message: string) {
		super(message);
	}
}

const statusOf = (error: unknown) => (error as { status?: number }).status;

async function installationFor(owner: string, repo: string): Promise<Octokit> {
	try {
		const { data } = await getAppOctokit().request("GET /repos/{owner}/{repo}/installation", { owner, repo });
		return getInstallationOctokit(data.id);
	} catch (error) {
		if (statusOf(error) === 404) throw new InitError("install", `The formalmind GitHub App isn't installed on ${owner}/${repo}. Install it on ${owner} (all repositories, so it can reach the new proofs repository), then try again.`);
		throw error;
	}
}

/** Creates `<repo>-proofs` from the template under the protocol's owner; an existing one is reused. */
async function createProofsRepo(repo: string): Promise<{ proofsRepo: string; created: boolean }> {
	const [owner, name] = repo.split("/");
	const proofsRepo = proofsRepoFor(repo);
	const octokit = await installationFor(owner, name);
	try {
		await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: `${name}-proofs` });
		return { proofsRepo, created: false };
	} catch (error) {
		if (statusOf(error) !== 404) throw error;
	}
	const { data: protocol } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name });
	try {
		await octokit.request("POST /repos/{template_owner}/{template_repo}/generate", {
			template_owner: PROOFS_TEMPLATE.owner,
			template_repo: PROOFS_TEMPLATE.repo,
			owner,
			name: `${name}-proofs`,
			description: `Lean proofs for ${repo}, written by the Formal Mind swarm.`,
			private: protocol.private,
		});
	} catch (error) {
		const status = statusOf(error);
		if (status === 403 || status === 404)
			throw new InitError(
				"create",
				protocol.owner.type === "User"
					? `GitHub doesn't let an App create repositories in a personal account (${owner}). Create ${proofsRepo} from ${PROOFS_TEMPLATE.owner}/${PROOFS_TEMPLATE.repo} ("Use this template"), then try again.`
					: `The formalmind App can't create repositories in ${owner}. In ${owner}'s settings → GitHub Apps → formalmind, accept the "Administration: write" permission and give it access to all repositories, then try again.`,
			);
		if (status === 422) throw new InitError("create", `GitHub refused to create ${proofsRepo}: ${(error as Error).message}`);
		throw error;
	}
	return { proofsRepo, created: true };
}

/** Lists the proofs repository in the home's projects.json, so the canvas and dispatcher see it. */
async function registerWithSwarm(repo: string, proofsRepo: string): Promise<void> {
	const [owner, name] = SWARM_REPO.split("/");
	const octokit = await installationFor(owner, name);
	let sha: string | undefined;
	let projects: { repo: string; protocol: string }[] = [{ repo: SWARM_REPO, protocol: "asyncswap/v2" }];
	try {
		const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path: PROJECTS_FILE });
		if (!Array.isArray(data) && data.type === "file") {
			sha = data.sha;
			const parsed = JSON.parse(atob(data.content.replace(/\s/g, ""))) as { projects?: typeof projects };
			if (parsed.projects?.length) projects = parsed.projects;
		}
	} catch (error) {
		if (statusOf(error) !== 404) throw error;
	}
	if (projects.some((p) => p.repo === proofsRepo)) return;
	const content = `${JSON.stringify({ projects: [...projects, { repo: proofsRepo, protocol: repo }] }, null, "\t")}\n`;
	try {
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
			owner,
			repo: name,
			path: PROJECTS_FILE,
			message: `swarm: sweep ${proofsRepo}`,
			content: btoa(content),
			sha,
		});
	} catch (error) {
		throw new InitError("register", `${proofsRepo} exists, but listing it in ${SWARM_REPO}'s ${PROJECTS_FILE} failed (${(error as Error).message}).`);
	}
}

/** Sets a project up: its proofs repository from the template, listed for the swarm. */
export async function initProofsRepo(repo: string): Promise<{ proofsRepo: string; created: boolean }> {
	const result = await createProofsRepo(repo);
	await registerWithSwarm(repo, result.proofsRepo);
	return result;
}
