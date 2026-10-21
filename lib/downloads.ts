/** The desktop app's downloads: the latest release's installer for each platform. */
const LATEST = "https://github.com/formalmind/formalmind/releases/latest/download";
export const MAC_DOWNLOAD = `${LATEST}/Formal-Mind-mac.dmg`;
export const WINDOWS_DOWNLOAD = `${LATEST}/Formal-Mind-windows-setup.exe`;

/** The download for this visitor: Windows on Windows, the (universal) Mac app otherwise. */
export function desktopDownload(): { os: "mac" | "windows"; href: string; label: string } {
	const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
	return windows ? { os: "windows", href: WINDOWS_DOWNLOAD, label: "Download for Windows" } : { os: "mac", href: MAC_DOWNLOAD, label: "Download for Mac" };
}
