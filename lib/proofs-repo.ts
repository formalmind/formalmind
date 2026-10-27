import type { Octokit } from "@octokit/rest";
import { getAppOctokit, getInstallationOctokit } from "@/lib/octokit";

const statusOf = (error: unknown) => (error as { status?: number }).status;

/** The formalmind GitHub App's client for a repository, through its installation on the owner. */
export async function installationFor(owner: string, repo: string): Promise<Octokit> {
	try {
		const { data } = await getAppOctokit().request("GET /repos/{owner}/{repo}/installation", { owner, repo });
		return getInstallationOctokit(data.id);
	} catch (error) {
		if (statusOf(error) === 404) throw new Error(`The formalmind GitHub App isn't installed on ${owner}/${repo}. Install it on ${owner}, then try again.`);
		throw error;
	}
}
