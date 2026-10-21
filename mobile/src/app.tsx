import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { AuthProvider } from "@/components/auth-context";
import { ThemeProvider } from "@/components/theme-provider";
import type { SessionData } from "@/lib/session";
import { clearToken, exchangeCode, loadToken } from "@/desktop/src/api";
import { MobileHome } from "./home";
import { followRelay } from "./relay";
import { introduced, Onboarding, setIntroduced } from "./onboarding";
import { Setup, setUpDone } from "./setup";
import { SignIn } from "./sign-in";

const ProjectScreen = lazy(() => import("./project").then((m) => ({ default: m.ProjectScreen })));
const MacScreen = lazy(() => import("./mac").then((m) => ({ default: m.MacScreen })));
const SessionScreen = lazy(() => import("./mac").then((m) => ({ default: m.SessionScreen })));
const NotificationsScreen = lazy(() => import("./notifications").then((m) => ({ default: m.NotificationsScreen })));
const NotificationScreen = lazy(() => import("./notifications").then((m) => ({ default: m.NotificationScreen })));
const SettingsScreen = lazy(() => import("./settings").then((m) => ({ default: m.SettingsScreen })));

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

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
	// Signed in: follow what your Mac's swarm is doing, for the Mac screens and the notifications.
	useEffect(() => followRelay(), []);
	// After the first sign-in: the setup steps, then Home.
	const [ready, setReady] = useState(setUpDone);
	return (
		<AuthProvider value={{ user, tokenSet: { accessToken: "", expiresAt: 0 } }}>
			<Suspense fallback={null}>
				{!ready ? (
					<Setup user={user} onDone={() => setReady(true)} />
				) : (
				<Routes>
					<Route path="/" element={<MobileHome user={user} />} />
					<Route path="/projects/:owner/:name" element={<ProjectScreen />} />
					<Route path="/projects/:owner/:name/code" element={<ProjectScreen />} />
					<Route path="/mac" element={<MacScreen />} />
					<Route path="/mac/session" element={<SessionScreen />} />
					<Route path="/notifications" element={<NotificationsScreen />} />
					<Route path="/notifications/:id" element={<NotificationScreen />} />
					<Route path="/settings" element={<SettingsScreen user={user} onSignOut={onSignOut} />} />
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
				)}
			</Suspense>
		</AuthProvider>
	);
}

/** Formal Mind for iPhone: sign in with formal.team, then your projects and the swarm on your Mac. */
export function MobileApp() {
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
		// The app signs in with its token only (a local Dev Preview Worker would take anyone without one).
		void loadToken().then((token) => (token ? refresh() : setUser(null)), () => setUser(null));
		// Safari hands back formalmind://auth?code=…: on a cold start it's in getCurrent, later via onOpenUrl.
		const handle = (urls: string[] | null) => {
			const code = urls?.map(codeFrom).find(Boolean);
			if (code) void signInWith(code);
		};
		void getCurrent().then(handle).catch(() => {});
		const off = onOpenUrl(handle).catch(() => () => {});
		return () => void off.then((f) => f());
	}, [refresh, signInWith]);

	// The introduction shows once, before signing in.
	const [intro, setIntro] = useState(() => !introduced());
	if (user === undefined) return <div className="min-h-dvh bg-background" />;
	if (!user && intro) {
		return (
			<Onboarding
				onDone={() => {
					setIntroduced(true);
					setIntro(false);
				}}
			/>
		);
	}
	return (
		<ThemeProvider>
			{user ? <Shell user={user} onSignOut={() => void clearToken().then(() => setUser(null))} /> : <SignIn onCode={signInWith} onSignedIn={() => void refresh()} error={error} />}
		</ThemeProvider>
	);
}
