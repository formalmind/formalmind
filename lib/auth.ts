import { cookie, currentRequest, readCookie } from "@/worker/context";
import { kv } from "@/lib/kv";
import type { SessionData } from "@/lib/session";

/**
 * Sign in with GitHub, run by the Worker itself: the formalmind GitHub App's user authorization at
 * /auth/login → /login/callback, users in D1, sessions in KV behind an httpOnly cookie. The App's user token
 * stays on the Worker (refreshed when it expires) for the things done as the signed-in person.
 */

const SESSION_COOKIE = "fm_session";
const TX_COOKIE = "fm_auth_tx";
const SESSION_TTL = 30 * 24 * 3600;
/** Fallback client id (the formalmind App); wrangler.jsonc sets GITHUB_CLIENT_ID to the sign-in OAuth App. Its secret is GITHUB_CLIENT_SECRET. */
const DEFAULT_CLIENT_ID = "Iv23liDOGcOZlHPdp9Jf";
/** Where GitHub sends people back; it must be one of the App's callback URLs. */
const CALLBACK_PATH = "/login/callback";
/** Sign-in runs on this origin, so its callback URL is the only one the App needs. Other domains hand off to it. */
const AUTH_ORIGIN = "https://formal.team";

const env = (name: string) => (process.env[name] as string | undefined) ?? "";
const clientId = () => env("GITHUB_CLIENT_ID") || DEFAULT_CLIENT_ID;

/** Local `wrangler dev` without APP_BASE_URL: every request gets a stub session so the UI can be viewed. */
export const isDevPreview = !env("APP_BASE_URL");

const devSession: SessionData = {
	user: { sub: "dev|preview", name: "Dev Preview", nickname: "dev-preview", email: "dev@localhost" },
	tokenSet: { accessToken: "", expiresAt: Number.MAX_SAFE_INTEGER },
};

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

type GitHubTokens = { access_token: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function githubToken(body: Record<string, string>): Promise<GitHubTokens> {
	const secret = env("GITHUB_CLIENT_SECRET");
	if (!secret) throw new Error("Sign-in isn't configured: the GITHUB_CLIENT_SECRET Worker secret is missing.");
	const res = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "formalmind" },
		body: JSON.stringify({ client_id: clientId(), client_secret: secret, ...body }),
	});
	const json = (await res.json()) as GitHubTokens;
	// GitHub answers 200 with an error field when the code or credentials are wrong.
	if (!res.ok || json.error || !json.access_token) throw new Error(json.error_description ?? json.error ?? `GitHub token request failed (${res.status}).`);
	return json;
}

const tokenSetFrom = (t: GitHubTokens): SessionData["tokenSet"] => ({
	accessToken: t.access_token,
	refreshToken: t.refresh_token,
	// Without expiring user tokens enabled on the App, GitHub's token doesn't expire.
	expiresAt: t.expires_in ? Math.floor(Date.now() / 1000) + Number(t.expires_in) : Number.MAX_SAFE_INTEGER,
});

async function github<T>(path: string, token: string): Promise<T> {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "formalmind" },
	});
	if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
	return res.json() as Promise<T>;
}

type D1 = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };

/** Records the user in D1 (created once, refreshed on every sign-in). */
async function saveUser(user: SessionData["user"] & { githubId: number; login: string }) {
	const db = currentRequest().env.DB as D1 | undefined;
	if (!db) throw new Error("The DB (D1) binding is missing; see wrangler.jsonc.");
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO users (sub, github_id, login, name, email, avatar_url, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
			 ON CONFLICT(sub) DO UPDATE SET login = ?3, name = ?4, email = ?5, avatar_url = ?6, last_login_at = ?7`,
		)
		.bind(user.sub, user.githubId, user.login, user.name ?? null, user.email ?? null, user.picture ?? null, now)
		.run();
}

async function getSession(): Promise<SessionData | null> {
	if (isDevPreview) return devSession;
	const id = readCookie(SESSION_COOKIE);
	if (!id) return null;
	const raw = await (await kv()).get(`session:${id}`);
	return raw ? (JSON.parse(raw) as SessionData) : null;
}

/** The signed-in person's GitHub token (from the formalmind App), refreshed when it has expired. */
async function getGitHubToken(): Promise<string> {
	const id = readCookie(SESSION_COOKIE);
	const session = await getSession();
	if (!session?.tokenSet.accessToken) throw new Error("Not signed in with GitHub; sign in again.");
	if (session.tokenSet.expiresAt - 60 > Date.now() / 1000) return session.tokenSet.accessToken;
	if (!session.tokenSet.refreshToken || !id) throw new Error("The GitHub sign-in expired; sign in again.");
	const tokens = await githubToken({ grant_type: "refresh_token", refresh_token: session.tokenSet.refreshToken });
	const next: SessionData = { ...session, tokenSet: tokenSetFrom(tokens) };
	await (await kv()).put(`session:${id}`, JSON.stringify(next), { expirationTtl: SESSION_TTL });
	return next.tokenSet.accessToken;
}

export const auth = { getSession, getGitHubToken };

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

/** /auth/login, /login/callback (and /auth/callback) and /auth/logout. */
export async function handleAuth(path: string): Promise<Response> {
	const url = new URL(currentRequest().request.url);
	const safeReturn = (to: string | null) => (to && to.startsWith("/") && !to.startsWith("//") ? to : "/");

	if (isDevPreview) return redirect(path === "/auth/logout" ? "/welcome" : safeReturn(url.searchParams.get("returnTo")));

	if (path === "/auth/login") {
		// Only formal.team's callback is registered, so sign-in from another domain continues there.
		if (url.origin !== AUTH_ORIGIN) return redirect(`${AUTH_ORIGIN}/auth/login?returnTo=${encodeURIComponent(safeReturn(url.searchParams.get("returnTo")))}`);
		const state = randomId(16);
		const tx = JSON.stringify({ state, returnTo: safeReturn(url.searchParams.get("returnTo")) });
		const authorize = new URL("https://github.com/login/oauth/authorize");
		authorize.search = new URLSearchParams({ client_id: clientId(), redirect_uri: `${AUTH_ORIGIN}${CALLBACK_PATH}`, scope: "read:user user:email", state }).toString();
		return redirect(authorize.toString(), [cookie(TX_COOKIE, tx, { maxAge: 600 })]);
	}

	if (path === CALLBACK_PATH || path === "/auth/callback") {
		const tx = JSON.parse(readCookie(TX_COOKIE) ?? "null") as { state: string; returnTo: string } | null;
		const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
		if (failure) return authError(failure);
		const code = url.searchParams.get("code");
		if (!tx || !code || url.searchParams.get("state") !== tx.state) return redirect("/auth/login");
		try {
			const tokens = await githubToken({ code, redirect_uri: `${AUTH_ORIGIN}${CALLBACK_PATH}` });
			const profile = await github<{ id: number; login: string; name: string | null; email: string | null; avatar_url: string }>("/user", tokens.access_token);
			// "github|<id>" is the sub Auth0 gave GitHub sign-ins, so projects, onboarding and credits saved under it carry over.
			const user = { sub: `github|${profile.id}`, nickname: profile.login, name: profile.name ?? profile.login, email: profile.email ?? undefined, picture: profile.avatar_url };
			await saveUser({ ...user, githubId: profile.id, login: profile.login });
			const id = randomId();
			const session: SessionData = { user, tokenSet: tokenSetFrom(tokens) };
			await (await kv()).put(`session:${id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
			return redirect(tx.returnTo, [cookie(SESSION_COOKIE, id, { maxAge: SESSION_TTL }), cookie(TX_COOKIE, "", { maxAge: 0 })]);
		} catch (error) {
			return authError(error instanceof Error ? error.message : "GitHub sign-in failed.");
		}
	}

	if (path === "/auth/logout") {
		const id = readCookie(SESSION_COOKIE);
		if (id) await (await kv()).delete(`session:${id}`);
		return redirect("/welcome", [cookie(SESSION_COOKIE, "", { maxAge: 0 })]);
	}

	return new Response("Not found", { status: 404 });
}
