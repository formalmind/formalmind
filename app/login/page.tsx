import { redirect } from "next/navigation";
import LoginPage from "@/components/login";
import { auth0 } from "@/lib/auth0";

export const metadata = { title: "Log in · Formal Mind" };

export default async function Login() {
	if (await auth0.getSession()) redirect("/");
	return <LoginPage />;
}
