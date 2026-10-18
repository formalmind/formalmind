import { auth, newCode } from "@/lib/auth";
import { kv } from "@/lib/kv";

/** One-time codes live a minute: long enough to hop from the browser to the app, too short to be worth stealing. */
export const CODE_TTL = 60;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (code: string) => {
	const link = `formalmind://auth?code=${code}`;
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in · Formal Mind</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=Instrument+Serif&display=swap">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at top,#151a24 0%,#08090b 55%);color:#fff;font:15px/1.5 Inter,system-ui,sans-serif">
<main style="max-width:440px;padding:24px;text-align:center">
<div style="margin:0 auto 28px;width:48px;height:48px;border-radius:999px;display:grid;place-items:center;background:rgba(52,211,153,.15);color:#6ee7b7;font-size:22px">✓</div>
<h1 style="margin:0;font:400 44px/1.05 'Instrument Serif',Georgia,serif;letter-spacing:-.01em"><span style="color:rgba(255,255,255,.45)">You're signed in.</span><br>Back to the app.</h1>
<p style="margin:24px 0 0;color:rgba(255,255,255,.5)">Formal Mind picks this up by itself. You can close this tab.</p>
<p style="margin:28px 0 0"><a href="${escape(link)}" style="display:inline-block;padding:10px 20px;border-radius:12px;background:#fff;color:#0a0a0a;text-decoration:none;font-weight:500">Open Formal Mind</a></p>
<p style="margin:28px 0 0;color:rgba(255,255,255,.35);font-size:12px">Still stuck? Paste this code in the app within a minute:<br><code style="user-select:all;color:rgba(255,255,255,.6)">${escape(code)}</code></p>
</main><script>location.href=${JSON.stringify(link)}</script></body>`;
};

/**
 * Desktop sign-in, in the system browser: signs in as on the web if needed, then hands the app a one-time code.
 * Three ways back, any of which works: the formalmind://auth?code=… deep link, the app polling with the `poll` id it
 * opened this page with (deep links don't register in `tauri dev` on macOS), or the code pasted by hand. Only the
 * code goes in a URL; the app trades it for a token at /api/desktop/token.
 */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const poll = url.searchParams.get("poll");
	const validPoll = poll && /^[\w-]{24,64}$/.test(poll) ? poll : null;
	const session = await auth.getSession();
	if (!session) {
		const back = `/api/desktop/authorize${validPoll ? `?poll=${validPoll}` : ""}`;
		return new Response(null, { status: 302, headers: { Location: `/auth/login?returnTo=${encodeURIComponent(back)}` } });
	}
	const code = newCode();
	const store = await kv();
	await store.put(`desktop-code:${code}`, JSON.stringify(session), { expirationTtl: CODE_TTL });
	if (validPoll) await store.put(`desktop-poll:${validPoll}`, code, { expirationTtl: CODE_TTL });
	return new Response(page(code), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
