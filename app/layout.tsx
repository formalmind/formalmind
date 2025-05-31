import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@radix-ui/react-separator";
import { auth0 } from "@/lib/auth0"
import LoginPage from "@/components/login"
import { AuthProvider } from "@/components/auth-context";
import BreadCrumbs from "@/components/bread-crumbs";

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
				<body className="text-sm">
					<LoginPage />
				</body>
			</html>
		)
	}
	return (
		<html lang="en" suppressHydrationWarning>
			<body
				suppressHydrationWarning
				className={`${geistSans.variable} ${geistMono.variable} antialiased light`}
			>
				<AuthProvider session={session}>
					<SidebarProvider>
						<AppSidebar />
						<div className="flex-1 overflow-x-auto">
							<SidebarInset className="flex-1 w-full overflow-x-auto">
								<header className="flex h-16 shrink-0 items-center gap-2">
									<div className="flex items-center gap-2 px-4">
										<SidebarTrigger className="-ml-1" />
										<Separator orientation="vertical" className="mr-2 h-4" />

										<BreadCrumbs />

									</div>
								</header>
								<div className="flex flex-1 flex-col min-h-0 gap-4 p-4 pt-0 text-sm">

									<article className="px-1 markdown prose max-w-full">
										{children}
									</article>
								</div>
							</SidebarInset>
						</div>
					</SidebarProvider >
				</AuthProvider>
			</body >
		</html >
	);
}
