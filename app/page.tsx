import { AppSidebar, } from "@/components/app-sidebar"
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar"
import { auth0 } from "@/lib/auth0"
import LoginPage from "@/components/login"

export default async function Page() {
	const session = await auth0.getSession()
	// const nickname = session?.user?.nickname
	// const name = session?.user?.name
	// const pic = session?.user?.picture
	// const sub = session?.user?.sub
	// const tokenSet = session?.tokenSet
	// const idToken = session?.idToken
	// const scope = session?.scope
	// const refreshToken = session?.refreshToken
	// const expiresAt = session?.expiresAt
	// const sid = session?.internal?.sid
	// const createdAt = session?.internal?.createdAt
	// const expire = session?.exp

	if (!session) {
		return (
			<LoginPage />
		)
	}
	return (
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
				<div className="flex flex-1 flex-col gap-4 p-4 pt-0">
					<p>Welcome {session.user.name}</p>
				</div>
			</SidebarInset>
		</SidebarProvider >
	)
}
