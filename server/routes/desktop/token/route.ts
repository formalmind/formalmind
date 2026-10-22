import { createDesktopSession, deleteDesktopSession } from "@/lib/auth";
import { kv } from "@/lib/kv";
import type { SessionData } from "@/lib/session";

/** Compares by digest, so the time taken says nothing about how much of a guess was right. */
async function sameText(a: string, b: string) {
	const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
	const [x, y] = await Promise.all([digest(a), digest(b)]);
	return x.every((v, i) => v === y[i]);
}

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
	// App Review signs in with a code typed into "Have a code?": the APP_REVIEW_CODE Worker secret, given to Apple in
	// App Store Connect. It opens a demo account with no GitHub token: public repositories, chat, no Mac.
	const review = process.env.APP_REVIEW_CODE as string | undefined;
	if (review && review.length >= 16 && (await sameText(code, review))) {
		const session: SessionData = { user: { sub: "review|app-store", name: "App Review", nickname: "app-review" }, tokenSet: { accessToken: "", expiresAt: Number.MAX_SAFE_INTEGER } };
		const token = await createDesktopSession(session);
		return Response.json({ token, user: session.user }, { headers: { "Cache-Control": "no-store" } });
	}
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
