/**
 * Model sessions for formal.team's metered model proxy (lib/model-gateway.ts), the desktop's "formal" route: a short-
 * lived key saying which account pays, minted by /api/desktop/model-session. The model key never leaves the server.
 */
import { jwtVerify, SignJWT } from "jose";
import { getJSON } from "@/lib/kv";

export class TokenError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

const ownerKey = (proofsRepo: string) => `proofs-owner:${proofsRepo.toLowerCase()}`;

/** A daily cap some repositories were given when the old hosted swarm set them up; the proxy still honours it. */
export type ProofsOwner = { sub: string; protocol: string; dailyUsd?: number };

export async function getProofsOwner(proofsRepo: string): Promise<ProofsOwner | null> {
	return getJSON<ProofsOwner>(ownerKey(proofsRepo));
}

const MODEL_SESSION_S = 3 * 3600;
const sessionSecret = () => {
	const secret = process.env.OAUTH_SIGNING_KEY;
	if (!secret) throw new Error("OAUTH_SIGNING_KEY must be set");
	return new TextEncoder().encode(`model-session:${secret}`);
};

/** A three-hour key for the model proxy: which account pays, for which folder and run; `job` names the agent and
 * the item it works on, so every charge says what it was for. */
export async function mintModelSession(sub: string, repo: string, run: string, job: { role?: string; ref?: string } = {}): Promise<string> {
	return new SignJWT({ repo, run, role: job.role ?? "", ref: job.ref ?? "" }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime(`${MODEL_SESSION_S}s`).setAudience("formal.team/model").sign(sessionSecret());
}

export async function verifyModelSession(key: string): Promise<{ sub: string; repo: string; run: string; role: string; ref: string }> {
	const { payload } = await jwtVerify(key, sessionSecret(), { audience: "formal.team/model" }).catch(() => {
		throw new TokenError(401, "Invalid or expired formal.team model session.");
	});
	return { sub: String(payload.sub), repo: String(payload.repo), run: String(payload.run), role: String(payload.role ?? ""), ref: String(payload.ref ?? "") };
}
