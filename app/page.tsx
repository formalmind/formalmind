"use client";

import { useUser } from "@auth0/nextjs-auth0";
import { auth0 } from '@/lib/auth0'

export default async function Page() {
	const { user, isLoading } = useUser();
	let session;

	try {
		session = await auth0.getSession()
	} catch (error) {
		console.error("Failed to get session:", error)
		session = null;
	}
	if (isLoading) return <div>Loading...</div>;

	if (!user) {
		return (
			<main className="flex flex-col items-center justify-center h-screen p-10">
				<a href="/auth/login?screen_hint=signup">
					<button>Sign up</button>
				</a>
				<a href="/auth/login">
					<button>Log in</button>
				</a>
			</main>
		);
	}

	return (
		<main className="flex flex-col items-center justify-center h-screen p-10">
			<h1>Welcome, {user.name}!</h1>
			<p>
				<a href="/auth/logout">
					<button>Log out</button>
				</a>
			</p>
		</main>
	);
}
