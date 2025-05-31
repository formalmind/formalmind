import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

const appId = process.env.GITHUB_APP_ID!;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

export function getAppOctokit() {
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
