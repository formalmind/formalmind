import { useEffect } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { addNotification, dismissNotification, notify } from "@/lib/notifications";

const HOUR = 60 * 60 * 1000;
const ID = "app-update";
const INSTALL = "fm:install-update";

/**
 * Checks for a new version on launch and every few hours (latest.json on the newest GitHub release, signed with the
 * key in tauri.conf.json). A new version goes in the bell's list with an Update button: it toasts once, then waits
 * there until installed. Renders nothing itself.
 */
export function UpdateNotice() {
	useEffect(() => {
		let found: Update | null = null;
		const look = () =>
			void check()
				.then((u) => {
					if (!u) return void dismissNotification(ID); // already up to date: drop a notice left from before
					if (found?.version === u.version) return;
					found = u;
					addNotification({
						id: ID,
						variant: "info",
						title: `Formal Mind ${u.version} is ready`,
						description: "Update and restart to get it.",
						action: { label: "Update", event: INSTALL },
					});
				})
				.catch(() => {});
		const install = async () => {
			if (!found) return;
			notify.info("Updating Formal Mind…", { id: ID });
			try {
				await found.downloadAndInstall();
				await relaunch();
			} catch {
				addNotification({ id: ID, variant: "error", title: "The update didn't install", description: "Try again in a bit.", action: { label: "Retry", event: INSTALL } });
			}
		};
		look();
		const timer = setInterval(look, 6 * HOUR);
		window.addEventListener(INSTALL, install);
		return () => {
			clearInterval(timer);
			window.removeEventListener(INSTALL, install);
		};
	}, []);
	return null;
}
