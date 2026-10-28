import { Bug, Code2, Network, ScanSearch } from "lucide-react";
import type { Mode } from "./swarm-panel";

/** A filled speech bubble with two lines cut out of it: the "Talk to the swarm" mark. */
export function TalkIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" className={className} aria-hidden>
			<path
				fillRule="evenodd"
				fill="currentColor"
				d="M4 1h8a3.5 3.5 0 0 1 3.5 3.5v4A3.5 3.5 0 0 1 12 12H8.2l-3.9 2.6A.8.8 0 0 1 3 13.9V12h0A3.5 3.5 0 0 1 .5 8.5v-4A3.5 3.5 0 0 1 4 1Zm.6 4a.7.7 0 0 0 0 1.4h6.8a.7.7 0 0 0 0-1.4H4.6Zm1.4 2.8a.7.7 0 0 0 0 1.4h4a.7.7 0 0 0 0-1.4H6Z"
			/>
		</svg>
	);
}

/** What a folder's right pane can show, in the title bar's order: on a folder page and, opening the last folder, on
 * every other page (Settings, Home). */
export const PANE_VIEWS: { id: Mode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
	{ id: "chat", label: "Chat", icon: TalkIcon },
	{ id: "swarm", label: "Canvas", icon: Network },
	{ id: "audit", label: "Proofs", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
	{ id: "code", label: "Code", icon: Code2 },
];
