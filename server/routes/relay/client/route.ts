import { auth } from "@/lib/auth";
import { parseCommand, relayObject } from "@/lib/relay";

/**
 * A client's side of the swarm relay (lib/relay.ts), e.g. the phone. GET ?after=N&wait=1 reads the Mac's events
 * after N (the newest ones when N is 0), its folders and sessions, and when it was last online; POST sends it a command
 * (say, start, stop, history).
 */
export async function GET(request: Request) {
	const session = await auth.getSession();
	const relay = session && relayObject(session.user.sub);
	if (!relay) return Response.json({ error: "The relay isn't available." }, { status: 503 });
	const url = new URL(request.url);
	const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
	return Response.json(await relay.read(after, url.searchParams.get("wait") === "1"), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const session = await auth.getSession();
	const relay = session && relayObject(session.user.sub);
	if (!relay) return Response.json({ error: "The relay isn't available." }, { status: 503 });
	const command = parseCommand(await request.json().catch(() => null));
	if (!command) return Response.json({ error: "Not a command." }, { status: 400 });
	return Response.json({ seq: await relay.send(command) });
}
