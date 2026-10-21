/** True inside the Mac app. */
export const inDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Pages that need the formal.team session (billing) open on the website: in the Mac app that's the default browser,
 * on the web it's this tab.
 */
export function openOnWeb(path: string) {
	if (!inDesktop()) {
		window.location.href = path;
		return;
	}
	void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(`https://formal.team${path}`));
}
