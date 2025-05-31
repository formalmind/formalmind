import { Octokit, RequestError } from "octokit";
import { getAccessTokenForConnection } from "@auth0/ai-vercel";
import { FederatedConnectionError } from "@auth0/ai/interrupts";
import { withGitHub } from "@/lib/auth0-ai";
import { tool } from "ai";
import { z } from "zod";


export const listRepositories = withGitHub(
	tool({
		description: "List respositories for the current user on GitHub",
		parameters: z.object({}),
		execute: async () => {
			// Get the access token from Auth0 AI
			const accessToken = getAccessTokenForConnection();

			// GitHub SDK
			try {
				const octokit = new Octokit({
					auth: accessToken,
				});

				const { data } = await octokit.rest.repos.listForAuthenticatedUser();

				return data.map((repo) => repo.name);
			} catch (error) {
				console.log("Error", error);

				if (error instanceof RequestError) {
					if (error.status === 401) {
						throw new FederatedConnectionError(
							`Authorization required to access the Federated Connection`
						);
					}
				}

				throw error;
			}
		},
	})
);
