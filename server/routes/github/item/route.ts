import { github, toItem, type GitHubIssue } from "@/lib/swarm";

const REPO = /^[\w.-]+\/[\w.-]+$/;

type GitHubRepo = {
	full_name: string; description: string | null; html_url: string; stargazers_count: number; forks_count: number;
	open_issues_count: number; language: string | null; pushed_at: string; private: boolean;
	owner: { login: string; avatar_url: string; html_url: string };
};

/** One issue or PR as a board item (with number=), or the repository itself, for hover cards. */
export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const repo = params.get("repo") ?? "";
	if (REPO.test(repo) && !params.has("number")) {
		try {
			const r = await github<GitHubRepo>("", repo);
			return Response.json(
				{ name: r.full_name, description: r.description, url: r.html_url, stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, language: r.language, pushedAt: r.pushed_at, private: r.private, owner: { login: r.owner.login, avatar: r.owner.avatar_url, url: r.owner.html_url } },
				{ headers: { "Cache-Control": "private, max-age=300" } },
			);
		} catch (err) {
			return Response.json({ error: err instanceof Error ? err.message : "Not found." }, { status: 404 });
		}
	}
	const number = Number(params.get("number"));
	if (!REPO.test(repo) || !Number.isInteger(number) || number < 1) return Response.json({ error: "Give repo=owner/name and number." }, { status: 400 });
	try {
		const issue = await github<GitHubIssue & { state: "open" | "closed" }>(`/issues/${number}`, repo);
		return Response.json({ ...toItem(repo, issue), state: issue.state }, { headers: { "Cache-Control": "private, max-age=60" } });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Not found." }, { status: 404 });
	}
}
