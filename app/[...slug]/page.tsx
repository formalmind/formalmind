import { redirect } from "next/navigation";

/** Any path no other route claims goes to the home page instead of a 404. */
export default function UnknownRoute() {
	redirect("/");
}
