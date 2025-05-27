import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { GithubIcon } from "./icons"

export function LoginForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>
            Login with Google or Github account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6">
            <div className="flex flex-col gap-4">
              <a href="/auth/login?connection=github&access_type=offline&prompt=consent" className="flex items-center gap-2">
                <Button variant="outline" className="w-full">
                  <GithubIcon />
                  Login with GitHub
                </Button>
              </a>

              <a href="/auth/login?connection=google-oauth2&access_type=offline&prompt=consent" className="underline underline-offset-4">
                <Button variant="outline" className="w-full">
                  Login with Google
                </Button>
              </a>
            </div>
            <div className="text-center text-sm">
              Don&apos;t have an account?{" "}
              <a href="/auth/login?connection=github&access_type=offline&prompt=consent" className="underline underline-offset-4">
                Sign up
              </a>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary  ">
        By clicking continue, you agree to our <a href="#">Terms of Service</a>{" "}
        and <a href="#">Privacy Policy</a>.
      </div>
    </div>
  )
}
