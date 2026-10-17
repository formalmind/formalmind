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
	return lazy(() =>
		load().then(
			(m) => ({ default: pick(m) }),
			(error) => {
				if (!sessionStorage.getItem("fm:reloaded-for-chunk")) {
					sessionStorage.setItem("fm:reloaded-for-chunk", "1");
					window.location.reload();
					return new Promise<never>(() => {});
				}
				throw error;
			},
		),
	);
}
const ChatPage = page(() => import("@/components/chat"), (m) => m.ChatPage);
const GetStarted = page(() => import("@/components/get-started"), (m) => m.GetStarted);
const Onboarding = page(() => import("@/components/onboarding/onboarding"), (m) => m.Onboarding);
const ProjectSwarmPage = page(() => import("@/components/projects/project-pages"), (m) => m.ProjectSwarmPage);
const ProjectRoadmapPage = page(() => import("@/components/projects/project-pages"), (m) => m.ProjectRoadmapPage);
const ProjectChatPage = page(() => import("@/components/projects/project-pages"), (m) => m.ProjectChatPage);
const FirstProject = page(() => import("@/components/projects/project-pages"), (m) => m.FirstProject);

type User = SessionData["user"];

/** Asks the Worker once who is signed in; undefined while that answer is on its way. */
function useUser() {
	const [user, setUser] = useState<User | null | undefined>(undefined);
	useEffect(() => {
		fetch("/api/me")
			.then((res) => (res.ok ? res.json() : { user: null }))
			.then((body: { user: User | null }) => setUser(body.user))
			.catch(() => setUser(null));
	}, []);
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
				<SidebarProvider defaultOpen={open}>
					<AppSidebar />
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
	const user = useUser();
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
							<Route path="/" element={<Title text="Formal Mind"><FirstProject /></Title>} />
							<Route path="/roadmap" element={<Title text="Roadmap · Formal Mind"><FirstProject page="roadmap" /></Title>} />
							<Route path="/projects/:owner/:name" element={<Title text="Swarm · Formal Mind"><ProjectSwarmPage /></Title>} />
							<Route path="/projects/:owner/:name/roadmap" element={<Title text="Roadmap · Formal Mind"><ProjectRoadmapPage /></Title>} />
							<Route path="/projects/:owner/:name/chat" element={<Title text="Chat · Formal Mind"><ProjectChatPage /></Title>} />
							<Route path="/projects/:owner/:name/chat/:chatId" element={<Title text="Chat · Formal Mind"><ProjectChatPage /></Title>} />
							<Route path="/chat" element={<Title text="Chat · Formal Mind"><ChatPage /></Title>} />
							<Route path="/onboarding" element={<Title text="Set up · Formal Mind"><Onboarding /></Title>} />
							<Route path="/github" element={<Title text="Get Started · Formal Mind"><GetStarted /></Title>} />
							<Route path="/github/:owner/:repo" element={<RepoChat />} />
							<Route path="/documentation/get-started" element={<Title text="Get Started · Formal Mind"><GetStarted /></Title>} />
						</Route>
					) : null}
				</Route>
				<Route path="/kanban" element={<Navigate to="/roadmap" replace />} />
				<Route path="/project" element={<Navigate to="/roadmap" replace />} />
				<Route path="/swarm" element={<Navigate to="/" replace />} />
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</ThemeProvider>
	);
}
