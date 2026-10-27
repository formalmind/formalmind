/**
 * The OAuth 2.0 authorization server's tokens and records. The HTTP endpoints are in worker/oauth.ts; the resource
 * side (a bearer JWT becoming a session with scopes) is in lib/auth.ts, which calls `verifyAccessToken` from here.
 *
 * Access tokens are ES256 JWTs signed with the OAUTH_SIGNING_KEY Worker secret (a private JWK; `bun
 * scripts/oauth-signing-key.ts` prints a fresh one). Refresh tokens, authorization codes, registered clients and
 * revoked token ids live in the FORMALMIND KV namespace under `oauth:` keys.
 */
import { kv, getJSON, putJSON } from "@/lib/kv";
import { ORIGIN } from "@/worker/narrative";
import { currentRequest } from "@/worker/context";

/** What a token may do, named in the consent page and in RFC 8414 `scopes_supported`. */
export const SCOPES = {
	"swarm:read": "Read your projects (their files, audit reports, findings and Proofs coverage) and the swarm on your Mac",
	"swarm:write": "Drive your Mac's swarm: messages, Start, Stop and anything its folder page does",
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_LIST = Object.keys(SCOPES) as Scope[];
export const isScope = (s: string): s is Scope => s in SCOPES;

export const ACCESS_TOKEN_TTL = 3600;
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600;
export const CODE_TTL = 600;
const REFRESH_PREFIX = "fmr_";

/** Local `wrangler dev` without APP_BASE_URL (the same switch lib/auth.ts uses for its stub session). */
export const isDevPreview = () => !process.env.APP_BASE_URL;

/**
 * The issuer: https://formal.team in production. Under local preview it is the origin the request came in on, so a
 * client talking to http://localhost:8787 sees metadata, tokens and `iss` that agree with each other. (`wrangler dev`
 * rewrites the host to the first route, formal.team, unless started with `--host localhost:8787`; see README.md.)
 */
export function issuer(): string {
	return isDevPreview() ? new URL(currentRequest().request.url).origin : ORIGIN;
}

const encoder = new TextEncoder();
export const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const base64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const utf8 = (s: string) => base64url(encoder.encode(s));

export async function sha256(input: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/* ---------- Signing key ---------- */

type Keys = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey & { kid: string } };
let keys: Promise<Keys> | null = null;

async function loadKeys(): Promise<Keys> {
	const raw = process.env.OAUTH_SIGNING_KEY as string | undefined;
	let jwk: JsonWebKey & { kid?: string };
	if (raw) {
		jwk = JSON.parse(raw);
	} else if (isDevPreview()) {
		// Local preview without a key: a fresh one per Worker start, so tokens die with it. Never in production.
		console.warn("[oauth] OAUTH_SIGNING_KEY is not set; using an ephemeral signing key for this preview.");
		const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	} else {
		throw new Error("The OAUTH_SIGNING_KEY Worker secret is missing; see README.md (For agents).");
	}
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) throw new Error("OAUTH_SIGNING_KEY must be a private P-256 JWK.");
	const privateKey = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const pub: JsonWebKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
	const publicKey = await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
	// RFC 7638 thumbprint as the key id unless the JWK names one.
	const kid = jwk.kid ?? base64url(await sha256(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }))).slice(0, 16);
	return { kid, privateKey, publicKey, publicJwk: { ...pub, use: "sig", alg: "ES256", kid } };
}

export function signingKeys(): Promise<Keys> {
	if (!keys) {
		keys = loadKeys();
		keys.catch(() => (keys = null));
	}
	return keys;
}

/** The public half, for /.well-known/jwks.json. */
export async function jwks(): Promise<{ keys: JsonWebKey[] }> {
	return { keys: [(await signingKeys()).publicJwk] };
}

/* ---------- Access tokens ---------- */

/** The identity a token carries: enough for every account route without a KV lookup. */
export type TokenUser = { sub: string; name?: string; nickname?: string; email?: string };

export interface AccessClaims {
	iss: string;
	aud: string;
	sub: string;
	client_id: string;
	scope: string;
	iat: number;
	exp: number;
	jti: string;
	name?: string;
	nickname?: string;
	email?: string;
}

export async function mintAccessToken(input: { user: TokenUser; client_id: string; scope: string; aud: string }): Promise<{ token: string; claims: AccessClaims }> {
	const { kid, privateKey } = await signingKeys();
	const now = Math.floor(Date.now() / 1000);
	const claims: AccessClaims = {
		iss: issuer(),
		aud: input.aud,
		sub: input.user.sub,
		client_id: input.client_id,
		scope: input.scope,
		iat: now,
		exp: now + ACCESS_TOKEN_TTL,
		jti: randomToken(16),
		...(input.user.name ? { name: input.user.name } : {}),
		...(input.user.nickname ? { nickname: input.user.nickname } : {}),
		...(input.user.email ? { email: input.user.email } : {}),
	};
	const signingInput = `${utf8(JSON.stringify({ alg: "ES256", typ: "at+jwt", kid }))}.${utf8(JSON.stringify(claims))}`;
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(signingInput)));
	return { token: `${signingInput}.${base64url(signature)}`, claims };
}

/** Three base64url segments: the shape of a JWT, as opposed to the desktop app's `fmd_` tokens. */
export const looksLikeJwt = (token: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

/**
 * Checks signature, issuer, audience, expiry and revocation. Returns the claims, or null with a reason a 401 can carry
 * (RFC 6750 `error_description`).
 */
export async function verifyAccessToken(token: string): Promise<{ claims: AccessClaims } | { claims: null; reason: string }> {
	const fail = (reason: string) => ({ claims: null, reason });
	if (!looksLikeJwt(token)) return fail("malformed token");
	const [h, p, s] = token.split(".");
	let header: { alg?: string; kid?: string };
	let claims: AccessClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(base64urlDecode(h)));
		claims = JSON.parse(new TextDecoder().decode(base64urlDecode(p)));
	} catch {
		return fail("malformed token");
	}
	let k: Keys;
	try {
		k = await signingKeys();
	} catch {
		return fail("the authorization server has no signing key");
	}
	if (header.alg !== "ES256" || (header.kid && header.kid !== k.kid)) return fail("unknown key");
	const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, base64urlDecode(s), encoder.encode(`${h}.${p}`));
	if (!ok) return fail("bad signature");
	const iss = issuer();
	if (claims.iss !== iss) return fail("wrong issuer");
	if (!acceptableAudience(claims.aud, iss)) return fail("wrong audience");
	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== "number" || claims.exp <= now) return fail("token expired");
	if (typeof claims.sub !== "string" || !claims.sub) return fail("no subject");
	if (await (await kv()).get(`oauth:revoked:${claims.jti}`)) return fail("token revoked");
	return { claims };
}

/** Every resource this server protects lives under the issuer's origin, so a token for any of them is one of ours. */
export const acceptableAudience = (aud: unknown, iss = issuer()) => typeof aud === "string" && (aud === iss || aud.startsWith(`${iss}/`));

/** RFC 7009: an access token is revoked by remembering its id until it would have expired anyway. */
export async function revokeAccessToken(token: string): Promise<boolean> {
	const result = await verifyAccessToken(token);
	if (!result.claims) return false;
	const ttl = Math.max(60, result.claims.exp - Math.floor(Date.now() / 1000));
	await (await kv()).put(`oauth:revoked:${result.claims.jti}`, "1", { expirationTtl: ttl });
	return true;
}

/* ---------- Registered clients (RFC 7591) ---------- */

export interface OAuthClient {
	client_id: string;
	client_id_issued_at: number;
	client_name: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: "none";
	scope: string;
	client_uri?: string;
	logo_uri?: string;
}

const clientKey = (id: string) => `oauth:client:${id}`;
export const getClient = (id: string) => getJSON<OAuthClient>(clientKey(id));
export const saveClient = (client: OAuthClient) => putJSON(clientKey(client.client_id), client);

/* ---------- Authorization codes ---------- */

export interface CodeRecord {
	client_id: string;
	redirect_uri: string;
	code_challenge: string;
	scope: string;
	/** The audience the token will carry: the `resource` the client asked for (RFC 8707), or the issuer. */
	aud: string;
	user: TokenUser;
	iss: string;
}

const codeKey = (code: string) => `oauth:code:${code}`;
export async function createCode(record: CodeRecord): Promise<string> {
	const code = randomToken(32);
	await putJSON(codeKey(code), record, { expirationTtl: CODE_TTL });
	return code;
}
/** Reads and burns a code: it works once. */
export async function consumeCode(code: string): Promise<CodeRecord | null> {
	if (!/^[\w-]{20,64}$/.test(code)) return null;
	const record = await getJSON<CodeRecord>(codeKey(code));
	if (record) await (await kv()).delete(codeKey(code));
	return record;
}

/* ---------- Refresh tokens ---------- */

export interface RefreshRecord {
	client_id: string;
	scope: string;
	aud: string;
	user: TokenUser;
	iss: string;
	issued_at: number;
}

const refreshKey = (token: string) => `oauth:refresh:${token}`;
export const isRefreshToken = (token: string) => token.startsWith(REFRESH_PREFIX) && /^[\w-]+$/.test(token);

export async function createRefreshToken(record: RefreshRecord): Promise<string> {
	const token = `${REFRESH_PREFIX}${randomToken(32)}`;
	await putJSON(refreshKey(token), record, { expirationTtl: REFRESH_TOKEN_TTL });
	return token;
}
/** Reads and deletes a refresh token: each one is used once and replaced (rotation). */
export async function consumeRefreshToken(token: string): Promise<RefreshRecord | null> {
	if (!isRefreshToken(token)) return null;
	const record = await getJSON<RefreshRecord>(refreshKey(token));
	if (record) await (await kv()).delete(refreshKey(token));
	return record;
}
export async function deleteRefreshToken(token: string): Promise<boolean> {
	if (!isRefreshToken(token)) return false;
	const store = await kv();
	const existed = Boolean(await store.get(refreshKey(token)));
	await store.delete(refreshKey(token));
	return existed;
}

/** Access token plus a fresh refresh token, the shape both token grants return. */
export async function issueTokens(input: { client_id: string; scope: string; aud: string; user: TokenUser }) {
	const { token, claims } = await mintAccessToken(input);
	const refresh_token = await createRefreshToken({ ...input, iss: claims.iss, issued_at: claims.iat });
	return { access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token, scope: input.scope };
}
