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

/** A fresh id the app opens the browser with, so it can ask for its sign-in without a deep link. */
export const newPollId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Asks every 2 s whether the browser finished signing in for `poll`; resolves once a token is saved. */
export async function pollForToken(poll: string, signal: AbortSignal) {
	const deadline = Date.now() + 10 * 60_000;
	while (!signal.aborted && Date.now() < deadline) {
		const res = await rawFetch(`${apiBase()}/api/desktop/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ poll }),
			signal,
		}).catch(() => null);
		if (res?.status === 200) {
			const body = (await res.json()) as { token: string };
			await saveToken(body.token);
			return true;
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

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

/**
 * The settings the pages keep (`fm:` keys in localStorage), pushed to the backend's (~/.formalmind/config.json), which
 * decides with them whatever started the work: the folder page, an agent through the MCP. Any change to an
 * `fm:` key pushes them again.
 */
export async function syncSettings() {
	const get = (k: string) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};
	const budgets: Record<string, number> = {};
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			const usd = k?.startsWith("fm:budget:") ? Number(get(k)) : NaN;
			if (k && usd > 0) budgets[k.slice("fm:budget:".length)] = usd;
		}
	} catch {
		// No storage (a private window): the backend keeps what it had.
	}
	await invoke("settings_set", {
		patch: { api_base: apiBase(), provider: get("fm:provider"), model: get("fm:model"), effort: get("fm:effort") || null, relay: get("fm:relay") !== "0", budgets },
	}).catch(() => {});
}

const changed = (storage: Storage, key: string) => {
	if (storage === localStorage && key.startsWith("fm:")) void syncSettings();
};
const setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
	setItem.call(this, key, value);
	changed(this, key);
};
const removeItem = Storage.prototype.removeItem;
Storage.prototype.removeItem = function (this: Storage, key: string) {
	removeItem.call(this, key);
	changed(this, key);
};

