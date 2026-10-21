import { parseRepo } from "@/lib/plan";
import { projectRepo } from "@/server/routes/projects/tree/route";

/**
 * A read-only git smart-HTTP proxy for one of your projects, so the browser can clone it (isomorphic-git, kept in
 * IndexedDB) instead of asking the GitHub API for every listing and file. GitHub's git endpoints send no CORS headers,
 * so the browser can't reach them itself. Only upload-pack (fetching) passes: nothing can be pushed through here.
 *
 *   GET  /api/projects/git?repo=owner/name&op=info/refs   (the ref advertisement)
 *   POST /api/projects/git?repo=owner/name&op=git-upload-pack
 */
async function proxy(request: Request) {
	const url = new URL(request.url);
	const op = url.searchParams.get("op");
	if (op !== "info/refs" && op !== "git-upload-pack") return Response.json({ error: "Only fetching is allowed." }, { status: 400 });
	if (op === "info/refs" && url.searchParams.get("service") !== "git-upload-pack") return Response.json({ error: "Only fetching is allowed." }, { status: 400 });
	const t = await projectRepo(url.searchParams.get("repo"));
	let owner: string, name: string, token: string | null = null;
	if ("error" in t) {
		// One of your projects the App isn't installed on: fetched without a token, which public repositories allow.
		const repo = (t.error as Response).status === 409 ? parseRepo(url.searchParams.get("repo") ?? "") : null;
		if (!repo) return t.error as Response;
		[owner, name] = repo.split("/");
	} else {
		({ owner, name } = t);
		// The App's installation token reads private repositories too; git takes it as the password for x-access-token.
		({ token } = (await t.octokit.auth({ type: "installation" })) as { token: string });
	}
	const headers = new Headers({ "User-Agent": "git/formal.team" });
	if (token) headers.set("Authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
	for (const h of ["content-type", "accept", "git-protocol"]) {
		const v = request.headers.get(h);
		if (v) headers.set(h, v);
	}
	const target = `https://github.com/${owner}/${name}.git/${op}${op === "info/refs" ? "?service=git-upload-pack" : ""}`;
	const res = await fetch(target, { method: request.method, headers, body: request.method === "POST" ? request.body : undefined });
	// Streamed straight through: a pack can be large, and nothing here needs to read it.
	return new Response(res.body, {
		status: res.status,
		headers: { "Content-Type": res.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "no-store, no-transform", "Content-Encoding": "identity" },
	});
}

export const GET = proxy;
export const POST = proxy;
