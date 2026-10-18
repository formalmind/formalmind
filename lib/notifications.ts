import { useSyncExternalStore } from "react";

/**
 * The notification store behind the bell, ported from Async Swap's `@asyncswap/ui`
 * (notification-store.ts + notify.tsx), with plain-text content only. A new notice shows
 * briefly as a toast, then stays in the bell's unread list and, once read, its history.
 * History lives in this browser: at most 99 entries, each kept 90 days.
 */

export type NotificationVariant = "info" | "success" | "error" | "warning";

export interface StoreNotification {
	id: string | number;
	title: string;
	description?: string;
	variant: NotificationVariant;
	/** When it was (re)fired; relative time and the toast window derive from it. */
	createdAt: number;
	/** How long it shows as a toast; 0 for entries restored from storage. */
	duration: number;
	read?: boolean;
}

export const RETAIN_MAX = 99;
const STORAGE_KEY = "formalmind.notifications.v1";
const HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const DEFAULT_DURATION: Record<NotificationVariant, number> = { info: 4500, success: 4500, warning: 6000, error: 8000 };

function readStored(): StoreNotification[] {
	if (typeof window === "undefined") return [];
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		const now = Date.now();
		return parsed
			.filter(
				(n): n is StoreNotification =>
					n && typeof n === "object" && typeof n.title === "string" && typeof n.createdAt === "number" &&
					now - n.createdAt >= 0 && now - n.createdAt < HISTORY_TTL_MS &&
					["info", "success", "error", "warning"].includes(n.variant),
			)
			.map((n) => ({ ...n, duration: 0 }))
			.slice(0, RETAIN_MAX);
	} catch {
		return [];
	}
}

let items: StoreNotification[] = readStored();
const listeners = new Set<() => void>();
let seq = 0;

function emit(persist = true) {
	items = items.slice();
	if (persist) {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, RETAIN_MAX)));
		} catch {
			// Storage may be disabled or full; notifications still work in memory.
		}
	}
	for (const l of listeners) l();
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === STORAGE_KEY) {
			items = readStored();
			emit(false);
		}
	});
}

export function addNotification(input: Omit<StoreNotification, "id" | "createdAt" | "duration"> & { id?: string | number; duration?: number }) {
	const fresh = { ...input, id: input.id ?? `n${Date.now()}-${++seq}`, createdAt: Date.now(), duration: input.duration ?? DEFAULT_DURATION[input.variant], read: false };
	// Re-firing an explicit id replaces that notice in place (and makes it unread again).
	const idx = input.id === undefined ? -1 : items.findIndex((n) => n.id === input.id);
	if (idx !== -1) items[idx] = fresh;
	else items = [fresh, ...items].slice(0, RETAIN_MAX);
	emit();
	return fresh.id;
}

/** Permanently remove one notification, or clear the history. */
export function dismissNotification(id?: string | number) {
	const next = id === undefined ? [] : items.filter((n) => n.id !== id);
	if (next.length !== items.length) {
		items = next;
		emit();
	}
}

/** Move one notification from the unread list into read history. */
export function markNotificationRead(id: string | number) {
	const idx = items.findIndex((n) => n.id === id);
	if (idx === -1 || items[idx].read) return;
	items[idx] = { ...items[idx], read: true };
	emit();
}

export function useNotifications(): StoreNotification[] {
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		() => items,
		() => items,
	);
}

type Options = { description?: string; id?: string | number; duration?: number };
const fire = (variant: NotificationVariant) => (title: string, options: Options = {}) => addNotification({ title, variant, ...options });

/** The one way the app raises a notification. */
export const notify = {
	info: fire("info"),
	success: fire("success"),
	warning: fire("warning"),
	error: fire("error"),
	dismiss: dismissNotification,
};
