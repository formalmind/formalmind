import { projectObject } from "@/lib/spend";
import { LEDGER_ISSUE, SWARM_REPO } from "@/lib/swarm";

/**
 * The formalmind GitHub App's webhook. A new or edited comment on the swarm's ledger issue is a cost line: it goes
 * straight to the Project Durable Object, so usage and today's budget update without polling GitHub.
 * Signed with GITHUB_WEBHOOK_SECRET (X-Hub-Signature-256); anything else is acknowledged and ignored.
 */
export async function POST(request: Request) {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) return Response.json({ error: "GITHUB_WEBHOOK_SECRET is not set." }, { status: 503 });
	const payload = await request.text();
	if (!(await verify(payload, request.headers.get("x-hub-signature-256"), secret))) return Response.json({ error: "Bad signature." }, { status: 401 });

	if (request.headers.get("x-github-event") !== "issue_comment") return Response.json({ ok: true, ignored: true });
	const event = JSON.parse(payload) as {
		action: string;
		repository: { full_name: string };
		issue: { number: number };
		comment: { body: string; created_at: string; updated_at: string; html_url: string };
	};
	if (event.action === "deleted" || event.repository.full_name !== SWARM_REPO || event.issue.number !== LEDGER_ISSUE) {
		return Response.json({ ok: true, ignored: true });
	}
	const added = (await projectObject()?.addComments([event.comment])) ?? 0;
	return Response.json({ ok: true, added });
}

async function verify(payload: string, header: string | null, secret: string) {
	if (!header?.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
	const expected = `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	if (expected.length !== header.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
	return diff === 0;
}
