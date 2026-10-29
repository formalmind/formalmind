import { DesktopHome } from "./home";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { AddProjectHost } from "@/components/add-project";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider } from "@/components/auth-context";
import { ChatConversationsProvider } from "@/components/chat-conversations";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceContent } from "@/components/workspace-content";
import type { SessionData } from "@/lib/session";
import { apiBase, clearToken, exchangeCode, loadToken, syncSettings } from "./api";

import { LocalFolderPage, LocalFolders, recentFolders, useFolders, useRepoSource } from "./local";
import { Workbench } from "./workbench";
import { onboarded, SetupSteps, SignInStep } from "./onboarding";
import { SettingsPage } from "./settings";
import { TabBar } from "./tabs";
import { UpdateNotice } from "./update";

const UsagePage = lazy(() => import("@/components/usage/usage-page").then((m) => ({ default: m.UsagePage })));
const pages = () => import("@/components/projects/project-pages");
const ProjectHomePage = lazy(() => pages().then((m) => ({ default: m.ProjectHomePage })));
const ProjectFilePage = lazy(() => import("@/components/projects/project-file").then((m) => ({ default: m.ProjectFilePage })));

type User = SessionData["user"];

/** The code from formalmind://auth?code=…, if that's what the link is. */
const codeFrom = (link: string) => {
	try {
		const url = new URL(link);
		return url.protocol === "formalmind:" && url.host === "auth" ? url.searchParams.get("code") : null;
	} catch {
		return null;
	}
};

function Shell({ user }: { user: User }) {
	const repoSource = useRepoSource();
	return (
		<AuthProvider value={{ user, tokenSet: { accessToken: "", expiresAt: 0 } }}>
			<ChatConversationsProvider>
				<SidebarProvider defaultOpen className="fm-app">
					<TabBar />
					<AppSidebar extra={<LocalFolders />} repoSource={repoSource} />
					<AddLocalHost />
					<WorkspaceContent>
						<Suspense fallback={null}>
							<Routes>
								{/* Home is an empty screen with the next step. */}
								<Route path="/" element={<Start />} />
								<Route path="/usage" element={<UsagePage />} />
								<Route path="/projects/:owner/:name" element={<ProjectHomePage />} />
								<Route path="/projects/:owner/:name/file" element={<ProjectFilePage />} />
								<Route path="/local" element={<LocalFolderPage />} />
								<Route path="/settings" element={<SettingsPage />} />
								{/* Other pages come over from the web app as the desktop app grows. */}
								<Route path="*" element={<Navigate to="/" replace />} />
							</Routes>
						</Suspense>
					</WorkspaceContent>
				</SidebarProvider>
			</ChatConversationsProvider>
		</AuthProvider>
	);
}

export function DesktopApp() {
	const [user, setUser] = useState<User | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		// Sign-in finished in the browser: bring the app back in front of it.
		void getCurrentWindow().unminimize().then(() => getCurrentWindow().setFocus()).catch(() => {});
		const res = await fetch("/api/me").catch(() => null);
		const body = res?.ok ? ((await res.json()) as { user: User | null }) : { user: null };
		setUser(body.user);
	}, []);

	const signInWith = useCallback(
		async (code: string) => {
			setError(null);
			try {
				await exchangeCode(code);
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "Sign-in failed.");
			}
		},
		[refresh],
	);

	useEffect(() => {
		void loadToken().then(refresh, () => setUser(null));
		// The browser hands back formalmind://auth?code=…: on a cold start it's in getCurrent, later via onOpenUrl.
		const handle = (urls: string[] | null) => {
			const code = urls?.map(codeFrom).find(Boolean);
			if (code) void signInWith(code);
		};
		void getCurrent().then(handle).catch(() => {});
		const off = onOpenUrl(handle).catch(() => () => {});
		return () => void off.then((f) => f());
	}, [refresh, signInWith]);

	// The shared sidebar links to /auth/login and /auth/logout (web routes); here they mean the desktop session.
	useEffect(() => {
		const onClick = (event: MouseEvent) => {
			const href = (event.target as Element | null)?.closest("a")?.getAttribute("href");
			if (href === "/auth/logout") {
				event.preventDefault();
				void clearToken().then(() => setUser(null));
			} else if (href?.startsWith("/auth/login")) {
				event.preventDefault();
				void openUrl(`${apiBase()}/api/desktop/authorize`);
			}
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	// The backend runs the relay and the swarm with the settings the pages keep: they're pushed to it at launch, and
	// again whenever one changes (api.ts).
	useEffect(() => void syncSettings(), []);

	const [setUp, setSetUp] = useState(onboarded);
	if (user === undefined) return null;
	if (!user) return <SignInStep onCode={signInWith} onSignedIn={() => void refresh()} error={error} />;
	if (!setUp) return <SetupSteps onDone={() => setSetUp(true)} />;
	return (
		<ThemeProvider>
			<div className="fm-shell">
				<Shell user={user} />
			</div>
			<UpdateNotice />
		</ThemeProvider>
	);
}

/** The Add a project popup; its Local folder is this Mac's folder picker, and the folder opens once added. */
function AddLocalHost() {
	const { add } = useFolders();
	const navigate = useNavigate();
	return <AddProjectHost onLocal={() => add().then((p) => p && navigate(`/local?path=${encodeURIComponent(p)}`))} />;
}

/** The first screen: the most recently opened folder's files and its agent; the add-a-folder step with none. */
function Start() {
	const { folders } = useFolders();
	const folder = recentFolders(folders, 1)[0];
	return folder ? <Workbench folder={folder} /> : <DesktopHome />;
}
