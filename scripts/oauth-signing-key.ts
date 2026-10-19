#!/usr/bin/env bun
/**
 * Prints a fresh private P-256 JWK for the OAUTH_SIGNING_KEY Worker secret (lib/oauth.ts), on one line:
 *
 *   bun scripts/oauth-signing-key.ts | npx wrangler secret put OAUTH_SIGNING_KEY
 *
 * For local preview, paste it into .dev.vars as OAUTH_SIGNING_KEY='{…}'. The public half is served at
 * /.well-known/jwks.json; the key id is the RFC 7638 thumbprint unless the JWK carries a kid.
 */
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const { kty, crv, x, y, d } = jwk;
const kid = new Date().toISOString().slice(0, 10).replace(/-/g, "");
console.log(JSON.stringify({ kty, crv, x, y, d, kid, alg: "ES256", use: "sig" }));

export {};
