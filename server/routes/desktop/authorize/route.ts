import { auth, newCode } from "@/lib/auth";
import { kv } from "@/lib/kv";

/** One-time codes live a minute: long enough to hop from the browser to the app, too short to be worth stealing. */
export const CODE_TTL = 60;

const page = (code: string) => {
	const link = `formalmind://auth?code=${code}`;
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Formal Mind</title>
<body style="font:15px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0a0a0a">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px">You're signed in</h1>
<p style="color:#737373">Head back to the Formal Mind app. If it didn't open, use the button.</p>
<p><a href="${link}" style="display:inline-block;padding:8px 16px;border-radius:999px;background:#0a0a0a;color:#fff;text-decoration:none">Open the app</a></p>
<p style="color:#a3a3a3;font-size:13px">Or paste this code in the app within a minute:<br><code style="user-select:all">${code}</code></p></main>
<script>location.href=${JSON.stringify(link)}</script></body>`;
};

/**
 * Desktop sign-in, in the system browser: signs in as on the web if needed, then hands the app a one-time code via
 * formalmind://auth?code=…. Only the code goes in the URL; the app trades it for a token at /api/desktop/token.
 */
export async function GET() {
	const session = await auth.getSession();
	if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/login?returnTo=${encodeURIComponent("/api/desktop/authorize")}` } });
	const code = newCode();
	await (await kv()).put(`desktop-code:${code}`, JSON.stringify(session), { expirationTtl: CODE_TTL });
	return new Response(page(code), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
