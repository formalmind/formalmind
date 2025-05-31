import dotenv from "dotenv";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import http from "http";
import { handlePushEvent } from "./tools/handle-push";
import { handlePullRequestOpened } from "./tools/handle-pull-request";
import { extractJsonCodeBlock, extractLeanCodeBlock } from "./tools/helpers";
import { TemplateRepoWriterAgent } from "./tools/repo-writer";

dotenv.config();

const appId = process.env.GITHUB_APP_ID!;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET!;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

export const PROMPTS = {
	modeling: "app/agents/modeling-agent/page.md",
	prReviewer: "app/agents/pr-reviewer-agent/page.md",
	pushReviewer: "app/agents/push-reviewer-agent/page.md",
	reconsilingAgent: "app/agents/reconsiling-agent/page.md",
	testing: "app/agents/testing-agent/page.md",
	testingV1: "app/agents/testing-agent-v1/page.md",
	verification: "app/agents/verification-agent/page.md",
};

const app = new App({
	appId: appId,
	privateKey: privateKey,
	webhooks: {
		secret: webhookSecret
	},
});


app.webhooks.on("pull_request.opened", handlePullRequestOpened);
app.webhooks.on("push", handlePushEvent);
app.webhooks.on('issue_comment.created', async ({ octokit, payload }) => {
	const comment = payload.comment.body;
	const repo = payload.repository.name;
	const owner = payload.repository.owner.login;

	// Only handle `@agent verify` directives
	if (!comment.includes('@agent verify')) return;

	// Extract Lean + JSON
	const lean = extractLeanCodeBlock(comment);
	const json = extractJsonCodeBlock(comment);

	if (!lean && !json) {
		console.warn("❌ No Lean or JSON code found in comment.");
		return;
	}

	// Determine repo name and user who sent the comment
	const sender = payload.sender.login;
	const targetRepo = `modeling-${repo}-${sender}`

	// Create + run the TemplateRepoWriterAgent
	const agent = new TemplateRepoWriterAgent({
		octokit,
		targetOwner: sender, // ⬅️ this user must have your GitHub App installed!
		targetRepo,
		commentBody: comment,
		meta: {
			commitSha: payload.comment.node_id, // optional
			pullNumber: payload.issue?.number,
		}
	});

	await agent.run(); // ⬅️ This handles: check repo, create from template, write files, commit, push
});

app.webhooks.onError((error) => {
	if (error.name === "AggregateError") {
		console.error(`Error processing request: ${error.event}`);
	} else {
		console.error(error);
	}
});

const port = 3003;
const host = 'localhost';
const path = "/api/webhook";
const localWebhookUrl = `http://${host}:${port}${path}`;

const middleware = createNodeMiddleware(app.webhooks, { path });

http.createServer(middleware).listen(port, () => {
	console.log(`Server is listening for events at: ${localWebhookUrl}`);
	console.log('Press Ctrl + C to quit.');
});
