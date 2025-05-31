import { Auth0AI } from "@auth0/ai-vercel";
import { auth0 } from "@/lib/auth0";

const auth0AI = new Auth0AI();

export const withGitHub = auth0AI.withTokenForConnection({
	connection: "github",
	scopes: ["repo"],
	refreshToken: async () => {
		const session = await auth0.getSession();
		const refreshToken = session?.tokenSet.refreshToken as string;

		return refreshToken;
	},
});
