import { Button } from "@/components/ui/button"
import { LogIn } from "lucide-react"
export default function Page() {
	return (
		<div className="flex flex-1 min-h-screen items-center justify-center">
			<div className="flex flex-1 items-center justify-center">
				<Button size="lg" variant="outline" asChild>
					<a href="/auth/login" className="flex items-center gap-2">
						<LogIn className="size-5" />
						<span className="font-medium">Log in to your account</span>
					</a>
				</Button>
			</div>
		</div>
	)
}
