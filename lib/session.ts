/** A signed-in user's session. The browser only ever sees `user`; tokens stay on the Worker. */
export interface SessionData {
	user: {
		sub: string;
		name?: string;
		nickname?: string;
		email?: string;
		picture?: string;
		[claim: string]: unknown;
	};
	tokenSet: {
		accessToken: string;
		refreshToken?: string;
		idToken?: string;
		expiresAt: number;
	};
}
