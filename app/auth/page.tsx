import { redirect } from "next/navigation";
import { auth0 } from "@/lib/auth0";

export default async function AuthPage() {
	const session = await auth0.getSession();
	redirect(session ? "/" : "/auth/login");
}
