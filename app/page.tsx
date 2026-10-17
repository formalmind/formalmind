import { Landing } from "@/components/landing/landing";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { auth0 } from "@/lib/auth0";
import { SWARM_REPO } from "@/lib/swarm";

export const metadata = { title: "Formal Mind" };

/** Signed in: the swarm. Signed out: the landing page. */
export default async function HomePage() {
	const session = await auth0.getSession();
	return session ? <SwarmWorkspace repo={SWARM_REPO} /> : <Landing signedIn={false} />;
}
