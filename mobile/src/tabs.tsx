import { useNavigate } from "react-router";
import { Bug, Code2, House, ScanSearch } from "lucide-react";
import { TalkIcon } from "@/desktop/src/swarm-panel";
import { projectPath } from "@/components/projects/use-projects";

export type Tab = "home" | "code" | "proofs" | "bugs" | "chat";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
	{ id: "home", label: "Home", icon: House },
	{ id: "code", label: "Code", icon: Code2 },
	{ id: "proofs", label: "Proofs", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
	{ id: "chat", label: "Chat", icon: TalkIcon },
];

const LAST = "fm:last-project";

/** The project the tabs open from Home: the last one you looked at. */
export function lastProject(): string | null {
	try {
		return localStorage.getItem(LAST);
	} catch {
		return null;
	}
}

export function rememberProject(repo: string) {
	try {
		localStorage.setItem(LAST, repo);
	} catch {
		/* the tabs then open nothing from Home */
	}
}

/**
 * The tabs, floating over the page in a glass pill as iOS draws them; the page scrolls on under it. Code, Proofs, Bugs
 * and Chat are a project's (from Home, the last one opened; Chat without one is the Mac's whole swarm).
 */
export function TabBar({ active, repo }: { active: Tab; repo: string | null }) {
	const navigate = useNavigate();
	const go = (id: Tab) => {
		if (id === active) return;
		if (id === "home") return navigate("/");
		if (!repo) return navigate(id === "chat" ? "/mac" : "/");
		navigate(`${projectPath(repo)}?tab=${id}`);
	};
	return (
		<nav aria-label="Tabs" className="fm-safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center">
			<div className="fm-glass pointer-events-auto mb-1 flex items-center rounded-full p-1">
				{TABS.map(({ id, label, icon: Icon }) => {
					const off = !repo && (id === "code" || id === "proofs" || id === "bugs");
					return (
						<button
							key={id}
							type="button"
							disabled={off}
							onClick={() => go(id)}
							aria-current={id === active ? "page" : undefined}
							className={`flex h-12 w-[68px] flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] font-medium transition-colors disabled:opacity-35 ${id === active ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground active:bg-foreground/5"}`}
						>
							<Icon className="size-[21px]" strokeWidth={id === active ? 2.2 : 1.8} />
							{label}
						</button>
					);
				})}
			</div>
		</nav>
	);
}
