import dotenv from "dotenv";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import http from "http";

dotenv.config();

const appId = process.env.GITHUB_APP_ID!;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET!;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

const app = new App({
	appId: appId,
	privateKey: privateKey,
	webhooks: {
		secret: webhookSecret
	},
});

const messageForNewPRs = "Thanks for opening a new PR! Please follow our contributing guidelines to make your PR easier to review.";
// const messageForNewPRs = `Thanks for opening a new PR! Please follow our contributing guidelines to make your PR easier to review.
//
// Want me to add a proof for the new function you added?
//
// \`\`\`py
// def prove_this(name: str):
//   if name == "agent":
//     return true
//   else:
//     return false
// \`\`\`
//
// ### Suggestion
//
// We need to add the types to you function first to this
//
// - Add return type
//
// \`\`\`py
//
// def prove_this(name: str) -> bool:
//   if name == "agent":
//     return true
//   else:
//     return false
// \`\`\`
//
// @mmsaki Do you want me to add function description to help the formal agent have context about what this function does?
//
// Here's what I can help with:
//
// - [ ] Add desctiption
// - [ ] Add function signature
// - [ ] Create formal proof scaffolds
// `;
//

async function handlePullRequestOpened({ octokit, payload }: any) {
	console.log(`Received a pull request event for #${payload.pull_request.number}`);

	try {
		await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issue_number: payload.pull_request.number,
			body: messageForNewPRs,
			headers: {
				"x-github-api-version": "2022-11-28",
			},
		});
	} catch (error: any) {
		if (error.response) {
			console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
		}
		console.error(error)
	}
};

app.webhooks.on("pull_request.opened", handlePullRequestOpened);

// This logs any errors that occur.
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
	console.log('Press Ctrl + C to quit.')
});
