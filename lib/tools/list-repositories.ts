import { Octokit } from "octokit";
import { tool } from "ai";
import { z } from "zod";
import { aiSchema } from "@/lib/ai-schema";
import { auth } from "@/lib/auth";

export const listRepositories = tool({
	description: "List respositories for the current user on GitHub",
	parameters: aiSchema(z.object({})),
	execute: async () => {
		const octokit = new Octokit({ auth: await auth.getGitHubToken() });
		const { data } = await octokit.rest.repos.listForAuthenticatedUser();
		return data.map((repo) => repo.name);
	},
});
