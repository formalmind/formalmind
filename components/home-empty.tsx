import type { ReactNode } from "react";

/**
 * The home page: an empty screen with the one next step (open or add a folder, or pick a project), instead of the
 * swarm canvas, which lives at /swarm. The headline is the onboarding's: a muted line over a strong one, in the
 * display face.
 */
export function HomeEmpty({ muted, strong, hint, children }: { muted: string; strong: string; hint?: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6">
			<div className="flex w-full max-w-lg flex-col items-center text-center">
				<h1 className="fm-rise font-display text-5xl leading-[1.05] [animation-delay:80ms]">
					<span className="text-muted-foreground/70">{muted}</span>
					<br />
					{strong}
				</h1>
				{hint ? <p className="fm-rise mt-5 text-sm leading-6 text-muted-foreground [animation-delay:160ms]">{hint}</p> : null}
				{children ? <div className="fm-rise mt-8 w-full max-w-sm [animation-delay:220ms]">{children}</div> : null}
			</div>
		</div>
	);
}
