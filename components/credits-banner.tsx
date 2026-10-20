import { useEffect, useState } from "react";
import { Link } from "react-router";

/** A thin bar over every signed-in page while the account has no credits: the swarm is paused until it does. */
export function CreditsBanner() {
	const [out, setOut] = useState(false);
	useEffect(() => {
		const look = () =>
			fetch("/api/billing/balance")
				.then((res) => (res.ok ? res.json() : null))
				.then((body: { configured?: boolean; cents?: number } | null) => setOut(Boolean(body?.configured && typeof body.cents === "number" && body.cents <= 0)))
				.catch(() => {});
		look();
		const timer = setInterval(look, 5 * 60 * 1000);
		return () => clearInterval(timer);
	}, []);
	if (!out) return null;
	return (
		<div role="status" className="flex shrink-0 items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
			<span>You're out of credits, so the swarm is paused.</span>
			<Link to="/billing" className="font-medium underline underline-offset-2">Add credits</Link>
		</div>
	);
}
