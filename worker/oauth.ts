/* The OAuth 2.0 authorization server at formal.team, for MCP connectors and
 * other agents acting for an account.
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   GET  /.well-known/jwks.json                     the public signing key
 *   POST /oauth/register                            RFC 7591 dynamic registration, public clients only
 *   GET  /oauth/authorize                           PKCE (S256) required; GitHub sign-in first, then a consent page
 *   POST /oauth/authorize                           the consent decision
 *   POST /oauth/token                               authorization_code and refresh_token (rotated on use)
 *   POST /oauth/revoke                              RFC 7009
 *
 * People are who GitHub says they are (lib/auth.ts); this server adds nothing
 * to sign-in, it only lets a client hold a token for the account that is
 * signed in. Tokens and records: lib/oauth.ts. */

import { auth } from "@/lib/auth";
import { kv } from "@/lib/kv";
import {
  ACCESS_TOKEN_TTL,
  CODE_TTL,
  SCOPES,
  SCOPE_LIST,
  base64url,
  consumeCode,
  consumeRefreshToken,
  createCode,
  deleteRefreshToken,
  getClient,
  isRefreshToken,
  isScope,
  issueTokens,
  issuer,
  jwks,
  randomToken,
  revokeAccessToken,
  saveClient,
  sha256,
  type OAuthClient,
  type TokenUser,
} from "@/lib/oauth";
import { ORIGIN, SITE_NAME } from "./narrative";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers },
  });
}

/* RFC 6749 §5.2 error body. */
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/* ---------- Metadata ---------- */

/* RFC 8414. Every URL here is served by this Worker; nothing is listed that
 * does not answer. */
export function authorizationServerMetadata(): Response {
  const iss = issuer();
  return new Response(
    JSON.stringify(
      {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        registration_endpoint: `${iss}/oauth/register`,
        revocation_endpoint: `${iss}/oauth/revoke`,
        jwks_uri: `${iss}/.well-known/jwks.json`,
        scopes_supported: SCOPE_LIST,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${ORIGIN}/auth.md`,
        ui_locales_supported: ["en"],
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS } },
  );
}

export async function jwksDocument(): Promise<Response> {
  return new Response(JSON.stringify(await jwks(), null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS },
  });
}

/* ---------- Registration (RFC 7591) ---------- */

const REGISTRATIONS_PER_HOUR = 30;

/* A redirect URI a public client may use: https, http to the loopback
 * (RFC 8252 §7.3, any port), or an app's own scheme (RFC 8252 §7.1). */
function acceptableRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol);
}
const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/* Exact match, except that a registered loopback URI matches any port. */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return a.protocol === "http:" && isLoopback(a.hostname) && b.protocol === "http:" && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

async function register(request: Request): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const store = await kv();
  const bucket = `ratelimit:oauth-register:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number(await store.get(bucket)) || 0;
  if (used >= REGISTRATIONS_PER_HOUR) return oauthError("invalid_client_metadata", "Too many registrations from this address this hour.", 429);
  await store.put(bucket, String(used + 1), { expirationTtl: 3700 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError("invalid_client_metadata", "The body must be a JSON object (RFC 7591).");
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!redirect_uris.length) return oauthError("invalid_redirect_uri", "redirect_uris must list at least one URI.");
  const bad = redirect_uris.find((u) => !acceptableRedirect(u));
  if (bad) return oauthError("invalid_redirect_uri", `${bad}: redirect URIs must be https, http on the loopback, or the app's own scheme.`);
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients are registered here: token_endpoint_auth_method must be \"none\".");
  }
  const grant_types = Array.isArray(body.grant_types) ? body.grant_types.filter((g): g is string => typeof g === "string") : ["authorization_code", "refresh_token"];
  const unknownGrant = grant_types.find((g) => g !== "authorization_code" && g !== "refresh_token");
  if (unknownGrant || !grant_types.includes("authorization_code")) return oauthError("invalid_client_metadata", "grant_types may hold authorization_code and refresh_token.");
  const response_types = Array.isArray(body.response_types) ? body.response_types.filter((r): r is string => typeof r === "string") : ["code"];
  if (response_types.some((r) => r !== "code")) return oauthError("invalid_client_metadata", "response_types must be [\"code\"].");
  const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : SCOPE_LIST;
  const unknownScope = scope.find((s) => !isScope(s));
  if (unknownScope) return oauthError("invalid_client_metadata", `Unknown scope ${unknownScope}; the scopes are ${SCOPE_LIST.join(", ")}.`);
  const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const httpsUrl = (v: unknown) => {
    const s = str(v, 500);
    return s && /^https:\/\//.test(s) ? s : undefined;
  };

  const client: OAuthClient = {
    client_id: `fmc_${randomToken(18)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: str(body.client_name) ?? "Unnamed client",
    redirect_uris,
    grant_types,
    response_types,
    token_endpoint_auth_method: "none",
    scope: scope.join(" "),
    ...(httpsUrl(body.client_uri) ? { client_uri: httpsUrl(body.client_uri) } : {}),
    ...(httpsUrl(body.logo_uri) ? { logo_uri: httpsUrl(body.logo_uri) } : {}),
  };
  await saveClient(client);
  return json(client, 201);
}

/* ---------- Authorization ---------- */

interface AuthorizeParams {
  client: OAuthClient;
  redirect_uri: string;
  state: string | null;
  scope: string;
  code_challenge: string;
  aud: string;
}

/* A failure the client must not learn through its redirect URI (RFC 6749
 * §4.1.2.1): a plain page instead. */
function authorizePage(title: string, message: string, status = 400): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${SITE_NAME}</title>
<body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0c0a09;background:#fafaf9">
<main style="max-width:440px;padding:24px;text-align:center"><h1 style="font-size:20px">${escape(title)}</h1><p style="color:#78716c">${escape(message)}</p></main></body>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function redirectWith(redirect_uri: string, params: Record<string, string | null>): Response {
  const url = new URL(redirect_uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "cache-control": "no-store" } });
}

/* Validates an authorization request. Problems with the client or the
 * redirect URI are shown as a page; everything else goes back to the client. */
async function readAuthorizeParams(params: URLSearchParams): Promise<{ ok: true; p: AuthorizeParams } | { ok: false; response: Response }> {
  const client_id = params.get("client_id") ?? "";
  const client = /^fmc_[\w-]+$/.test(client_id) ? await getClient(client_id) : null;
  if (!client) return { ok: false, response: authorizePage("Unknown client", "This client is not registered with Formal Mind. Register it at /oauth/register first.") };
  const redirect_uri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!redirect_uri || !client.redirect_uris.some((r) => redirectMatches(r, redirect_uri))) {
    return { ok: false, response: authorizePage("Redirect URI not registered", `${client.client_name} asked to send you to an address it did not register.`) };
  }
  const state = params.get("state");
  const back = (error: string, description: string) => ({ ok: false as const, response: redirectWith(redirect_uri, { error, error_description: description, state }) });
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const code_challenge = params.get("code_challenge") ?? "";
  if (!/^[\w-]{43,128}$/.test(code_challenge)) return back("invalid_request", "PKCE is required: send code_challenge (43 to 128 characters).");
  if (params.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256.");
  const requested = (params.get("scope") ?? "").trim().split(/\s+/).filter(Boolean);
  const scopes = requested.length ? requested : client.scope.split(" ");
  const unknown = scopes.find((s) => !isScope(s) || !client.scope.split(" ").includes(s));
  if (unknown) return back("invalid_scope", `${unknown} is not a scope this client may ask for; the scopes are ${SCOPE_LIST.join(", ")}.`);
  const iss = issuer();
  const resource = params.get("resource");
  if (resource !== null && !(resource === iss || resource.startsWith(`${iss}/`))) return back("invalid_target", `resource must be ${iss} or a URL under it.`);
  return { ok: true, p: { client, redirect_uri, state, scope: [...new Set(scopes)].join(" "), code_challenge, aud: resource ?? iss } };
}

interface ConsentTx extends AuthorizeParams {
  sub: string;
}
const txKey = (tx: string) => `oauth:consent:${tx}`;

function consentPage(tx: string, p: AuthorizeParams, user: TokenUser): Response {
  const scopes = p.scope
    .split(" ")
    .map((s) => `<li style="margin:6px 0"><code style="background:#f5f5f4;padding:2px 6px;border-radius:6px">${escape(s)}</code><br><span style="color:#57534e">${escape(SCOPES[s as keyof typeof SCOPES])}</span></li>`)
    .join("");
  const who = escape(user.nickname ? `@${user.nickname}` : user.name ?? user.sub);
  const where = escape(new URL(p.redirect_uri).origin === "null" ? p.redirect_uri : new URL(p.redirect_uri).host);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow ${escape(p.client.client_name)}? · ${SITE_NAME}</title>
<body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0c0a09;background:#fafaf9">
<main style="max-width:440px;width:100%;box-sizing:border-box;padding:28px;background:#fff;border:1px solid #e7e5e4;border-radius:16px">
<p style="margin:0 0 4px;color:#78716c;font-size:13px">${SITE_NAME}</p>
<h1 style="margin:0 0 16px;font-size:20px">Allow <strong>${escape(p.client.client_name)}</strong> to use your account?</h1>
<p style="margin:0 0 8px">Signed in as <strong>${who}</strong>. The client would be able to:</p>
<ul style="margin:0 0 20px;padding-left:20px">${scopes}</ul>
<p style="margin:0 0 20px;color:#78716c;font-size:13px">After you allow it, you are sent to <code>${where}</code>. Tokens last an hour and renew until you revoke them.</p>
<form method="post" action="/oauth/authorize" style="display:flex;gap:10px;justify-content:flex-end">
<input type="hidden" name="tx" value="${escape(tx)}">
<button name="decision" value="deny" style="padding:9px 16px;border-radius:999px;border:1px solid #d6d3d1;background:#fff;color:#0c0a09;cursor:pointer">Deny</button>
<button name="decision" value="allow" style="padding:9px 18px;border-radius:999px;border:0;background:#0c0a09;color:#fff;cursor:pointer;font-weight:500">Allow</button>
</form></main></body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function authorizeGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const read = await readAuthorizeParams(url.searchParams);
  if (!read.ok) return read.response;
  const session = await auth.getSession();
  if (!session) {
    // GitHub sign-in, then back here with the same query.
    return new Response(null, { status: 302, headers: { Location: `/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
  }
  const tx = randomToken(24);
  const record: ConsentTx = { ...read.p, sub: session.user.sub };
  await (await kv()).put(txKey(tx), JSON.stringify(record), { expirationTtl: CODE_TTL });
  const user: TokenUser = { sub: session.user.sub, name: session.user.name, nickname: session.user.nickname, email: session.user.email };
  return consentPage(tx, read.p, user);
}

async function authorizePost(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const tx = form?.get("tx");
  if (typeof tx !== "string" || !/^[\w-]{24,64}$/.test(tx)) return authorizePage("Consent expired", "Start again from the client.");
  const store = await kv();
  const raw = await store.get(txKey(tx));
  if (!raw) return authorizePage("Consent expired", "That consent page is no longer valid. Start again from the client.");
  await store.delete(txKey(tx));
  const record = JSON.parse(raw) as ConsentTx;
  const session = await auth.getSession();
  if (!session || session.user.sub !== record.sub) return authorizePage("Signed out", "The sign-in changed while the consent page was open. Start again from the client.");
  if (form?.get("decision") !== "allow") return redirectWith(record.redirect_uri, { error: "access_denied", error_description: "The user denied the request.", state: record.state });
  const user: TokenUser = { sub: session.user.sub, name: session.user.name, nickname: session.user.nickname, email: session.user.email };
  const code = await createCode({
    client_id: record.client.client_id,
    redirect_uri: record.redirect_uri,
    code_challenge: record.code_challenge,
    scope: record.scope,
    aud: record.aud,
    user,
    iss: issuer(),
  });
  // RFC 9207: the client can check the code came from the issuer it expects.
  return redirectWith(record.redirect_uri, { code, state: record.state, iss: issuer() });
}

/* ---------- Token ---------- */

async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string") as [string, string][]);
  }
  const form = await request.formData().catch(() => null);
  const out: Record<string, string> = {};
  form?.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

async function token(request: Request): Promise<Response> {
  const body = await readBody(request);
  const client_id = body.client_id ?? "";
  const client = /^fmc_[\w-]+$/.test(client_id) ? await getClient(client_id) : null;
  if (!client) return oauthError("invalid_client", "Unknown client_id.", 401);

  if (body.grant_type === "authorization_code") {
    const record = body.code ? await consumeCode(body.code) : null;
    if (!record) return oauthError("invalid_grant", "The authorization code is invalid, expired or already used.");
    if (record.client_id !== client_id) return oauthError("invalid_grant", "The code was issued to another client.");
    if (record.iss !== issuer()) return oauthError("invalid_grant", "The code was issued by another issuer.");
    if (body.redirect_uri !== record.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    const verifier = body.code_verifier ?? "";
    if (!/^[\w.~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "code_verifier is missing or malformed.");
    if (base64url(await sha256(verifier)) !== record.code_challenge) return oauthError("invalid_grant", "code_verifier does not match the code_challenge.");
    return json(await issueTokens({ client_id, scope: record.scope, aud: record.aud, user: record.user }));
  }

  if (body.grant_type === "refresh_token") {
    const record = body.refresh_token ? await consumeRefreshToken(body.refresh_token) : null;
    if (!record) return oauthError("invalid_grant", "The refresh token is invalid, expired or already used.");
    if (record.client_id !== client_id) return oauthError("invalid_grant", "The refresh token belongs to another client.");
    if (record.iss !== issuer()) return oauthError("invalid_grant", "The refresh token was issued by another issuer.");
    // A narrower scope may be asked for, never a wider one.
    const granted = record.scope.split(" ");
    const asked = (body.scope ?? "").trim().split(/\s+/).filter(Boolean);
    if (asked.some((s) => !granted.includes(s))) return oauthError("invalid_scope", "The refresh token does not cover that scope.");
    return json(await issueTokens({ client_id, scope: asked.length ? asked.join(" ") : record.scope, aud: record.aud, user: record.user }));
  }

  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

/* RFC 7009: 200 whether or not the token was ours, so nothing can be probed. */
async function revoke(request: Request): Promise<Response> {
  const body = await readBody(request);
  const t = body.token ?? "";
  if (isRefreshToken(t)) await deleteRefreshToken(t);
  else if (t) await revokeAccessToken(t);
  return json({});
}

/* ---------- Routing ---------- */

/** Everything under /oauth/. */
export async function handleOAuth(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const method = request.method;
  switch (pathname) {
    case "/oauth/register":
      return method === "POST" ? register(request) : oauthError("invalid_request", "POST a client metadata document (RFC 7591).", 405);
    case "/oauth/authorize":
      if (method === "GET" || method === "HEAD") return authorizeGet(request);
      if (method === "POST") return authorizePost(request);
      return oauthError("invalid_request", "GET to start, POST from the consent page.", 405);
    case "/oauth/token":
      return method === "POST" ? token(request) : oauthError("invalid_request", "POST grant_type, code or refresh_token, client_id (RFC 6749).", 405);
    case "/oauth/revoke":
      return method === "POST" ? revoke(request) : oauthError("invalid_request", "POST token (RFC 7009).", 405);
  }
  return json({ error: "not_found" }, 404);
}

export { ACCESS_TOKEN_TTL };
