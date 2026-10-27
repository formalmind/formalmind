import { AsyncLocalStorage } from "node:async_hooks";
import type { KV } from "@/lib/kv";

export interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	FORMALMIND: KV;
	/** One Durable Object per project (worker/project-do.ts). */
	PROJECT?: { idFromName(name: string): unknown; get(id: unknown): unknown };
	/** One Durable Object per person: the swarm relay between the Mac app and the MCP (worker/relay-do.ts). */
	RELAY?: { idFromName(name: string): unknown; get(id: unknown): unknown };
	[secret: string]: unknown;
}

/** The request being served, so library code (sessions, KV) can reach it without threading it through. */
export interface RequestContext {
	request: Request;
	env: Env;
	waitUntil(promise: Promise<unknown>): void;
	/** Cookies to set on the response, collected while the request runs. */
	setCookies: string[];
	/** Who is calling, resolved once per request (lib/auth.ts getPrincipal). */
	principal?: Promise<unknown>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequest(): RequestContext {
	const ctx = requestContext.getStore();
	if (!ctx) throw new Error("No request in flight: this must run inside the Worker's request handler.");
	return ctx;
}

export function readCookie(name: string): string | null {
	const header = currentRequest().request.headers.get("cookie") ?? "";
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

export function cookie(name: string, value: string, options: { maxAge?: number; path?: string } = {}) {
	const secure = new URL(currentRequest().request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${encodeURIComponent(value)}; Path=${options.path ?? "/"}; HttpOnly; SameSite=Lax${secure}${options.maxAge !== undefined ? `; Max-Age=${options.maxAge}` : ""}`;
}
