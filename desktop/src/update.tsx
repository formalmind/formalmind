import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const HOUR = 60 * 60 * 1000;

/**
 * Checks for a new version on launch and every few hours (latest.json on the newest GitHub release, signed with the
 * key in tauri.conf.json). When one is out, a small card offers to install it and restart.
 */
export function UpdateNotice() {
	const [update, setUpdate] = useState<Update | null>(null);
	const [state, setState] = useState<"idle" | "installing" | "failed">("idle");
	const [hidden, setHidden] = useState(false);

	useEffect(() => {
		const look = () => void check().then((u) => u && setUpdate(u)).catch(() => {});
		look();
		const timer = setInterval(look, 6 * HOUR);
		return () => clearInterval(timer);
	}, []);

	if (!update || hidden) return null;
	const install = async () => {
		setState("installing");
		try {
			await update.downloadAndInstall();
			await relaunch();
		} catch {
			setState("failed");
		}
	};
	return (
		<div className="shadow-pop fixed bottom-4 right-4 z-50 w-72 rounded-xl bg-popover p-4 text-sm text-popover-foreground">
			<p className="font-medium">Formal Mind {update.version} is out</p>
			<p className="mt-1 text-muted-foreground">{state === "failed" ? "The update didn't install. Try again later." : "Install it now; the app restarts."}</p>
			<div className="mt-3 flex gap-2">
				<button type="button" onClick={() => void install()} disabled={state === "installing"} className="btn-dark h-8 px-3 disabled:opacity-60">
					{state === "installing" ? "Updating…" : "Update"}
				</button>
				<button type="button" onClick={() => setHidden(true)} className="btn-soft h-8 px-3">Later</button>
			</div>
		</div>
	);
}
