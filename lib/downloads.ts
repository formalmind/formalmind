/** The desktop app's downloads: the latest release's installer for each platform. */
const LATEST = "https://github.com/formalmind/releases/releases/latest/download";
export const MAC_DOWNLOAD = `${LATEST}/Formal-Mind-mac.dmg`;
export const WINDOWS_DOWNLOAD = `${LATEST}/Formal-Mind-windows-setup.exe`;

/** The download for this visitor: Windows on Windows, the (universal) Mac app otherwise. */
export function desktopDownload(): { os: "mac" | "windows"; href: string; label: string } {
	const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
	return windows ? { os: "windows", href: WINDOWS_DOWNLOAD, label: "Download for Windows" } : { os: "mac", href: MAC_DOWNLOAD, label: "Download for Mac" };
}

/**
 * Formal Mind for iPhone on the App Store; null until it's published there (App Store Connect is set up by hand).
 * Phones visiting the website are offered it (components/get-the-app.tsx).
 */
export const IPHONE_APP: string | null = null;
