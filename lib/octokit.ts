import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/** DER length: short form under 128, else 0x80 | byte count, then the bytes. */
function derLength(n: number): number[] {
	if (n < 0x80) return [n];
	const bytes: number[] = [];
	for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub hands out App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but the JWT signer Octokit uses on Workers only
 * takes PKCS#8 ("BEGIN PRIVATE KEY"). Wrap the PKCS#1 key in the PKCS#8 envelope; PKCS#8 keys pass through.
 */
export function toPkcs8(pem: string): string {
	if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;
	const body = pem.replace(/-----(BEGIN|END) RSA PRIVATE KEY-----/g, "").replace(/\s+/g, "");
	const pkcs1 = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	// version 0, AlgorithmIdentifier rsaEncryption with NULL parameters, then the PKCS#1 key as an OCTET STRING.
	const version = [0x02, 0x01, 0x00];
	const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const octets = [0x04, ...derLength(pkcs1.length)];
	const inner = version.length + algorithm.length + octets.length + pkcs1.length;
	const der = new Uint8Array([0x30, ...derLength(inner), ...version, ...algorithm, ...octets, ...pkcs1]);
	let binary = "";
	for (const byte of der) binary += String.fromCharCode(byte);
	const b64 = btoa(binary).match(/.{1,64}/g)!.join("\n");
	return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

// Read at call time, not import time: secrets are only present when a request runs
// (Cloudflare Workers), and a build without them must still succeed.
export function getAppOctokit() {
	const appId = process.env.GITHUB_APP_ID;
	const pem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
	const privateKey = pem ? toPkcs8(pem) : undefined;
	if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId,
			privateKey,
		},
	});
	return octokit;
}

export async function findInstallationForUser(githubLogin: string): Promise<number | null> {
	const octokit = getAppOctokit()
	const { data: installations } = await octokit.request('GET /app/installations')
	const match = installations.find(inst => inst.account?.login === githubLogin)
	return match?.id ?? null
}
