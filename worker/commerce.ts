/* Commerce discovery: how an agent finds out it can buy Formal Mind credits
 * over HTTP (worker/payments.ts). Every document describes the one payable
 * operation that exists, POST /api/agent/credits?usd=N, paid with x402 or
 * MPP:
 *
 * - /openapi.json: OpenAPI 3.1 with MPP `x-payment-info` (draft-payment-
 *   discovery-00) and the same offer for x402 under `x-x402`.
 * - /.well-known/ucp: a UCP profile. Formal Mind is not a shop, so it names
 *   its own service namespace (team.formal.credits) rather than claiming
 *   dev.ucp.shopping; the payment handlers are x402 and MPP.
 * - /.well-known/acp.json: the ACP discovery document, likewise naming the
 *   credits service and not an ACP checkout_sessions API. */

import { ORIGIN, SITE_NAME } from "./narrative";
import { AGENT_CREDITS_PATH, AGENT_MAX_USD, AGENT_MIN_USD } from "./payments";

const UCP_VERSION = "2026-08-25";

function json(body: unknown, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": contentType, "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
  });
}

const DESCRIPTION = `Buy ${SITE_NAME} credits (prepaid model usage for the verification swarm, USD 1:1) with an HTTP 402 payment: x402 (USDC on Base) or MPP (Tempo). Unpaid, the call answers 402 with both offers; the paid retry credits the account named by an OAuth access token.`;

function openApi(): Response {
  return json({
    openapi: "3.1.0",
    info: { title: `${SITE_NAME} agent payments`, version: "1.0.0", description: DESCRIPTION },
    servers: [{ url: ORIGIN }],
    "x-service-info": {
      categories: ["developer-tools", "security", "ai"],
      docs: `${ORIGIN}/auth.md`,
    },
    paths: {
      [AGENT_CREDITS_PATH]: {
        post: {
          operationId: "buyCredits",
          summary: "Buy credits for a Formal Mind account",
          description: DESCRIPTION,
          parameters: [
            { name: "usd", in: "query", required: true, description: `Whole dollars to credit, ${AGENT_MIN_USD} to ${AGENT_MAX_USD}; the price equals it.`, schema: { type: "integer", minimum: AGENT_MIN_USD, maximum: AGENT_MAX_USD } },
            { name: "X-Formal-Mind-Token", in: "header", required: false, description: "The account's OAuth access token when paying with MPP (whose credential takes Authorization). With x402 send it as Authorization: Bearer.", schema: { type: "string" } },
          ],
          security: [{ oauth2: [] }],
          "x-payment-info": {
            intent: "charge",
            method: "tempo",
            amount: String(AGENT_MIN_USD),
            currency: "USD",
            description: "Price equals the usd query parameter (minimum shown).",
          },
          "x-x402": { scheme: "exact", asset: "USDC", networks: ["eip155:8453", "eip155:84532"], price: "usd query parameter, in dollars" },
          responses: {
            "200": { description: "Paid and credited.", content: { "application/json": { schema: { type: "object", properties: { credited_usd: { type: "integer" }, via: { type: "string", enum: ["x402", "mpp"] } } } } } },
            "400": { description: "usd out of range." },
            "401": { description: "No account to credit; the payment was not taken." },
            "402": { description: "Payment required: PAYMENT-REQUIRED (x402) and WWW-Authenticate: Payment (MPP) carry the offers." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: { authorizationCode: { authorizationUrl: `${ORIGIN}/oauth/authorize`, tokenUrl: `${ORIGIN}/oauth/token`, scopes: { "swarm:read": "Read the account", "swarm:write": "Act on the account" } } },
        },
      },
    },
  });
}

const service = {
  version: UCP_VERSION,
  spec: `${ORIGIN}/auth.md`,
  transport: "rest",
  endpoint: `${ORIGIN}${AGENT_CREDITS_PATH}`,
  schema: `${ORIGIN}/openapi.json`,
};

function ucp(): Response {
  const services = { "team.formal.credits": [service] };
  const capabilities = { "team.formal.credits.purchase": [{ version: UCP_VERSION, spec: `${ORIGIN}/auth.md`, schema: `${ORIGIN}/openapi.json` }] };
  const payment_handlers = {
    "org.x402": [{ version: "2", spec: "https://docs.x402.org", config: { scheme: "exact", asset: "USDC" } }],
    "dev.mpp": [{ version: "draft-payment-discovery-00", spec: "https://paymentauth.org/draft-payment-discovery-00.txt", config: { method: "tempo", intent: "charge" } }],
  };
  return json({
    ucp: { version: UCP_VERSION, services, capabilities, payment_handlers },
    // Flat fields for readers that expect them at the top level.
    protocol_version: UCP_VERSION,
    services,
    capabilities,
    endpoints: { rest: `${ORIGIN}${AGENT_CREDITS_PATH}`, openapi: `${ORIGIN}/openapi.json` },
  });
}

function acp(): Response {
  return json({
    protocol: { name: "acp", version: "2025-09-29", supported_versions: ["2025-09-29"] },
    api_base_url: `${ORIGIN}/api/agent`,
    transports: ["rest"],
    capabilities: { services: ["credits"], payment_protocols: ["x402", "mpp"], openapi: `${ORIGIN}/openapi.json` },
  });
}

export function handleCommerce(pathname: string): Response | null {
  switch (pathname) {
    case "/openapi.json":
      return openApi();
    case "/.well-known/ucp":
      return ucp();
    case "/.well-known/acp.json":
      return acp();
  }
  return null;
}
