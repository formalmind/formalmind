import { AuthProvider } from "@/components/auth-context";
import LoginPage from "@/components/login";
import { auth0 } from "@/lib/auth0";

export default async function Layout({
	children,
}: {
	children: React.ReactNode,
}) {
	const session = await auth0.getSession()
	if (!session) {
		return <LoginPage />
	}
	return (
		<AuthProvider session={session}>
			<div className="flex flex-col h-full">
				<div className="flex-1 overflow-y-auto">
					{children}
				</div>
			</div>
		</AuthProvider>
	)
}
