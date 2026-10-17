import type { Metadata } from "next";
import localFont from "next/font/local";
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-light.css";
import "./globals.css";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { auth0 } from "@/lib/auth0"
import LoginPage from "@/components/login"
import { AuthProvider } from "@/components/auth-context";
import { WorkspaceContent } from "@/components/workspace-content";
import { ThemeProvider } from "@/components/theme-provider";
import { ChatConversationsProvider } from "@/components/chat-conversations";

const geistSans = localFont({
	src: "./fonts/GeistVF.woff",
	variable: "--font-geist-sans",
	weight: "100 900",
});
const geistMono = localFont({
	src: "./fonts/GeistMonoVF.woff",
	variable: "--font-geist-mono",
	weight: "100 900",
});

export const metadata: Metadata = {
	title: "Formal Mind Ai",
	description: "Connect your github to work with our formal verification AI agents in Lean 4.",
};

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const session = await auth0.getSession()
	// const nickname = session?.user?.nickname
	// const name = session?.user?.name
	// const pic = session?.user?.picture
	// const sub = session?.user?.sub
	// const tokenSet = session?.tokenSet
	// const accessToken = session?.tokenSet.accessToken
	// const idToken = session?.idToken
	// const scope = session?.scope
	// const refreshToken = session?.refreshToken
	// const expiresAt = session?.expiresAt
	// const sid = session?.internal?.sid
	// const createdAt = session?.internal?.createdAt
	// const expire = session?.exp
	if (!session) {
		return (
			<html>
				<body className="text-sm" suppressHydrationWarning>
					<ThemeProvider>
						<LoginPage />
					</ThemeProvider>
				</body>
			</html>
		)
	}
	return (
		<html lang="en" suppressHydrationWarning>
			<body
				suppressHydrationWarning
				className={`${geistSans.variable} ${geistMono.variable} antialiased`}
			>
				<ThemeProvider>
					<AuthProvider value={session}>
						<ChatConversationsProvider>
							<SidebarProvider>
								<AppSidebar />
								<WorkspaceContent>{children}</WorkspaceContent>
							</SidebarProvider >
						</ChatConversationsProvider>
					</AuthProvider>
				</ThemeProvider>
			</body >
		</html >
	);
}
