import { auth0 } from "@/lib/auth0";
import { getAppOctokit } from "@/lib/octokit";
import { parseRepo } from "@/lib/plan";

/** Whether the formalmind GitHub App is installed with access to this repository. */
export async function GET(request: Request) {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const repo = parseRepo(new URL(request.url).searchParams.get("repo") ?? "");
	if (!repo) return Response.json({ error: "Which repository?" }, { status: 400 });
	const [owner, name] = repo.split("/");
	try {
		const { data } = await getAppOctokit().request("GET /repos/{owner}/{repo}/installation", { owner, repo: name });
		return Response.json({ installed: true, installationId: data.id, account: data.account && "login" in data.account ? data.account.login : owner });
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 404) return Response.json({ installed: false });
		console.error("[onboarding] install check failed:", error);
		return Response.json({ installed: false, error: "Couldn't check the installation just now." }, { status: 502 });
	}
}
