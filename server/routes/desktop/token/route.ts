import { createDesktopSession, deleteDesktopSession } from "@/lib/auth";
import { kv } from "@/lib/kv";
import type { SessionData } from "@/lib/session";

/** Trades a one-time code from /api/desktop/authorize for a desktop session token. The code works once. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { code?: string; poll?: string };
	const store = await kv();
	let code = body.code;
	// The app polls with the id it opened the browser with; 202 until the browser side has finished.
	if (!code && body.poll && /^[\w-]{24,64}$/.test(body.poll)) {
		code = (await store.get(`desktop-poll:${body.poll}`)) ?? undefined;
		if (!code) return Response.json({ pending: true }, { status: 202 });
		await store.delete(`desktop-poll:${body.poll}`);
	}
	if (!code || !/^[\w-]{16,64}$/.test(code)) return Response.json({ error: "Missing code." }, { status: 400 });
	const raw = await store.get(`desktop-code:${code}`);
	if (!raw) return Response.json({ error: "That code expired or was already used. Sign in again." }, { status: 400 });
	await store.delete(`desktop-code:${code}`);
	const session = JSON.parse(raw) as SessionData;
	const token = await createDesktopSession(session);
	return Response.json({ token, user: session.user }, { headers: { "Cache-Control": "no-store" } });
}

/** Signs the desktop app out: the token stops working. */
export async function DELETE(request: Request) {
	const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
	if (token) await deleteDesktopSession(token);
	return new Response(null, { status: 204 });
}
