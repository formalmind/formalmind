import { redirect } from "next/navigation";

/** Pages that call notFound() send people home rather than showing a 404. */
export default function NotFound() {
	redirect("/");
}
