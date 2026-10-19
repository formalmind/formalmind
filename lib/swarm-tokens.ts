/**
 * Zero-secret swarms. A proofs repository's workflow proves who it is with a GitHub Actions OIDC token and gets back a
 * short-lived formalmind App token for its own repository (and the protocol it models) and a model session key for
 * formal.team's model proxy (lib/model-gateway.ts), which meters every call against the account's credits. No key is
 * kept in the repository, and neither the App's key nor the model key ever leaves the server.
 */
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { getAppOctokit } from "@/lib/octokit";
import { getJSON, putJSON } from "@/lib/kv";

const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const jwks = createRemoteJWKSet(new URL(`${ACTIONS_ISSUER}/.well-known/jwks`));
/** The audience the workflow asks GitHub for, so a token minted for another service is refused here. */
export const SWARM_AUDIENCE = "https://formal.team";
const SWARM_WORKFLOW = ".github/workflows/formalmind-swarm.yml";

export class TokenError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

const ownerKey = (proofsRepo: string) => `proofs-owner:${proofsRepo.toLowerCase()}`;

/** Which account pays for a proofs repository's swarm. Written when the app sets the repository up. */
export type ProofsOwner = { sub: string; protocol: string; dailyUsd?: number };

export async function setProofsOwner(proofsRepo: string, sub: string, protocol: string, dailyUsd?: number): Promise<void> {
	await putJSON(ownerKey(proofsRepo), { sub, protocol, dailyUsd });
}

export async function getProofsOwner(proofsRepo: string): Promise<ProofsOwner | null> {
	return getJSON<ProofsOwner>(ownerKey(proofsRepo));
}

/** Verifies a GitHub Actions OIDC token from the swarm workflow, and returns the repository and run it speaks for. */
export async function verifyActionsToken(token: string): Promise<{ repo: string; runId: string }> {
	const { payload } = await jwtVerify(token, jwks, { issuer: ACTIONS_ISSUER, audience: SWARM_AUDIENCE }).catch(() => {
		throw new TokenError(401, "That isn't a GitHub Actions OIDC token for formal.team.");
	});
	const repo = String(payload.repository ?? "");
	const workflow = String(payload.job_workflow_ref ?? payload.workflow_ref ?? "");
	if (!repo || !workflow.startsWith(`${repo}/${SWARM_WORKFLOW}@`)) throw new TokenError(403, `Only ${SWARM_WORKFLOW} in the proofs repository itself gets swarm tokens.`);
	return { repo, runId: String(payload.run_id ?? "") };
}

/** A one-hour installation token for the proofs repository and, when it is on the same installation, its protocol. */
export async function mintGitHubToken(proofsRepo: string, protocol: string): Promise<string> {
	const [owner, name] = proofsRepo.split("/");
	const app = getAppOctokit();
	const { data: installation } = await app.request("GET /repos/{owner}/{repo}/installation", { owner, repo: name }).catch(() => {
		throw new TokenError(409, `The formalmind GitHub App isn't installed on ${proofsRepo}.`);
	});
	const repositories = [name];
	const [protocolOwner, protocolName] = protocol.split("/");
	if (protocolOwner?.toLowerCase() === owner.toLowerCase() && protocolName) repositories.push(protocolName);
	const { data } = await app.request("POST /app/installations/{installation_id}/access_tokens", { installation_id: installation.id, repositories });
	return data.token;
}

const MODEL_SESSION_S = 3 * 3600;
const sessionSecret = () => {
	const secret = process.env.OAUTH_SIGNING_KEY;
	if (!secret) throw new Error("OAUTH_SIGNING_KEY must be set");
	return new TextEncoder().encode(`model-session:${secret}`);
};

/** A three-hour key for the model proxy: which account pays, for which proofs repository and run. */
export async function mintModelSession(sub: string, repo: string, run: string): Promise<string> {
	return new SignJWT({ repo, run }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime(`${MODEL_SESSION_S}s`).setAudience("formal.team/model").sign(sessionSecret());
}

export async function verifyModelSession(key: string): Promise<{ sub: string; repo: string; run: string }> {
	const { payload } = await jwtVerify(key, sessionSecret(), { audience: "formal.team/model" }).catch(() => {
		throw new TokenError(401, "Invalid or expired formal.team model session.");
	});
	return { sub: String(payload.sub), repo: String(payload.repo), run: String(payload.run) };
}
