import { projectRepo } from "@/server/routes/projects/tree/route";

/** One file of a project, as text (default branch). */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const t = await projectRepo(url.searchParams.get("repo"));
	if ("error" in t) return t.error as Response;
	const path = url.searchParams.get("path") ?? "";
	if (!path || path.includes("..")) return Response.json({ error: "Which file?" }, { status: 400 });
	const { data } = await t.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner: t.owner, repo: t.name, path });
	if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return Response.json({ error: "Not a file." }, { status: 400 });
	const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
	return Response.json({ path, text: new TextDecoder().decode(bytes), url: data.html_url });
}
