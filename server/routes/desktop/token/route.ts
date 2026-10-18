import { createDesktopSession, deleteDesktopSession } from "@/lib/auth";
import { kv } from "@/lib/kv";
import type { SessionData } from "@/lib/session";

/** Trades a one-time code from /api/desktop/authorize for a desktop session token. The code works once. */
export async function POST(request: Request) {
	const { code } = (await request.json().catch(() => ({}))) as { code?: string };
	if (!code || !/^[\w-]{16,64}$/.test(code)) return Response.json({ error: "Missing code." }, { status: 400 });
	const store = await kv();
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
