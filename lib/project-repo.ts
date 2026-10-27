import { Octokit } from "@octokit/rest";
import { parseRepo } from "@/lib/plan";
import { listProjects } from "@/lib/projects";
import { installationFor } from "@/lib/proofs-repo";

/**
 * One of an account's projects, read from GitHub at one commit: through the formalmind GitHub App when it is
 * installed on the owner (private repositories too), else as a public repository (with GITHUB_TOKEN when the Worker
 * has one). Every read is pinned to the commit the ref resolved to, so a tree and the files read from it agree.
 */
export type ProjectRepo = {
	repo: string;
	/** The ref asked for, or the default branch. */
	ref: string;
	commit: string;
	via: "app" | "public";
	/** Every file path at the commit, and whether GitHub cut the listing short. */
	tree(): Promise<{ files: string[]; truncated: boolean }>;
	/** A file's text, or null when it isn't there. */
	file(path: string): Promise<string | null>;
};

const statusOf = (error: unknown) => (error as { status?: number }).status;

async function publicOctokit(): Promise<Octokit> {
	return new Octokit({ auth: (process.env.GITHUB_TOKEN as string | undefined) || undefined, userAgent: "formalmind" });
}

/** The project `repoInput` of the account `sub` at `ref` (the default branch when absent); an error the caller can show otherwise. */
export async function openProject(sub: string, repoInput: string, ref?: string): Promise<ProjectRepo | { error: string }> {
	const repo = parseRepo(repoInput);
	if (!repo) return { error: "repo must be owner/name or a github.com URL." };
	const project = (await listProjects(sub)).find((p) => p.repo.toLowerCase() === repo.toLowerCase());
	if (!project) return { error: `${repo} isn't one of your projects; add it with add_project (or plan_repository) first.` };
	const [owner, name] = project.repo.split("/");

	let octokit: Octokit;
	let via: ProjectRepo["via"] = "app";
	try {
		octokit = await installationFor(owner, name);
	} catch {
		octokit = await publicOctokit();
		via = "public";
	}

	let branch = ref?.trim();
	let commit: string;
	try {
		if (!branch) branch = (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name })).data.default_branch;
		const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo: name, ref: branch });
		commit = data.sha;
	} catch (error) {
		const status = statusOf(error);
		if (status === 404 || status === 422) {
			return { error: ref ? `${project.repo} has no ref ${ref}.` : via === "public" ? `${project.repo} is private or gone, and the formalmind GitHub App isn't installed on ${owner}.` : `${project.repo} isn't on GitHub.` };
		}
		if (status === 403 || status === 429) return { error: `GitHub's rate limit stopped the read of ${project.repo}; try again shortly, or install the formalmind GitHub App on ${owner}.` };
		throw error;
	}

	return {
		repo: project.repo,
		ref: branch,
		commit,
		via,
		async tree() {
			const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: name, tree_sha: commit, recursive: "1" });
			return { files: data.tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path as string), truncated: data.truncated };
		},
		async file(path: string) {
			try {
				const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path, ref: commit, mediaType: { format: "raw" } });
				return typeof data === "string" ? data : null;
			} catch (error) {
				if (statusOf(error) === 404) return null;
				throw error;
			}
		},
	};
}
