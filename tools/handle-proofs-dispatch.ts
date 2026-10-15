import { redis } from "@/lib/redis";

/**
 * Formal-mind bot bridge: forward a protocol `push` (delivered to this GitHub App) to the
 * proofs repository as a `repository_dispatch`, which runs `.github/workflows/formal-mind.yml`
 * in asyncswap/v2-proofs. The GitHub App must be installed on the proofs repository with
 * `contents: write`.
 *
 * Which protocol repositories feed which proofs repository is configured here so the App can
 * serve several protocols.
 */
export const PROOFS_TARGETS: Record<string, { owner: string; repo: string }> = {
	"asyncswap/v2": { owner: "asyncswap", repo: "v2-proofs" },
	"asyncswap/protocol": { owner: "asyncswap", repo: "v2-proofs" },
};

export async function handleProofsDispatch({ octokit, payload }: any) {
	const full = payload.repository?.full_name as string | undefined;
	if (!full) return;
	const target = PROOFS_TARGETS[full];
	if (!target) return;

	const sha = payload.after as string;
	const message = payload.head_commit?.message ?? "";
	const touchesSources = (payload.commits ?? []).some((c: any) =>
		[...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f: string) =>
			f.startsWith("src/") || f.startsWith("test/")
		)
	);
	if (!touchesSources) return;

	await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
		owner: target.owner,
		repo: target.repo,
		event_type: "protocol-push",
		client_payload: { repo: full, sha, message },
		headers: { "X-GitHub-Api-Version": "2022-11-28" },
	});

	await redis.lpush(
		`events:${payload.installation?.id}`,
		JSON.stringify({ type: "proofs_dispatch", data: { repo: full, sha, target }, receivedAt: Date.now() })
	);
	console.log(`🧠 formal-mind: dispatched ${full}@${sha.slice(0, 7)} → ${target.owner}/${target.repo}`);
}
