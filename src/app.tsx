import { AddProjectHost } from "@/components/add-project";
import { WebHome } from "@/components/web-home";
import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider } from "@/components/auth-context";
import { ChatConversationsProvider } from "@/components/chat-conversations";
import { Landing } from "@/components/landing/landing";
import LoginPage from "@/components/login";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceContent } from "@/components/workspace-content";
import type { SessionData } from "@/lib/session";

/**
 * Pages beyond the swarm load on first visit, so the landing page and the board ship only what they use. A chunk
 * that fails to load belongs to an older deploy: reload once to get the new build instead of crashing.
 */
function page<T, P extends object>(load: () => Promise<T>, pick: (m: T) => React.ComponentType<P>) {
	const stale = (error: unknown) => {
		if (!sessionStorage.getItem("fm:reloaded-for-chunk")) {
			sessionStorage.setItem("fm:reloaded-for-chunk", "1");
			window.location.reload();
			return new Promise<never>(() => {});
		}
		throw error;
	};
	return lazy(() =>
		load().then((m) => {
			// A chunk can come back without the page in it (a newer build replaced it): treat that as stale too.
			const component = m ? pick(m) : undefined;
			if (!component) return stale(new Error("This page belongs to an older build."));
			// Loaded fine: the next stale chunk may reload again.
			sessionStorage.removeItem("fm:reloaded-for-chunk");
			return { default: component };
		}, stale),
	);
}
const ChatPage = page(() => import("@/components/chat"), (m) => m.ChatPage);
const ProjectHomePage = page(() => import("@/components/projects/project-pages"), (m) => m.ProjectHomePage);
const ProjectChatPage = page(() => import("@/components/projects/project-pages"), (m) => m.ProjectChatPage);
const ProjectFilePage = page(() => import("@/components/projects/project-file"), (m) => m.ProjectFilePage);
const ProjectCodePage = page(() => import("@/components/projects/project-code"), (m) => m.ProjectCodePage);
const LocalDemoPage = page(() => import("@/components/local-demo"), (m) => m.LocalDemoPage);
const UsagePage = page(() => import("@/components/usage/usage-page"), (m) => m.UsagePage);
const SettingsPage = page(() => import("@/components/settings-page"), (m) => m.SettingsPage);
const DocsSite = page(() => import("@/components/docs/docs-site"), (m) => m.DocsSite);

/** docs.formal.team serves the guide at its root; formal.team serves it at /docs. Null elsewhere. */
function docsBase(host: string, path: string): string | null {
	if (host.startsWith("docs.")) return "";
	return path === "/docs" || path.startsWith("/docs/") ? "/docs" : null;
}

type User = SessionData["user"];

/** Asks the Worker once who is signed in; undefined while that answer is on its way (and while `skip`: the docs). */
function useUser(skip = false) {
	const [user, setUser] = useState<User | null | undefined>(undefined);
	useEffect(() => {
		if (skip) return;
		fetch("/api/me")
			.then((res) => (res.ok ? res.json() : { user: null }))
			.then((body: { user: User | null }) => setUser(body.user))
			.catch(() => setUser(null));
	}, [skip]);
	return user;
}

function Title({ text, children }: { text: string; children: React.ReactNode }) {
	useEffect(() => {
		document.title = text;
	}, [text]);
	return <>{children}</>;
}

/** Signed-in pages: off to Auth0 first when nobody is, back here afterwards. */
function RequireUser({ user }: { user: User | null }) {
	const location = useLocation();
	useEffect(() => {
		if (!user) window.location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
	}, [user, location]);
	return user ? <Outlet /> : null;
}

function SignedInLayout({ user }: { user: User }) {
	// The sidebar remembers collapsed/expanded in a cookie.
	const open = !document.cookie.split("; ").includes("sidebar_state=false");
	return (
		<AuthProvider value={{ user, tokenSet: { accessToken: "", expiresAt: 0 } }}>
			<ChatConversationsProvider>
				<SidebarProvider defaultOpen={open} className="fm-app">
					<AppSidebar />
					<AddProjectHost />
					<WorkspaceContent>
						<Suspense fallback={null}>
							<Outlet />
						</Suspense>
					</WorkspaceContent>
				</SidebarProvider>
			</ChatConversationsProvider>
		</AuthProvider>
	);
}

function RepoChat() {
	const { owner, repo } = useParams();
	return owner && repo ? <ChatPage /> : <Navigate to="/" replace />;
}

export function App() {
	const { pathname } = useLocation();
	// The docs are public: they neither ask for nor wait for the session.
	const docs = docsBase(window.location.hostname, pathname);
	const user = useUser(docs !== null);
	if (docs !== null) {
		return (
			<ThemeProvider>
				<Suspense fallback={null}>
					<DocsSite base={docs} />
				</Suspense>
			</ThemeProvider>
		);
	}
	if (user === undefined) return null;
	const signedIn = Boolean(user);

	return (
		<ThemeProvider>
			<Routes>
				<Route path="/welcome" element={<Title text="Formal Mind · Prove your Solidity correct"><Landing signedIn={signedIn} /></Title>} />
				<Route path="/login" element={signedIn ? <Navigate to="/" replace /> : <Title text="Log in · Formal Mind"><LoginPage /></Title>} />
				{!user ? <Route path="/" element={<Title text="Formal Mind"><Landing signedIn={false} /></Title>} /> : null}
				<Route element={<RequireUser user={user} />}>
					{user ? (
						<Route element={<SignedInLayout user={user} />}>
							{/* Home is an empty screen with the next step. */}
							<Route path="/" element={<Title text="Formal Mind"><WebHome /></Title>} />
							<Route path="/settings" element={<Title text="Settings · Formal Mind"><SettingsPage /></Title>} />
							<Route path="/local-demo" element={<Title text="Local demo · Formal Mind"><LocalDemoPage /></Title>} />
							<Route path="/usage" element={<Title text="Usage · Formal Mind"><UsagePage /></Title>} />
							<Route path="/projects/:owner/:name" element={<ProjectHomePage />} />
							<Route path="/projects/:owner/:name/file" element={<Title text="File · Formal Mind"><ProjectFilePage /></Title>} />
								<Route path="/projects/:owner/:name/code" element={<ProjectCodePage />} />
							<Route path="/projects/:owner/:name/chat" element={<Title text="Chat · Formal Mind"><ProjectChatPage /></Title>} />
							<Route path="/projects/:owner/:name/chat/:chatId" element={<Title text="Chat · Formal Mind"><ProjectChatPage /></Title>} />
							<Route path="/chat" element={<Title text="Chat · Formal Mind"><ChatPage /></Title>} />
							<Route path="/github" element={<Navigate to="/?add=1" replace />} />
							<Route path="/github/:owner/:repo" element={<RepoChat />} />
							<Route path="/documentation/get-started" element={<Navigate to="/docs" replace />} />
						</Route>
					) : null}
				</Route>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</ThemeProvider>
	);
}

