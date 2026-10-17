import { LogoMark } from "@/components/logo"
import { LoginForm } from "@/components/login-form"
import YouTubeVideo from "@/components/youtube-video"

export default function LoginPage() {
	return (
		<div className="grid min-h-svh lg:grid-cols-2">
			<div className="flex flex-col gap-4 p-6 md:p-10">
				<div className="flex justify-center gap-2 md:justify-start">
					<a href="#" className="flex items-center gap-2 font-medium">
						<LogoMark size={24} />
						Formal Mind.
					</a>
				</div>
				<div className="flex flex-1 items-center justify-center">
					<div className="w-full max-w-xs">
						<LoginForm />
					</div>
				</div>
			</div>
			<div className="relative hidden bg-muted lg:flex lg:items-center lg:justify-center lg:p-10">
				<div className="w-full max-w-2xl overflow-hidden rounded-lg">
					<YouTubeVideo videoId="xyZZqCQlmCE" title="Formal Mind quick intro" />
				</div>
			</div>
		</div>
	)
}
