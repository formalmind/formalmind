import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Read at call time, not import time: secrets are only present when a request runs
// (Cloudflare Workers), and a build without them must still succeed.
export function getAppOctokit() {
	const appId = process.env.GITHUB_APP_ID;
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
	if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId,
			privateKey,
		},
	});
	return octokit;
}

export async function findInstallationForUser(githubLogin: string): Promise<number | null> {
	const octokit = getAppOctokit()
	const { data: installations } = await octokit.request('GET /app/installations')
	const match = installations.find(inst => inst.account?.login === githubLogin)
	return match?.id ?? null
}
