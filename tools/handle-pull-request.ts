
import { PROMPTS } from "@/github-actions";
import { VerificationAgent } from "@/packages/agentkit/base-agent";
import { buildFileDiffs, extractJsonCodeBlock } from "./helpers";
import { redis } from "@/lib/redis"

/**
 * NOTE: This function handles the pull request opened event.
 * It fetches the PR file changes, builds diffs, and sends a response using the VerificationAgent.
 * @param octokit - The Octokit instance for making API requests.
 * @param payload - The payload of the pull request event containing PR details.
 * @return A promise that resolves when the PR is processed.
 */
export async function handlePullRequestOpened({ octokit, payload }: any) {
	const prNumber = payload.pull_request.number;
	console.log(`Received a pull request event for #${prNumber}`);

	const { login: owner } = payload.repository.owner;
	const repo = payload.repository.name;

	// Fetch PR file changes
	const { data: files } = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
		{ owner, repo, pull_number: prNumber }
	);

	const fileDiffs = buildFileDiffs(files);
	const agent = new VerificationAgent(PROMPTS.modeling);
	await agent.init(); // Ensure prompt is loaded before use

	const username = payload.sender.login;
	const userPrompt = payload.pull_request.body || "";

	console.log(`${username} opened PR #${prNumber}`);
	console.log("🧠 Prompt token length:", agent.prompt.length);
	console.log(`🧠 Sending prompt to OpenAI... ${process.env.OPENAI_API_KEY ? "✅" : "❌"}`);

	const reply = await agent.getResponse(agent.formatInput({ fileDiffs, username, userPrompt }));
	console.log(`🤖 AI response: ${reply.slice(0, 1000)}...`);

	// Post comment to PR
	await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
		owner,
		repo,
		issue_number: prNumber,
		body: reply,
		headers: {
			"x-github-api-version": "2022-11-28",
		},
	});

	await handlePullRequestReview({ octokit, payload });

	await redis.lpush(`events:${payload.installation?.id}`, JSON.stringify({
		type: "pull_request",
		data: payload,
		receivedAt: Date.now(),
	}))
}

export async function handlePullRequestReview({ octokit, payload }: any) {
	const prNumber = payload.pull_request.number;
	const { login: owner } = payload.repository.owner;
	const repo = payload.repository.name;
	const commitSha = payload.pull_request.head.sha;

	const { data: files } = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
		{ owner, repo, pull_number: prNumber }
	);

	const fileDiffs = buildFileDiffs(files);
	const agent = new VerificationAgent(PROMPTS.prReviewer);
	await agent.init();

	const username = payload.sender.login;
	const userPrompt = payload.pull_request.body || "";

	const agentOutput = await agent.getResponse(agent.formatInput({ fileDiffs, username, userPrompt }));
	console.log(`🧠 PR Reviewer Agent response: ${agentOutput}`);

	const jsonBlock = extractJsonCodeBlock(agentOutput);
	if (!jsonBlock) {
		console.error("No valid JSON block found in agent output.");
		return;
	}
	let comments;
	try {
		comments = JSON.parse(jsonBlock);
	} catch (e) {
		console.error('Failed to parse JSON from agent output:', e);
		return;
	}


	for (const comment of comments) {
		if (
			typeof comment.file !== 'string' ||
			typeof comment.line !== 'number' ||
			typeof comment.comment !== 'string'
		) {
			console.warn(`❌ Skipping invalid comment entry:`, comment);
			continue;
		}
		try {
			await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
				owner,
				repo,
				pull_number: prNumber,
				commit_id: commitSha,
				path: comment.file,
				start_line: comment.start_line,
				line: comment.line,
				start_side: comment.start_side,
				side: comment.side,
				body: comment.comment,
				headers: {
					'x-github-api-version': '2022-11-28',
				},
			});

			console.log(`✅ Commented on ${comment.file}:${comment.line}`);
			await redis.lpush(`events:${payload.installation?.id}`, JSON.stringify({
				type: "review_comment",
				data: payload,
				receivedAt: Date.now(),
			}))
		} catch (err) {
			console.error(`❌ Failed to comment on ${comment.file}:${comment.line}`, err);
		}
	}
}

