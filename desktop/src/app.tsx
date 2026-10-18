import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider } from "@/components/auth-context";
import { ChatConversationsProvider } from "@/components/chat-conversations";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceContent } from "@/components/workspace-content";
import { SWARM_REPO } from "@/lib/swarm-repo";
import type { SessionData } from "@/lib/session";
import { apiBase, clearToken, DEFAULT_API, exchangeCode, loadToken, setApiBase } from "./api";

import { LocalFolderPage, LocalFolders } from "./local";

const UsagePage = lazy(() => import("@/components/usage/usage-page").then((m) => ({ default: m.UsagePage })));
const pages = () => import("@/components/projects/project-pages");
const SwarmChatPage = lazy(() => pages().then((m) => ({ default: m.SwarmChatPage })));
const FirstProject = lazy(() => pages().then((m) => ({ default: m.FirstProject })));

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

function SignIn({ onCode, error }: { onCode: (code: string) => void; error: string | null }) {
	const [code, setCode] = useState("");
	const [base, setBase] = useState(apiBase());
	const start = () => {
		setApiBase(base);
		void openUrl(`${apiBase()}/api/desktop/authorize`);
	};
	return (
		<main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
			<div className="w-full max-w-sm space-y-6 text-center">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold">Formal Mind</h1>
					<p className="text-sm text-muted-foreground">Sign in with GitHub in your browser, then come back here.</p>
				</div>
				<button type="button" onClick={start} className="btn-dark w-full rounded-full px-4 py-2 text-sm font-medium">
					Sign in with GitHub
				</button>
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (code.trim()) onCode(code.trim());
					}}
				>
					<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Or paste the code" className="min-w-0 flex-1 rounded-full border bg-transparent px-3 py-1.5 text-sm" />
					<button type="submit" className="btn-soft rounded-full px-3 py-1.5 text-sm">Continue</button>
				</form>
				{error ? <p className="text-sm text-red-600">{error}</p> : null}
				<details className="text-left text-xs text-muted-foreground">
					<summary className="cursor-pointer">Server</summary>
					<input
						value={base}
						onChange={(e) => setBase(e.target.value)}
						onBlur={() => setApiBase(base)}
						placeholder={DEFAULT_API}
						className="mt-2 w-full rounded-md border bg-transparent px-2 py-1"
					/>
					<p className="mt-1">Use http://localhost:8787 with a local `wrangler dev`.</p>
				</details>
			</div>
		</main>
	);
}

function Shell({ user }: { user: User }) {
	return (
		<AuthProvider value={{ user, tokenSet: { accessToken: "", expiresAt: 0 } }}>
			<ChatConversationsProvider>
				<SidebarProvider defaultOpen>
					<AppSidebar extra={<LocalFolders />} />
					<WorkspaceContent>
						<Suspense fallback={null}>
							<Routes>
								<Route path="/" element={<SwarmWorkspace repo={SWARM_REPO} />} />
								<Route path="/swarm/chat" element={<SwarmChatPage />} />
								<Route path="/roadmap" element={<FirstProject page="roadmap" />} />
								<Route path="/usage" element={<UsagePage />} />
								<Route path="/local" element={<LocalFolderPage />} />
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

	if (user === undefined) return null;
	return <ThemeProvider>{user ? <Shell user={user} /> : <SignIn onCode={signInWith} error={error} />}</ThemeProvider>;
}
