import { Octokit } from "@octokit/rest";
import { auth0, isDevPreview } from "@/lib/auth0";

export async function GET() {
	const session = await auth0.getSession();
	if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
	if (isDevPreview) return Response.json({ repos: [], githubConnected: false, devPreview: true });

	try {
		const { token } = await auth0.getAccessTokenForConnection({ connection: "github" });
		const octokit = new Octokit({ auth: token });
		const data = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
			per_page: 100,
			sort: "updated",
			direction: "desc",
		});

		return Response.json({
			repos: data.map((repo) => ({
				id: repo.id,
				name: repo.name,
				owner: repo.owner.login,
				fullName: repo.full_name,
				private: repo.private,
			})),
			githubConnected: true,
			devPreview: false,
		});
	} catch (error) {
		console.error("Failed to list connected GitHub repositories:", error);
		return Response.json({ repos: [], githubConnected: false });
	}
}
