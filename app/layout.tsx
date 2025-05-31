import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@radix-ui/react-separator";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { auth0 } from "@/lib/auth0"
import LoginPage from "@/components/login"
import { AuthProvider } from "@/components/auth-context";

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
	console.log("Main Layout Session:", session);
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
				className={`${geistSans.variable} ${geistMono.variable} antialiased`}
			>
				<AuthProvider session={session}>
					<SidebarProvider>
						<AppSidebar />
						<SidebarInset>
							<header className="flex h-16 shrink-0 items-center gap-2">
								<div className="flex items-center gap-2 px-4">
									<SidebarTrigger className="-ml-1" />
									<Separator orientation="vertical" className="mr-2 h-4" />
									<Breadcrumb>
										<BreadcrumbList>
											<BreadcrumbItem className="hidden md:block">
												<BreadcrumbLink href="#">
													Building Your Application
												</BreadcrumbLink>
											</BreadcrumbItem>
											<BreadcrumbSeparator className="hidden md:block" />
											<BreadcrumbItem>
												<BreadcrumbPage>Data Fetching</BreadcrumbPage>
											</BreadcrumbItem>
										</BreadcrumbList>
									</Breadcrumb>
								</div>
							</header>

							<div className="flex flex-1 flex-col gap-4 p-4 pt-0 text-sm">
								{children}
							</div>
						</SidebarInset>
					</SidebarProvider >
				</AuthProvider>
			</body >
		</html >
	);
}
