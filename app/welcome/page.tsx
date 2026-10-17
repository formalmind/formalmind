import { Landing } from "@/components/landing/landing";
import { auth0 } from "@/lib/auth0";

export const metadata = { title: "Formal Mind · Prove your Solidity correct" };

/** The landing page, for anyone; / shows it too when nobody is signed in. */
export default async function WelcomePage() {
	const session = await auth0.getSession();
	return <Landing signedIn={Boolean(session)} />;
}
