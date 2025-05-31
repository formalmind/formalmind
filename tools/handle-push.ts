import { PROMPTS } from "@/github-actions";
import { VerificationAgent } from "@/packages/agentkit/base-agent";
import { buildFileDiffs } from "./helpers";
import { redis } from "@/lib/redis"

/* NOTE: Implement the handleCheckPushEvent function
 * Handles push events to check for new commits and trigger the verification agent.
 * @param octokit - The Octokit instance for making API requests.
 * @param payload - The payload of the push event containing commit details.
 * @return A promise that resolves when the push event is processed.
 * */
export async function handlePushEvent({ octokit, payload }: any) {
	const { _ref, commits, repository, sender } = payload;
	const owner = repository.owner.login;
	const repo = repository.name;

	const latestCommit = commits[commits.length - 1];
	const commitSha = latestCommit.id;

	const { data: commitData } = await octokit.request(
		'GET /repos/{owner}/{repo}/commits/{commit_sha}',
		{ owner, repo, commit_sha: commitSha }
	);

	const fileDiffs = buildFileDiffs(commitData.files);

	const agent = new VerificationAgent(PROMPTS.pushReviewer);
	await agent.init();

	const agentOutput = await agent.getResponse(
		agent.formatInput({
			fileDiffs,
			username: sender.login,
			userPrompt: latestCommit.message,
		})
	);

	console.log(`🧠 Push Reviewer Agent response: ${agentOutput}`);

	await handleDetailedPushReview(octokit, owner, repo, commitSha, agentOutput, payload);

	await redis.lpush(`events:${payload.installation?.id}`, JSON.stringify({
		type: "push", // like 'push' or 'pull_request'
		data: payload,
		receivedAt: Date.now(),
	}))
}


/**
	* NOTE: This function is used to handle detailed line review comments from the agent.
	* Handles detailed line review comments from the agent.
	* @param octokit - The Octokit instance for making API requests.
	* @param owner - The repository owner.
	* @param repo - The repository name.
	* @param commitSha - The SHA of the commit to comment on.
	* @param agentOutput - The output from the agent containing comments in JSON format.
	* @return A promise that resolves when all comments are processed.
	*/
export async function handleDetailedPushReview(
	octokit: any,
	owner: string,
	repo: string,
	commitSha: string,
	agentOutput: string,
	payload?: any
) {
	const jsonMatch = agentOutput.match(/```json\n([\s\S]*?)\n```/);

	if (!jsonMatch || jsonMatch.length < 2) {
		console.error('Agent response does not contain a valid JSON code block.');
		return;
	}

	let comments;
	try {
		comments = JSON.parse(jsonMatch[1].trim());
	} catch (e) {
		console.error('Failed to parse JSON from agent response:', e);
		return;
	}

	for (const comment of comments) {
		if (typeof comment.position !== 'number') {
			console.warn(`Skipping comment due to missing or invalid position:`, comment);
			continue;
		}

		try {
			await octokit.request('POST /repos/{owner}/{repo}/commits/{commit_sha}/comments', {
				owner,
				repo,
				commit_sha: commitSha,
				path: comment.file,
				position: comment.position,
				body: comment.comment,
				headers: {
					'x-github-api-version': '2022-11-28',
				},
			});

			console.log(`✅ Commented on ${comment.file} at position ${comment.position}`);

			await redis.lpush(`events:${payload.installation?.id}`, JSON.stringify({
				type: "review_comment",
				data: payload,
				receivedAt: Date.now(),
			}))
		} catch (err) {
			console.error(`Failed to comment on ${comment.file} at position ${comment.position}`, err);
		}

	}
}
