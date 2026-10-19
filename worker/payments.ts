/**
 * Agent payments: an agent (or an audit team's script) buys Formal Mind credits over HTTP, with no checkout page.
 * `POST /api/agent/credits?usd=N` answers 402 with two offers, and a paid retry credits the account the same way a
 * Stripe deposit does (lib/billing.ts `applyAgentPayment`):
 *
 * - x402 (https://x402.org) through `@x402/hono`: USDC on Base, `exact` scheme, settled by the facilitator after
 *   the handler succeeds. The account is the caller's own: cookie, desktop session, or an OAuth access token in
 *   `Authorization: Bearer` (the x402 payment travels in `PAYMENT-SIGNATURE`, leaving Authorization free).
 * - MPP (https://mpp.dev) through `mppx`: a Tempo charge. MPP's credential takes the Authorization header, so the
 *   account's OAuth access token goes in `X-Formal-Mind-Token` instead.
 *
 * A payment without an account is refused before it settles (x402 cancels settlement on a 4xx; MPP is checked before
 * the charge), so nobody pays for credits that land nowhere. Configuration (wrangler secrets or vars):
 * X402_PAY_TO, X402_NETWORK, X402_FACILITATOR_URL, MPP_SECRET_KEY, MPP_RECIPIENT, MPP_TESTNET.
 */
import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { Receipt } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { auth } from "@/lib/auth";
import { applyAgentPayment } from "@/lib/billing";
import { verifyAccessToken } from "@/lib/oauth";
import type { Env } from "./context";

export const AGENT_CREDITS_PATH = "/api/agent/credits";
export const AGENT_MIN_USD = 1;
export const AGENT_MAX_USD = 1_000;
/** Base Sepolia until X402_NETWORK says otherwise; the public facilitator only settles testnets. */
const DEFAULT_NETWORK = "eip155:84532";
const DEFAULT_FACILITATOR = "https://x402.org/facilitator";

type Vars = { usd: number; sub?: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const config = (env: Env) => {
	const e = env as unknown as Record<string, unknown>;
	const payTo = str(e.X402_PAY_TO);
	return {
		payTo,
		network: (str(e.X402_NETWORK) ?? DEFAULT_NETWORK) as `${string}:${string}`,
		facilitator: str(e.X402_FACILITATOR_URL) ?? DEFAULT_FACILITATOR,
		mppSecret: str(e.MPP_SECRET_KEY),
		mppRecipient: (str(e.MPP_RECIPIENT) ?? payTo) as `0x${string}` | undefined,
		mppTestnet: str(e.MPP_TESTNET) !== "false",
	};
};
export type AgentPaymentConfig = ReturnType<typeof config>;
export const agentPaymentConfig = config;

/** Whole dollars from `?usd=`, within bounds; anything else is null. */
function parseUsd(raw: string | undefined): number | null {
	const usd = Number(raw ?? "");
	return Number.isInteger(usd) && usd >= AGENT_MIN_USD && usd <= AGENT_MAX_USD ? usd : null;
}

// One payment middleware per isolate and configuration: it syncs with the facilitator once, on first use.
let x402Cache: { key: string; mw: MiddlewareHandler } | null = null;
function x402For(cfg: AgentPaymentConfig): MiddlewareHandler | null {
	if (!cfg.payTo) return null;
	const key = `${cfg.facilitator}|${cfg.network}|${cfg.payTo}`;
	if (x402Cache?.key === key) return x402Cache.mw;
	const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitator })).register(cfg.network, new ExactEvmScheme());
	const mw = paymentMiddleware(
		{
			[`POST ${AGENT_CREDITS_PATH}`]: {
				accepts: [
					{
						scheme: "exact",
						network: cfg.network,
						payTo: cfg.payTo,
						price: (ctx) => `$${parseUsd(ctx.adapter.getQueryParam?.("usd") as string | undefined) ?? AGENT_MIN_USD}`,
						maxTimeoutSeconds: 120,
					},
				],
				description: "Formal Mind credits: prepaid model usage for your verification swarm (USD 1:1).",
				mimeType: "application/json",
			},
		},
		server,
	);
	x402Cache = { key, mw };
	return mw;
}

let mppCache: { key: string; mppx: ReturnType<typeof makeMppx> } | null = null;
function makeMppx(cfg: AgentPaymentConfig) {
	return Mppx.create({ methods: [tempo({ recipient: cfg.mppRecipient!, testnet: cfg.mppTestnet })], secretKey: cfg.mppSecret! });
}
function mppFor(cfg: AgentPaymentConfig) {
	if (!cfg.mppSecret || !cfg.mppRecipient) return null;
	const key = `${cfg.mppRecipient}|${cfg.mppTestnet}|${cfg.mppSecret}`;
	if (mppCache?.key !== key) mppCache = { key, mppx: makeMppx(cfg) };
	return mppCache.mppx;
}

/** The account being topped up: `X-Formal-Mind-Token` (an OAuth access token), else the caller's own session. */
async function accountSub(c: C): Promise<string | null> {
	const token = c.req.header("x-formal-mind-token")?.replace(/^Bearer\s+/i, "");
	if (token) {
		const result = await verifyAccessToken(token);
		return result.claims?.sub ?? null;
	}
	return (await auth.getPrincipal()).session?.user.sub ?? null;
}

const noAccount = (c: C) =>
	c.json(
		{
			error: "unauthenticated",
			error_description:
				"Payment was not taken: credits need an account. Send an OAuth access token for your Formal Mind account (Authorization: Bearer for x402, X-Formal-Mind-Token for MPP); see /.well-known/oauth-protected-resource.",
		},
		401,
	);

const isMppCredential = (c: C) => /^Payment\s/i.test(c.req.header("authorization") ?? "");
const isX402Credential = (c: C) => Boolean(c.req.header("payment-signature") || c.req.header("x-payment"));

/**
 * The whole route as one Hono handler chain. Without a credential the 402 carries both offers: x402's
 * PAYMENT-REQUIRED header and body, plus MPP's `WWW-Authenticate: Payment` challenge.
 */
export function agentCreditsChain(): [MiddlewareHandler, MiddlewareHandler, MiddlewareHandler, MiddlewareHandler] {
	const validate: MiddlewareHandler = async (c, next) => {
		const usd = parseUsd(c.req.query("usd"));
		if (usd === null) return c.json({ error: `usd must be a whole number of dollars from ${AGENT_MIN_USD} to ${AGENT_MAX_USD}` }, 400);
		const cfg = config(c.env);
		if (!cfg.payTo && !cfg.mppSecret) return c.json({ error: "Agent payments aren't configured on this deployment." }, 503);
		c.set("usd", usd);
		await next();
	};

	// MPP: account first, then the charge (it verifies and settles in one step), then the credit.
	const mpp: MiddlewareHandler = async (c, next) => {
		if (!isMppCredential(c)) return next();
		const mppx = mppFor(config(c.env));
		if (!mppx) return c.json({ error: "MPP isn't configured on this deployment." }, 503);
		const sub = await accountSub(c as C);
		if (!sub) return noAccount(c as C);
		const usd = c.get("usd") as number;
		const result = await mppx.charge({ amount: String(usd), description: "Formal Mind credits" })(c.req.raw);
		if (result.status === 402) return result.challenge as Response;
		const paid = result.withReceipt(c.json({ credited_usd: usd, via: "mpp" })) as Response;
		const receipt = Receipt.fromResponse(paid);
		await applyAgentPayment({ sub, cents: usd * 100, ref: receipt.reference, via: "mpp" });
		return paid;
	};

	// x402: the official middleware; credit once the facilitator's settlement is on the response.
	const x402: MiddlewareHandler = async (c, next) => {
		const cfg = config(c.env);
		const mw = x402For(cfg);
		if (!mw) {
			// MPP only: issue its challenge.
			const mppx = mppFor(cfg);
			const result = await mppx!.charge({ amount: String(c.get("usd")), description: "Formal Mind credits" })(c.req.raw);
			return result.status === 402 ? (result.challenge as Response) : c.json({ error: "Unexpected payment state." }, 500);
		}
		// It returns the 402 (or an error) rather than setting it; a paid request leaves its answer on c.res.
		const early = await mw(c, next);
		if (early) c.res = early;
		const settled = c.res.headers.get("payment-response");
		const sub = c.get("sub") as string | undefined;
		if (c.res.ok && settled && sub) {
			const settle = decodePaymentResponseHeader(settled);
			if (settle.success && settle.transaction) {
				await applyAgentPayment({ sub, cents: (c.get("usd") as number) * 100, ref: `${settle.network}:${settle.transaction}`, via: "x402" });
			}
		}
		// The unpaid answer also offers MPP, when it is configured.
		if (c.res.status === 402 && !isX402Credential(c as C)) {
			const mppx = mppFor(cfg);
			if (mppx) {
				const challenge = await mppx.charge({ amount: String(c.get("usd")), description: "Formal Mind credits" })(c.req.raw);
				const header = challenge.status === 402 ? (challenge.challenge as Response).headers.get("www-authenticate") : null;
				if (header) {
					c.res = new Response(c.res.body, c.res);
					c.res.headers.append("www-authenticate", header);
				}
			}
		}
		return c.res;
	};

	// Reached only with a verified x402 payment: refuse it (no settlement) unless there is an account to credit.
	const handler: MiddlewareHandler = async (c) => {
		const sub = await accountSub(c as C);
		if (!sub) return noAccount(c as C);
		c.set("sub", sub);
		return c.json({ credited_usd: c.get("usd"), via: "x402" });
	};

	return [validate, mpp, x402, handler];
}
