import { cookie, currentRequest, readCookie } from "@/worker/context";
import { kv } from "@/lib/kv";
import type { SessionData } from "@/lib/session";

/**
 * Auth0 on the Worker: the authorization-code flow with PKCE at /auth/login → /auth/callback, sessions in KV
 * behind an httpOnly cookie, and the GitHub token-vault exchange. Same routes, secrets and callback URL the
 * Next.js SDK used, so the Auth0 application needs no changes.
 */

const SESSION_COOKIE = "fm_session";
const TX_COOKIE = "fm_auth_tx";
const SESSION_TTL = 7 * 24 * 3600;
const SCOPE = "openid profile email offline_access";
/** The domains Formal Mind is served on; each must be in the Auth0 app's allowed callback and logout URLs. */
const SITE_ORIGINS = ["https://formal.team", "https://www.formal.team", "https://formalmind.asyncswap.workers.dev"];

const env = (name: string) => (process.env[name] as string | undefined) ?? "";
const isAuthConfigured = () => Boolean(env("AUTH0_DOMAIN") && env("AUTH0_CLIENT_ID") && env("AUTH0_CLIENT_SECRET") && env("APP_BASE_URL"));

/**
 * Dev preview: when Auth0 isn't configured (local `wrangler dev` without secrets), every request gets a stub
 * session so the UI can be viewed. Production always has the secrets.
 */
export const isDevPreview = !isAuthConfigured();

const devSession: SessionData = {
	user: { sub: "dev|preview", name: "Dev Preview", nickname: "dev-preview", email: "dev@localhost" },
	tokenSet: { accessToken: "", expiresAt: Number.MAX_SAFE_INTEGER },
};

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

function decodeJwt(token: string): Record<string, unknown> {
	const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
}

async function tokenRequest(body: Record<string, string>) {
	const res = await fetch(`https://${env("AUTH0_DOMAIN")}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: env("AUTH0_CLIENT_ID"), client_secret: env("AUTH0_CLIENT_SECRET"), ...body }),
	});
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) throw new Error(`Auth0 token request failed: ${json.error ?? res.status} ${json.error_description ?? ""}`);
	return json;
}

async function getSession(): Promise<SessionData | null> {
	if (isDevPreview) return devSession;
	const id = readCookie(SESSION_COOKIE);
	if (!id) return null;
	const raw = await (await kv()).get(`session:${id}`);
	return raw ? (JSON.parse(raw) as SessionData) : null;
}

/** A GitHub access token for the signed-in user, from Auth0's token vault (the "github" connection). */
async function getAccessTokenForConnection({ connection }: { connection: string }): Promise<{ token: string }> {
	const session = await getSession();
	const refreshToken = session?.tokenSet.refreshToken;
	if (!refreshToken) throw new Error("No refresh token in the session; sign in again.");
	const json = await tokenRequest({
		grant_type: "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
		subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
		subject_token: refreshToken,
		requested_token_type: "http://auth0.com/oauth/token-type/federated-connection-access-token",
		connection,
	});
	return { token: json.access_token as string };
}

export const auth0 = { getSession, getAccessTokenForConnection };

/** A small page saying why sign-in failed, with a way to try again. */
function authError(reason: string) {
	const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
	console.error("[auth] sign-in failed:", reason);
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in failed · Formal Mind</title>
<body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0c0a09">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px">Sign-in didn't go through</h1>
<p style="color:#78716c">${escape(reason)}</p>
<p><a href="/auth/login" style="display:inline-block;margin-top:8px;padding:8px 16px;border-radius:999px;background:#0c0a09;color:#fff;text-decoration:none">Try again</a>
<a href="/welcome" style="margin-left:12px;color:#78716c">Back home</a></p></main></body>`;
	return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(TX_COOKIE, "", { maxAge: 0 }) } });
}

const redirect = (location: string, cookies: string[] = []) => {
	const headers = new Headers({ Location: location });
	for (const c of cookies) headers.append("Set-Cookie", c);
	return new Response(null, { status: 302, headers });
};

/** /auth/login, /auth/callback and /auth/logout. */
export async function handleAuth(path: string): Promise<Response> {
	const url = new URL(currentRequest().request.url);
	// Sign-in returns to the site it started on, so the session cookie lands on that domain. Only the configured
	// base URL and the site's own domains qualify; anything else falls back to APP_BASE_URL.
	const configured = env("APP_BASE_URL").replace(/\/$/, "");
	const baseUrl = SITE_ORIGINS.includes(url.origin) || url.origin === configured ? url.origin : configured;
	const safeReturn = (to: string | null) => (to && to.startsWith("/") && !to.startsWith("//") ? to : "/");

	if (isDevPreview) return redirect(path === "/auth/logout" ? "/welcome" : safeReturn(url.searchParams.get("returnTo")));

	if (path === "/auth/login") {
		const verifier = randomId();
		const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const state = randomId(16);
		const tx = JSON.stringify({ state, verifier, returnTo: safeReturn(url.searchParams.get("returnTo")) });
		const authorize = new URL(`https://${env("AUTH0_DOMAIN")}/authorize`);
		authorize.search = new URLSearchParams({
			response_type: "code",
			client_id: env("AUTH0_CLIENT_ID"),
			redirect_uri: `${baseUrl}/auth/callback`,
			scope: SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		return redirect(authorize.toString(), [cookie(TX_COOKIE, tx, { maxAge: 600 })]);
	}

	if (path === "/auth/callback") {
		const tx = JSON.parse(readCookie(TX_COOKIE) ?? "null") as { state: string; verifier: string; returnTo: string } | null;
		// Auth0 sends failures back here too; show them instead of starting the login again (which loops).
		const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
		if (failure) return authError(failure);
		const code = url.searchParams.get("code");
		if (!tx || !code || url.searchParams.get("state") !== tx.state) return redirect("/auth/login");
		const tokens = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: tx.verifier, redirect_uri: `${baseUrl}/auth/callback` });
		// The ID token comes straight from Auth0's token endpoint over TLS, so its claims can be read as is.
		const claims = decodeJwt(tokens.id_token as string);
		const session: SessionData = {
			user: { ...claims, sub: claims.sub as string },
			tokenSet: {
				accessToken: tokens.access_token as string,
				refreshToken: tokens.refresh_token as string | undefined,
				idToken: tokens.id_token as string,
				expiresAt: Math.floor(Date.now() / 1000) + Number(tokens.expires_in ?? 0),
			},
		};
		const id = randomId();
		await (await kv()).put(`session:${id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
		return redirect(tx.returnTo, [cookie(SESSION_COOKIE, id, { maxAge: SESSION_TTL }), cookie(TX_COOKIE, "", { maxAge: 0 })]);
	}

	if (path === "/auth/logout") {
		const id = readCookie(SESSION_COOKIE);
		if (id) await (await kv()).delete(`session:${id}`);
		const logout = new URL(`https://${env("AUTH0_DOMAIN")}/v2/logout`);
		logout.search = new URLSearchParams({ client_id: env("AUTH0_CLIENT_ID"), returnTo: baseUrl }).toString();
		return redirect(logout.toString(), [cookie(SESSION_COOKIE, "", { maxAge: 0 })]);
	}

	return new Response("Not found", { status: 404 });
}
