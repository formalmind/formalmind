import type { SwarmRole } from "@/lib/swarm";

/** A short burst of life on an agent's cursor: a circle dance, a hop, a wiggle, or a zoom around and back. */
export type CursorMood = "dance" | "hop" | "wiggle" | "zoom";
const MOODS: CursorMood[] = ["dance", "hop", "wiggle", "zoom"];
const EVENT = "fm:cursor-mood";

/** Plays a mood on every cursor of `role` on the page; anywhere can call it (a chat reply, a new card). */
export function cheer(role: SwarmRole, mood?: CursorMood) {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { role, mood } }));
}

/** Applies one mood straight to the cursor's body, then clears it, so the canvas never re-renders for it. */
export function playMood(root: ParentNode, role: SwarmRole, mood: CursorMood = MOODS[Math.floor(Math.random() * MOODS.length)]) {
	for (const body of root.querySelectorAll<HTMLElement>(`[data-cursor="${role}"] [data-cursor-body]`)) {
		if (body.classList.contains("fm-thinking")) continue;
		const cls = `fm-mood-${mood}`;
		body.classList.remove(...MOODS.map((m) => `fm-mood-${m}`));
		void body.offsetWidth;
		body.classList.add(cls);
		body.addEventListener("animationend", () => body.classList.remove(cls), { once: true });
	}
}

export function onCheer(listener: (role: SwarmRole, mood?: CursorMood) => void) {
	const handle = (e: Event) => {
		const { role, mood } = (e as CustomEvent<{ role: SwarmRole; mood?: CursorMood }>).detail;
		listener(role, mood);
	};
	window.addEventListener(EVENT, handle);
	return () => window.removeEventListener(EVENT, handle);
}
