import { emitEvent, Delivery } from "@/lib/eventBus";
import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "@octokit/core";
import { NextRequest } from "next/server";
import crypto from "crypto";
import { createAppAuth } from "@octokit/auth-app"

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET!;
const appId = process.env.GITHUB_APP_ID!;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

// Create Webhooks instance
const webhooks = new Webhooks({
	secret: webhookSecret,
});

// Add listener for PRs
webhooks.on("pull_request.opened", async ({ payload }) => {
	console.log(`🎯 Received pull_request.opened for PR #${payload.pull_request.number}`);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId,
			privateKey,
			installationId: payload?.installation?.id,
		},
	});

	const message = `Thanks for opening a new PR! Please follow our contributing guidelines to make your PR easier to review.`;

	try {
		await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
			owner: payload.repository.owner.login,
			repo: payload.repository.name,
			issue_number: payload.pull_request.number,
			body: message,
			headers: {
				"x-github-api-version": "2022-11-28",
			},
		});
		console.log(`✅ Comment posted on PR #${payload.pull_request.number}`);
	} catch (error) {
		logError(error, "Error posting comment")
	}
});

// Export Next.js App Router route
export async function POST(request: NextRequest) {
	const path = "api/github/webhook/route.ts";

	try {
		const signature = request.headers.get("x-hub-signature-256") ?? "";
		const payload = await request.text();

		// Validate signature manually (needed because Octokit expects raw req)
		const hmac = crypto.createHmac("sha256", webhookSecret);
		const digest = `sha256=${hmac.update(payload).digest("hex")}`;

		if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
			console.warn(`${path} — Signature mismatch`);
			return new Response("Invalid signature", { status: 401 });
		}

		// Pass to Octokit's webhook handler
		await webhooks.verifyAndReceive({
			id: request.headers.get("x-github-delivery")!,
			name: request.headers.get("x-github-event")!,
			signature,
			payload,
		});

		// redis
		const raw = await request.text();
		const headers = Object.fromEntries(request.headers.entries());

		const delivery = {
			headers,
			body: JSON.parse(raw),
			rawdata: raw,
			timestamp: Date.now(),
		};

		// Emit to default channel, or customize per repo
		emitEvent("default", delivery as Delivery);

		return new Response("Webhook handled", { status: 200 });
	} catch (error) {
		logError(error, `${path} — Webhook error:`);
		return new Response("Webhook error", { status: 500 });
	}
}

function logError(error: unknown, context: string) {
	if (error instanceof Error) {
		console.error(`❌ ${context}:`, error.message);
	} else {
		console.error(`❌ ${context}:`, error);
	}
}
