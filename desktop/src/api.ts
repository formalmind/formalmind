import { invoke } from "@tauri-apps/api/core";

/**
 * Where the app talks to: formal.team unless set otherwise (a local `wrangler dev` on :8787 while developing).
 * Set it with VITE_FORMALMIND_API at build time, or from the sign-in screen (kept in localStorage).
 */
export const DEFAULT_API = import.meta.env.VITE_FORMALMIND_API ?? "https://formal.team";

export function apiBase(): string {
	try {
		return localStorage.getItem("fm:api-base") || DEFAULT_API;
	} catch {
		return DEFAULT_API;
	}
}

export function setApiBase(url: string) {
	const clean = url.trim().replace(/\/+$/, "");
	if (clean && clean !== DEFAULT_API) localStorage.setItem("fm:api-base", clean);
	else localStorage.removeItem("fm:api-base");
}

/** The desktop session token, held in memory; the OS keychain (Rust side) is where it lives between launches. */
let token: string | null = null;

export const loadToken = async () => (token = await invoke<string | null>("token_get"));
export async function saveToken(next: string) {
	await invoke("token_set", { token: next });
	token = next;
}
export async function clearToken() {
	const old = token;
	token = null;
	await invoke("token_clear");
	if (old) await rawFetch(`${apiBase()}/api/desktop/token`, { method: "DELETE", headers: { Authorization: `Bearer ${old}` } }).catch(() => {});
}

const rawFetch = window.fetch.bind(window);

/**
 * The shared components call `fetch("/api/…")` as on the web. Here those go to the API base with the token as a
 * bearer header (the Worker allows the app's origin through CORS; no cookies are involved).
 */
window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (!url.startsWith("/api/")) return rawFetch(input, init);
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const request = input instanceof Request ? new Request(`${apiBase()}${url}`, input) : `${apiBase()}${url}`;
	return rawFetch(request, { ...init, headers });
}, { preconnect: window.fetch.preconnect });

/** Trades the one-time code from the browser for a desktop token. */
export async function exchangeCode(code: string) {
	const res = await rawFetch(`${apiBase()}/api/desktop/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
	if (!res.ok || !body.token) throw new Error(body.error ?? `Sign-in failed (${res.status}).`);
	await saveToken(body.token);
}
