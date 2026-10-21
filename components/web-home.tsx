import { useState } from "react";
import { useSearchParams } from "react-router";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";

/**
 * The website's home: pick a project in the sidebar, or add one here; the card takes the headline's place. `?add=1`
 * opens it (where Get started on the landing page lands, after sign-in), and `?add=owner/name` opens it on that
 * repository (one planned on the landing page).
 */
export function WebHome() {
	const [params, setParams] = useSearchParams();
	const asked = params.get("add");
	const [adding, setAdding] = useState(asked !== null);
	const close = () => {
		setAdding(false);
		if (asked !== null) setParams({}, { replace: true });
	};
	if (adding)
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<div className="fm-rise w-full max-w-md">
					<AddProjectCard onCancel={close} initialRepo={asked && asked !== "1" ? asked : undefined} />
				</div>
			</div>
		);
	return (
		<HomeEmpty
			muted="Bugs, proofs and code."
			strong="Pick a project to start."
			hint={
				<>
					Choose one in the sidebar, or{" "}
					<button type="button" onClick={() => setAdding(true)} className="underline underline-offset-2">
						add one
					</button>
					.
				</>
			}
		/>
	);
}
