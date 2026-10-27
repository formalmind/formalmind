import { auth } from "@/lib/auth";
import { relayObject, type RelayPublish } from "@/lib/relay";

/**
 * The Mac app's side of the swarm relay (lib/relay.ts). GET ?after=N&wait=1 waits for commands after N (and
 * acknowledges those up to it); POST publishes the app's folders and sessions, new events, a session's history, or
 * replies to calls.
 */
export async function GET(request: Request) {
	const session = await auth.getSession();
	const relay = session && relayObject(session.user.sub);
	if (!relay) return Response.json({ error: "The relay isn't available." }, { status: 503 });
	const url = new URL(request.url);
	const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
	return Response.json(await relay.commands(after, url.searchParams.get("wait") === "1"), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const session = await auth.getSession();
	const relay = session && relayObject(session.user.sub);
	if (!relay) return Response.json({ error: "The relay isn't available." }, { status: 503 });
	const body = (await request.json().catch(() => null)) as RelayPublish | null;
	if (!body || typeof body !== "object") return Response.json({ error: "Expected JSON." }, { status: 400 });
	await relay.publish({
		...(body.state && Array.isArray(body.state.folders) ? { state: body.state } : {}),
		...(Array.isArray(body.events) ? { events: body.events.slice(0, 500) } : {}),
		...(body.history && Array.isArray(body.history.events) ? { history: body.history } : {}),
		...(Array.isArray(body.replies) ? { replies: body.replies.slice(0, 50) } : {}),
	});
	return new Response(null, { status: 204 });
}
