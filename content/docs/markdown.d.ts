/** The guide's pages, imported as text by the Worker (wrangler.jsonc's Text rule for `*.md`). */
declare module "*.md" {
	const text: string;
	export default text;
}
