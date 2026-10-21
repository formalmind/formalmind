import { useState } from "react";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";

/** The website's home: pick a project in the sidebar, or add one here; the card takes the headline's place. */
export function WebHome() {
	const [adding, setAdding] = useState(false);
	if (adding)
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<div className="fm-rise w-full max-w-md">
					<AddProjectCard onCancel={() => setAdding(false)} />
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
