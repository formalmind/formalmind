import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { listen } from "@tauri-apps/api/event";
import { Gauge, HardDrive, Network, PanelLeft, Plus, RefreshCw, Settings, X, type LucideIcon } from "lucide-react";
import { NotificationCenter } from "@/components/notification-center";
import { useSidebar } from "@/components/ui/sidebar";
import { PANE_VIEWS } from "./pane-views";

type Tab = { id: string; path: string };

const KEY = "fm:tabs";
/** The folder last open in any tab: the title bar's views open it from pages that have no folder of their own. */
const LAST_FOLDER = "fm:last-folder";
const newId = () => Math.random().toString(36).slice(2, 10);

/** What a tab shows for the page it's on. */
function describe(path: string): { title: string; icon: LucideIcon } {
	const [pathname, search = ""] = path.split("?");
	if (pathname === "/usage") return { title: "Usage", icon: Gauge };
	if (pathname === "/settings") return { title: "Settings", icon: Settings };
	if (pathname === "/local") {
		const folder = new URLSearchParams(search).get("path") ?? "";
		return { title: folder.split(/[\\/]/).filter(Boolean).pop() ?? "Folder", icon: HardDrive };
	}
	if (pathname.startsWith("/projects/")) return { title: pathname.split("/")[3] ?? "Project", icon: Network };
	return { title: "Home", icon: HardDrive };
}

function load(): { tabs: Tab[]; active: string } {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { tabs: Tab[]; active: string } | null;
		if (saved?.tabs.length && saved.tabs.some((t) => t.id === saved.active)) return saved;
	} catch {
		/* start fresh */
	}
	const id = newId();
	return { tabs: [{ id, path: "/" }], active: id };
}

/**
 * The title bar: window buttons on the left (drawn by macOS), then the sidebar toggle and one tab per open page.
 * The active tab follows wherever you navigate; switching tabs goes back to that tab's page.
 */
export function TabBar() {
	const location = useLocation();
	const navigate = useNavigate();
	const { toggleSidebar } = useSidebar();
	const [state, setState] = useState(load);
	const here = location.pathname + location.search;
	// A page with its own tab group (a folder's modes and name) fills the slot; that group is then its tab, so the
	// active tab isn't drawn a second time.
	const [grouped, setGrouped] = useState(false);
	useEffect(() => {
		const slot = document.getElementById("fm-titlebar-slot");
		if (!slot) return;
		const look = () => setGrouped(slot.childElementCount > 0);
		look();
		const mo = new MutationObserver(look);
		mo.observe(slot, { childList: true });
		return () => mo.disconnect();
	}, []);

	const [lastFolder, setLastFolder] = useState(() => {
		try {
			return localStorage.getItem(LAST_FOLDER) ?? "";
		} catch {
			return "";
		}
	});
	const onFolder = location.pathname === "/local";
	useEffect(() => {
		const folder = onFolder ? new URLSearchParams(location.search).get("path") : null;
		if (!folder) return;
		setLastFolder(folder);
		try {
			localStorage.setItem(LAST_FOLDER, folder);
		} catch {
			/* only for this run */
		}
	}, [onFolder, location.search]);

	// The page changed (sidebar link, in-page link): the active tab is now there.
	useEffect(() => {
		setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === s.active ? { ...t, path: here } : t)) }));
	}, [here]);
	useEffect(() => {
		try {
			localStorage.setItem(KEY, JSON.stringify(state));
		} catch {
			/* tabs just won't survive a restart */
		}
	}, [state]);
	// Open the saved active tab's page on launch.
	useEffect(() => {
		const active = state.tabs.find((t) => t.id === state.active);
		if (active && active.path !== here) navigate(active.path, { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const select = (tab: Tab) => {
		setState((s) => ({ ...s, active: tab.id }));
		navigate(tab.path);
	};
	const add = () => {
		const tab = { id: newId(), path: "/" };
		setState((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
		navigate("/");
	};
	const close = (tab: Tab) => {
		const i = state.tabs.findIndex((t) => t.id === tab.id);
		const rest = state.tabs.filter((t) => t.id !== tab.id);
		if (!rest.length) return add();
		if (tab.id === state.active) {
			const next = rest[Math.max(0, i - 1)];
			setState({ tabs: rest, active: next.id });
			navigate(next.path);
		} else setState((s) => ({ ...s, tabs: rest }));
	};

	// Settings… (⌘,) in the app menu.
	useEffect(() => {
		const off = listen("fm:settings", () => navigate("/settings"));
		return () => void off.then((f) => f());
	}, [navigate]);

	// ⌘T new tab, ⌘W close the current one.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.metaKey && !e.ctrlKey) return;
			if (e.key === "t") {
				e.preventDefault();
				add();
			} else if (e.key === "w") {
				e.preventDefault();
				const active = state.tabs.find((t) => t.id === state.active);
				if (active) close(active);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<div data-tauri-drag-region className="fm-titlebar fixed inset-x-0 top-0 z-50 flex h-10 items-center gap-1 bg-sidebar pl-[84px] pr-3">
			<button type="button" onClick={toggleSidebar} title="Toggle sidebar" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
				<PanelLeft className="size-4" />
			</button>
			<div className="mx-1 h-4 w-px shrink-0 bg-border" />
			{/* A page's own controls (its modes and the folder's name) come first, left of the window tabs. */}
			<div id="fm-titlebar-slot" className="mr-1 flex min-w-0 shrink-0 items-center empty:hidden" />
			<div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
				{state.tabs.map((tab) => {
					const { title, icon: Icon } = describe(tab.path);
					const active = tab.id === state.active;
					if (active && grouped) return null;
					return (
						<div
							key={tab.id}
							className={`group flex h-7 min-w-0 max-w-52 shrink items-center gap-2 rounded-lg pl-2.5 pr-1 text-[13px] transition-colors ${
								active ? "shadow-card bg-background text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
							}`}
						>
							<button type="button" onClick={() => select(tab)} className="flex min-w-0 flex-1 items-center gap-2">
								<Icon className="size-3.5 shrink-0" />
								<span className="truncate">{title}</span>
							</button>
							<button
								type="button"
								onClick={() => close(tab)}
								title="Close tab"
								className={`grid size-5 shrink-0 place-items-center rounded hover:bg-muted ${active ? "opacity-60" : "opacity-0 group-hover:opacity-60"} hover:!opacity-100`}
							>
								<X className="size-3" />
							</button>
						</div>
					);
				})}
				<button type="button" onClick={add} title="New tab (⌘T)" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
					<Plus className="size-4" />
				</button>
			</div>
			{/* A page's own actions (a folder's pane views) sit left of refresh, settings and the bell. */}
			<div id="fm-titlebar-actions" className="mr-1 flex shrink-0 items-center gap-0.5 empty:hidden" />
			{/* Elsewhere (Settings, Home) the same views stay in their place, opening the last folder in that view. */}
			{!onFolder && lastFolder ? (
				<span className="mr-1 inline-flex shrink-0 items-center gap-0.5">
					{PANE_VIEWS.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							title={`${label} · ${lastFolder.split(/[\\/]/).filter(Boolean).pop() ?? ""}`}
							aria-label={label}
							onClick={() => navigate(`/local?path=${encodeURIComponent(lastFolder)}&mode=${id}`)}
							className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
						>
							<Icon className="size-4" />
						</button>
					))}
				</span>
			) : null}
			{/* Refresh, settings and the bell stay here on every page; the canvases leave them to the tab bar. */}
			<button type="button" onClick={() => window.dispatchEvent(new Event("fm:refresh"))} title="Refresh" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
				<RefreshCw className="size-4" />
			</button>
			<button type="button" onClick={() => navigate("/settings")} title="Settings" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
				<Settings className="size-4" />
			</button>
			<NotificationCenter />
		</div>
	);
}
