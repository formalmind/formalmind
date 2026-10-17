import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import { NextResponse } from "next/server";

const isAuthConfigured = Boolean(
	process.env.AUTH0_DOMAIN &&
	process.env.AUTH0_CLIENT_ID &&
	process.env.AUTH0_SECRET &&
	process.env.APP_BASE_URL,
);

/**
 * Dev preview: when Auth0 isn't configured outside production, every page
 * renders with a stub session so the UI can be viewed without credentials.
 * Never active in production.
 */
export const isDevPreview = !isAuthConfigured && process.env.NODE_ENV !== "production";

const devSession: SessionData = {
	user: {
		sub: "dev|preview",
		name: "Dev Preview",
		nickname: "dev-preview",
		email: "dev@localhost",
	},
	tokenSet: { accessToken: "", expiresAt: Number.MAX_SAFE_INTEGER },
	internal: { sid: "dev-preview", createdAt: Date.now() },
};

function makeDevClient(): Auth0Client {
	console.warn("[auth0] AUTH0_* env vars missing; running in dev preview with a stub session. Copy example.env.local to .env.local to use real auth.");
	const stub = {
		getSession: async () => devSession,
		middleware: async () => NextResponse.next(),
	};
	return stub as unknown as Auth0Client;
}

export const auth0: Auth0Client = isDevPreview ? makeDevClient() : new Auth0Client();
