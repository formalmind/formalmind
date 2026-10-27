#!/usr/bin/env bun
/**
 * Walks the whole OAuth 2.0 + account-MCP flow against a running Worker, the way an MCP client does, using the MCP
 * SDK's own client-side auth helpers for discovery, registration and the token endpoint:
 *
 *   bun run build && npx wrangler dev --host localhost:8787   # dev preview: every browser request is signed in
 *   bun scripts/oauth-client.ts [http://localhost:8787]
 *
 * (`--host` keeps the request origin at localhost; plain `wrangler dev` rewrites it to formal.team, the first route,
 * and the issuer in the metadata would then name a host this script cannot reach.)
 *
 * It checks: 401 + WWW-Authenticate on /mcp/account, RFC 9728 and RFC 8414 discovery (with the required fields),
 * dynamic registration, PKCE authorization through the consent page, the JWT's claims and signature against the
 * JWKS, tools/list and my_projects on /mcp/account, a swarm:read-only token refused with insufficient_scope (MCP and
 * API), an invalid token refused with invalid_token, a token refused on a route that is not open to tokens, refresh
 * with rotation, and revocation. Exit code 1 on the first failed check.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	exchangeAuthorization,
	extractWWWAuthenticateParams,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const serverUrl = `${base}/mcp/account`;
const redirectUri = "http://127.0.0.1:9876/callback";

let step = 0;
const say = (line: string) => console.log(line);
const check = (ok: boolean, what: string, detail?: unknown) => {
	step += 1;
	say(`${ok ? "ok " : "FAIL"} ${String(step).padStart(2)}. ${what}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) process.exit(1);
};
const decode = (segment: string) => JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

/** The consent page in a browser, scripted: GET it (the dev preview counts as signed in), then POST Allow. */
async function consent(authorizationUrl: URL, expectState: string): Promise<string> {
	const page = await fetch(authorizationUrl, { redirect: "manual" });
	check(page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html"), `GET /oauth/authorize shows the consent page (${page.status})`);
	const html = await page.text();
	const tx = html.match(/name="tx" value="([\w-]+)"/)?.[1];
	check(Boolean(tx), "consent page carries a one-time tx", { namesClient: html.includes("oauth-client script"), namesScopes: html.includes("swarm:read") });
	const form = new URLSearchParams({ tx: tx!, decision: "allow" });
	const done = await fetch(`${base}/oauth/authorize`, { method: "POST", body: form, redirect: "manual" });
	const location = new URL(done.headers.get("location") ?? "", redirectUri);
	check(done.status === 302 && location.origin + location.pathname === redirectUri, "Allow redirects to the registered redirect_uri", location.origin + location.pathname);
	check(location.searchParams.get("state") === expectState, "state round-trips");
	check(location.searchParams.get("iss") === base, "iss (RFC 9207) names the issuer", location.searchParams.get("iss"));
	const code = location.searchParams.get("code");
	check(Boolean(code), "an authorization code came back");
	return code!;
}

async function main() {
	say(`# OAuth + /mcp/account against ${base}\n`);

	// 1. Unauthenticated: 401 with WWW-Authenticate pointing at the resource metadata.
	const anon = await fetch(serverUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	const www = anon.headers.get("www-authenticate") ?? "";
	check(anon.status === 401, "POST /mcp/account without a token is 401", `WWW-Authenticate: ${www}`);
	const { resourceMetadataUrl } = extractWWWAuthenticateParams(anon);
	check(resourceMetadataUrl?.href === `${base}/.well-known/oauth-protected-resource/mcp/account`, "the header names the path-specific RFC 9728 document", resourceMetadataUrl?.href);

	// 2. Discovery, with the SDK's own helpers.
	const resource = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl });
	check(resource.resource === serverUrl && resource.authorization_servers?.[0] === base, "RFC 9728 metadata: resource and authorization_servers", resource);
	const root = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { resource: string; authorization_servers: string[] };
	check(root.resource === base && root.authorization_servers[0] === base, "root RFC 9728 metadata agrees", root);
	const metadata = await discoverAuthorizationServerMetadata(base);
	check(Boolean(metadata), "RFC 8414 metadata found at /.well-known/oauth-authorization-server");
	const m = metadata! as typeof metadata & { revocation_endpoint?: string };
	const required = ["issuer", "authorization_endpoint", "token_endpoint", "response_types_supported"] as const;
	check(required.every((k) => Boolean(m[k])), `RFC 8414 required fields present: ${required.join(", ")}`);
	check(
		m.issuer === base && m.jwks_uri === `${base}/.well-known/jwks.json` && m.registration_endpoint === `${base}/oauth/register` && m.revocation_endpoint === `${base}/oauth/revoke`,
		"issuer, jwks_uri, registration_endpoint, revocation_endpoint",
		{ issuer: m.issuer, jwks_uri: m.jwks_uri, registration_endpoint: m.registration_endpoint, revocation_endpoint: m.revocation_endpoint },
	);
	check(
		Boolean(m.code_challenge_methods_supported?.includes("S256") && m.grant_types_supported?.includes("refresh_token") && m.token_endpoint_auth_methods_supported?.includes("none")),
		"S256, refresh_token and public clients advertised",
		{ code_challenge_methods_supported: m.code_challenge_methods_supported, grant_types_supported: m.grant_types_supported, scopes_supported: m.scopes_supported },
	);
	const slash = await fetch(`${base}/.well-known/oauth-authorization-server/`);
	check(slash.status === 200 && ((await slash.json()) as { issuer: string }).issuer === base, "the same metadata with a trailing slash");

	// 3. Dynamic registration.
	const clientInformation = await registerClient(base, {
		metadata: m,
		clientMetadata: {
			client_name: "oauth-client script",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
	});
	check(clientInformation.client_id.startsWith("fmc_"), "RFC 7591 registration returned a client_id", { client_id: clientInformation.client_id, client_name: clientInformation.client_name });
	const badRegistration = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.example/cb"] }) });
	check(badRegistration.status === 400, "a non-loopback http redirect_uri is refused", await badRegistration.json());

	// 4. Authorization code + PKCE through the consent page.
	const state = crypto.randomUUID();
	const { authorizationUrl, codeVerifier } = await startAuthorization(base, { metadata: m, clientInformation, redirectUrl: redirectUri, scope: "swarm:read swarm:write", state, resource: new URL(serverUrl) });
	check(authorizationUrl.searchParams.get("code_challenge_method") === "S256", "the SDK built a PKCE S256 request", authorizationUrl.pathname + "?" + [...authorizationUrl.searchParams.keys()].join("&"));
	const noPkce = new URL(authorizationUrl);
	noPkce.searchParams.delete("code_challenge");
	const refusedPkce = await fetch(noPkce, { redirect: "manual" });
	const refusedTo = new URL(refusedPkce.headers.get("location") ?? "", redirectUri);
	check(refusedPkce.status === 302 && refusedTo.searchParams.get("error") === "invalid_request", "without code_challenge the request is refused back to the client", refusedTo.searchParams.get("error_description"));
	const code = await consent(authorizationUrl, state);

	// 5. Token.
	const wrongVerifier = await fetch(m.token_endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), redirect_uri: redirectUri, client_id: clientInformation.client_id }),
	});
	check(wrongVerifier.status === 400 && ((await wrongVerifier.json()) as { error: string }).error === "invalid_grant", "a wrong code_verifier is invalid_grant (and burns the code)");
	const code2 = await consent(authorizationUrl, state);
	const tokens = await exchangeAuthorization(base, { metadata: m, clientInformation, authorizationCode: code2, codeVerifier, redirectUri, resource: new URL(serverUrl) });
	check(tokens.token_type.toLowerCase() === "bearer" && tokens.expires_in === 3600 && Boolean(tokens.refresh_token), "token response: bearer, 3600 s, refresh_token", { scope: tokens.scope, expires_in: tokens.expires_in, refresh_token: tokens.refresh_token?.slice(0, 8) + "…" });
	const reuse = await fetch(m.token_endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code: code2, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id: clientInformation.client_id }),
	});
	check(reuse.status === 400, "a code cannot be used twice");
	const [h, p, s] = tokens.access_token.split(".");
	const header = decode(h) as { alg: string; kid: string; typ: string };
	const claims = decode(p) as Record<string, unknown>;
	check(header.alg === "ES256" && claims.iss === base && claims.aud === serverUrl && claims.scope === "swarm:read swarm:write" && (claims.exp as number) - (claims.iat as number) === 3600, "JWT: ES256, iss, aud = resource, scope, 1 h", { header, claims: { ...claims, exp: undefined, iat: undefined, jti: undefined } });
	const jwks = (await (await fetch(String(m.jwks_uri))).json()) as { keys: (JsonWebKey & { kid: string })[] };
	const jwk = jwks.keys.find((k) => k.kid === header.kid);
	check(Boolean(jwk), "jwks.json carries the kid the token names", jwk && { kid: jwk.kid, kty: jwk.kty, crv: jwk.crv });
	const key = await crypto.subtle.importKey("jwk", { kty: jwk!.kty, crv: jwk!.crv, x: jwk!.x, y: jwk!.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	const sig = Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
	check(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(`${h}.${p}`)), "the signature verifies against the published key");

	// 6. The account MCP server through the SDK client.
	const client = new Client({ name: "oauth-client script", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } });
	await client.connect(transport);
	const { tools } = await client.listTools();
	check(tools.map((t) => t.name).join(",") === "my_projects,list_files,read_file,list_audits,list_findings,get_finding,proofs_coverage,mac_swarm,mac_watch,mac_swarm_events,mac_swarm_send,mac_get,mac_do,mac_reply", "tools/list on /mcp/account", tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`));
	const projects = await client.callTool({ name: "my_projects", arguments: {} });
	const projectsText = (projects.content as { type: string; text?: string }[])[0]?.text ?? "";
	check(!projects.isError && projectsText.includes("asyncswap/v2"), "my_projects answers for the signed-in account", JSON.parse(projectsText).projects.map((p: { repo: string }) => p.repo));
	const credits = await client.callTool({ name: "my_credits", arguments: {} });
	check(!credits.isError, "my_credits answers", (credits.content as { text?: string }[])[0]?.text?.replace(/\s+/g, " ").slice(0, 120));
	await client.close();

	// 7. The same token on the API routes.
	const api = (path: string, token: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), authorization: `Bearer ${token}` } });
	const list = await api("/api/projects", tokens.access_token);
	check(list.status === 200, "GET /api/projects with the token is 200", ((await list.json()) as { projects: { repo: string }[] }).projects.map((p) => p.repo));
	const chat = await api("/api/chat", tokens.access_token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	check(chat.status === 403 && ((await chat.json()) as { error: string }).error === "insufficient_scope", "POST /api/chat (not open to tokens) is 403 insufficient_scope");
	const invalid = await api("/api/projects", "not.a.token");
	check(invalid.status === 401 && (invalid.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'), "an invalid bearer on /api/projects is 401 invalid_token", invalid.headers.get("www-authenticate"));
	const invalidMcp = await fetch(serverUrl, { method: "POST", headers: { authorization: "Bearer not.a.token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
	check(invalidMcp.status === 401 && (invalidMcp.headers.get("www-authenticate") ?? "").includes("resource_metadata="), "an invalid bearer on /mcp/account is 401 with resource_metadata", invalidMcp.headers.get("www-authenticate"));

	// 8. A swarm:read-only token is refused swarm:write tools and routes.
	const readState = crypto.randomUUID();
	const readAuth = await startAuthorization(base, { metadata: m, clientInformation, redirectUrl: redirectUri, scope: "swarm:read", state: readState, resource: new URL(serverUrl) });
	const readCode = await consent(readAuth.authorizationUrl, readState);
	const readTokens = await exchangeAuthorization(base, { metadata: m, clientInformation, authorizationCode: readCode, codeVerifier: readAuth.codeVerifier, redirectUri, resource: new URL(serverUrl) });
	check(readTokens.scope === "swarm:read", "a second grant with scope=swarm:read only", { scope: readTokens.scope });
	const denied = await fetch(serverUrl, {
		method: "POST",
		headers: { authorization: `Bearer ${readTokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mac_do", arguments: { op: "folders" } } }),
	});
	check(denied.status === 403 && (denied.headers.get("www-authenticate") ?? "").includes('error="insufficient_scope", scope="swarm:write"'), "mac_do with swarm:read is 403 insufficient_scope", denied.headers.get("www-authenticate"));
	const stillReads = await api("/api/usage", readTokens.access_token);
	check(stillReads.status === 200, "GET /api/usage with swarm:read is 200");

	// 9. Refresh, with rotation.
	const refreshed = await refreshAuthorization(base, { metadata: m, clientInformation, refreshToken: tokens.refresh_token!, resource: new URL(serverUrl) });
	check(refreshed.access_token !== tokens.access_token && refreshed.refresh_token !== tokens.refresh_token, "refresh_token grant returns a new pair", { scope: refreshed.scope });
	const replay = await fetch(m.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientInformation.client_id }) });
	check(replay.status === 400 && ((await replay.json()) as { error: string }).error === "invalid_grant", "the used refresh token no longer works (rotation)");
	const refreshedWorks = await api("/api/projects", refreshed.access_token);
	check(refreshedWorks.status === 200, "the refreshed access token works on GET /api/projects");

	// 10. Revocation.
	const revokeAccess = await fetch(m.revocation_endpoint!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshed.access_token, token_type_hint: "access_token" }) });
	check(revokeAccess.status === 200, "POST /oauth/revoke (access token) is 200");
	const revokedCall = await api("/api/projects", refreshed.access_token);
	check(revokedCall.status === 401 && (revokedCall.headers.get("www-authenticate") ?? "").includes("revoked"), "the revoked access token is 401", revokedCall.headers.get("www-authenticate"));
	const revokeRefresh = await fetch(m.revocation_endpoint!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshed.refresh_token!, token_type_hint: "refresh_token" }) });
	check(revokeRefresh.status === 200, "POST /oauth/revoke (refresh token) is 200");
	const afterRevoke = await fetch(m.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token!, client_id: clientInformation.client_id }) });
	check(afterRevoke.status === 400, "the revoked refresh token cannot be used");

	// 11. The anonymous server is untouched.
	const anonymous = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
	const anonTools = ((await anonymous.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
	check(anonymous.status === 200 && anonTools.length === 4, "/mcp still answers without a token", anonTools);

	say(`\nAll ${step} checks passed.`);
}

main().catch((error) => {
	console.error("FAIL", error);
	process.exit(1);
});
