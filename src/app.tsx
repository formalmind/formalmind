import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider } from "@/components/auth-context";
import { ChatConversationsProvider } from "@/components/chat-conversations";
import { Landing } from "@/components/landing/landing";
import LoginPage from "@/components/login";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceContent } from "@/components/workspace-content";
import { SWARM_REPO } from "@/lib/swarm-repo";
import type { SessionData } from "@/lib/session";

// Pages beyond the swarm load on first visit, so the landing page and the board ship only what they use.
const ChatPage = lazy(() => import("@/components/chat").then((m) => ({ default: m.ChatPage })));
const GetStarted = lazy(() => import("@/components/get-started").then((m) => ({ default: m.GetStarted })));
const Onboarding = lazy(() => import("@/components/onboarding/onboarding").then((m) => ({ default: m.Onboarding })));
const ProjectView = lazy(() => import("@/components/project/project-view").then((m) => ({ default: m.ProjectView })));

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
							<Route path="/" element={<Title text="Formal Mind"><SwarmWorkspace repo={SWARM_REPO} /></Title>} />
							<Route path="/chat" element={<Title text="Chat · Formal Mind"><ChatPage /></Title>} />
							<Route path="/roadmap" element={<Title text="Roadmap · Formal Mind"><ProjectView repo={SWARM_REPO} /></Title>} />
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
