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
	constructor(readonly step: "install" | "create" | "register" | "configure", message: string) {
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

export type SwarmSetup = { mode: SwarmMode; maintainer: string; team: number; dailyUsd: number };

/** Sets a project up: its proofs repository from the template, configured, listed for the swarm, and started. */
export async function initProofsRepo(repo: string, setup: SwarmSetup): Promise<{ proofsRepo: string; created: boolean; report?: string }> {
	const result = await createProofsRepo(repo);
	await registerWithSwarm(repo, result.proofsRepo, setup.mode);
	const [owner, name] = result.proofsRepo.split("/");
	const octokit = await installationFor(owner, name);
	const report = setup.mode === "audit" ? auditReportName() : "";
	const commit = setup.mode === "audit" ? await headCommit(octokit, repo) : "";
	// The home repository runs its own older swarm; every other proofs repository is configured from the template.
	if (result.proofsRepo !== SWARM_REPO) {
		const config = { protocol: repo, commit, mode: setup.mode, maintainer: setup.maintainer, team: setup.team, dailyUsd: setup.dailyUsd, monthlyUsd: setup.dailyUsd * 30, report };
		await putFile(octokit, result.proofsRepo, ".formal/swarm.json", `${JSON.stringify(config, null, "\t")}\n`, `swarm: ${setup.mode} for ${repo}`, true);
	}
	if (report) await putFile(octokit, result.proofsRepo, report, reportBody(repo, commit), `audit: open ${report}`, false);
	await octokit
		.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { owner, repo: name, workflow_id: "formalmind-swarm.yml", ref: (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name })).data.default_branch })
		.catch((error) => console.error("[init] starting the swarm failed; its next sweep starts it:", error));
	return report ? { ...result, report } : result;
}

async function headCommit(octokit: Octokit, repo: string): Promise<string> {
	const [owner, name] = repo.split("/");
	return octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo: name, ref: "HEAD" }).then((r) => r.data.sha).catch(() => "");
}

/**
 * Writes one file on the default branch. A repository just generated from the template takes a moment to have
 * its first commit, so a missing branch is retried. `replace` overwrites; otherwise an existing file is kept.
 */
async function putFile(octokit: Octokit, repo: string, path: string, body: string, message: string, replace: boolean): Promise<void> {
	const [owner, name] = repo.split("/");
	for (let attempt = 0; ; attempt++) {
		let sha: string | undefined;
		try {
			const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path });
			if (!replace) return;
			if (!Array.isArray(data)) sha = data.sha;
		} catch (error) {
			if (statusOf(error) !== 404) throw error;
		}
		try {
			await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path, message, sha, content: btoa(unescape(encodeURIComponent(body))) });
			return;
		} catch (error) {
			if (attempt >= 5 || (statusOf(error) !== 404 && statusOf(error) !== 409)) throw new InitError("configure", `${repo} exists, but writing ${path} failed (${(error as Error).message}).`);
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
}

/** The audit report as it starts: the merger adds each finding and proved invariant, the chief keeps the header. */
function reportBody(repo: string, commit: string): string {
	return [
		`# Formal Mind audit: ${repo}`,
		"",
		`- Commit: ${commit ? `\`${commit}\`` : "the default branch's head when the audit started"}`,
		`- Started: ${new Date().toISOString().slice(0, 10)}`,
		"- Status: in progress",
		"",
		"Each finding has a severity, the affected code, a Foundry POC that fails on the audited commit, the fix, and the Lean 4 proof that holds after the fix.",
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
}
