import { addNotification } from "@/lib/notifications";

/**
 * An error the user should see and be able to hand over: it goes to the notification bell (with Copy), and in the
 * Mac app it is appended to ~/Library/Logs/Formal Mind/errors.log. The same error repeated within a few seconds
 * notifies once.
 */
const recent = new Map<string, number>();

export function reportError(source: string, error: unknown) {
	const message = error instanceof Error ? (error.stack ?? error.message) : typeof error === "string" ? error : JSON.stringify(error);
	if (!message) return;
	const key = `${source}\n${message}`;
	const now = Date.now();
	if (now - (recent.get(key) ?? 0) < 5000) return;
	recent.set(key, now);
	addNotification({ variant: "error", title: source, description: message.length > 600 ? `${message.slice(0, 600)}…` : message, copy: `${source}: ${message}` });
	if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
		void import("@tauri-apps/api/core").then(({ invoke }) => invoke("log_error", { source, message })).catch(() => undefined);
	}
}

/** Uncaught errors and rejections anywhere in the page. */
export function reportUncaught() {
	if (typeof window === "undefined") return;
	window.addEventListener("error", (e) => reportError("Unexpected error", e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => reportError("Unexpected error", e.reason));
}
