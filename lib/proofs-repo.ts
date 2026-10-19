import type { Octokit } from "@octokit/rest";
import { getAppOctokit, getInstallationOctokit } from "@/lib/octokit";
import { SWARM_REPO } from "@/lib/swarm-repo";
import { auditReportName, type SwarmMode } from "@/lib/teams";

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
async function registerWithSwarm(repo: string, proofsRepo: string, mode: SwarmMode): Promise<void> {
	const [owner, name] = SWARM_REPO.split("/");
	const octokit = await installationFor(owner, name);
	let sha: string | undefined;
	let projects: { repo: string; protocol: string; mode?: SwarmMode }[] = [{ repo: SWARM_REPO, protocol: "asyncswap/v2" }];
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
	const listed = projects.find((p) => p.repo === proofsRepo);
	if (listed && (listed.mode ?? "specs") === mode) return;
	const next = listed ? projects.map((p) => (p === listed ? { ...p, mode } : p)) : [...projects, { repo: proofsRepo, protocol: repo, mode }];
	const content = `${JSON.stringify({ projects: next }, null, "\t")}\n`;
	try {
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
			owner,
			repo: name,
			path: PROJECTS_FILE,
			message: listed ? `swarm: ${proofsRepo} in ${mode} mode` : `swarm: sweep ${proofsRepo}`,
			content: btoa(content),
			sha,
		});
	} catch (error) {
		throw new InitError("register", `${proofsRepo} exists, but listing it in ${SWARM_REPO}'s ${PROJECTS_FILE} failed (${(error as Error).message}).`);
	}
}

/** Sets a project up: its proofs repository from the template, listed for the swarm. */
export async function initProofsRepo(repo: string, mode: SwarmMode = "specs"): Promise<{ proofsRepo: string; created: boolean; report?: string }> {
	const result = await createProofsRepo(repo);
	await registerWithSwarm(repo, result.proofsRepo, mode);
	if (mode !== "audit") return result;
	const report = await startAudit(repo, result.proofsRepo);
	return { ...result, report };
}

/**
 * An audit starts at once: its report is opened in the proofs repository, then the swarm is dispatched
 * now instead of at its next sweep. Every finding, POC, fix and proof is added to that one report.
 */
async function startAudit(repo: string, proofsRepo: string): Promise<string> {
	const [owner, name] = proofsRepo.split("/");
	const octokit = await installationFor(owner, name);
	const path = auditReportName();
	const commit = await octokit
		.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner: repo.split("/")[0], repo: repo.split("/")[1], ref: "HEAD" })
		.then((r) => r.data.sha)
		.catch(() => null);
	const body = [
		`# Formal Mind audit: ${repo}`,
		"",
		`- Commit: ${commit ? `\`${commit}\`` : "the default branch's head when the audit started"}`,
		`- Started: ${new Date().toISOString().slice(0, 10)}`,
		"- Status: in progress",
		"",
		"Each finding below has a severity, the affected code, a Foundry POC that fails on the audited commit, the fix PR, and the Lean 4 proof that holds after the fix.",
		"",
		"## Summary",
		"",
		"| # | Title | Severity | POC | Fix | Proof |",
		"| --- | --- | --- | --- | --- | --- |",
		"",
		"## Findings",
		"",
		"_None yet._",
		"",
		"## Proved invariants",
		"",
		"_None yet._",
		"",
	].join("\n");
	try {
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path, message: `audit: open ${path}`, content: btoa(unescape(encodeURIComponent(body))) });
	} catch (error) {
		// Already there: the audit was started before, and the report keeps what it has.
		if (statusOf(error) !== 422) throw error;
	}
	const [homeOwner, homeName] = SWARM_REPO.split("/");
	const home = await installationFor(homeOwner, homeName);
	await home
		.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { owner: homeOwner, repo: homeName, workflow_id: "formalmind-swarm.yml", ref: (await home.request("GET /repos/{owner}/{repo}", { owner: homeOwner, repo: homeName })).data.default_branch })
		.catch((error) => console.error("[audit] dispatching the swarm failed; the next sweep picks it up:", error));
	return path;
}
