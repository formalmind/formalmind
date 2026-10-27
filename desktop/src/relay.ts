/**
 * Settings → Phone: the relay through formal.team, which the phone and agents through the MCP use to follow and drive
 * this Mac. The relay itself runs in the backend (src-tauri/src/relay.rs) for as long as the app runs; this is the
 * switch's value as the page keeps it, synced to the backend's settings (api.ts `syncSettings`).
 */
export const relayOn = () => {
	try {
		return localStorage.getItem("fm:relay") !== "0";
	} catch {
		return true;
	}
};
