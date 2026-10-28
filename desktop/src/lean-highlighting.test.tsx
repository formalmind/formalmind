import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightCode } from "../../lib/highlighter";

test("Lean highlighting preserves Unicode, comments, and both theme colors", async () => {
	const code = "/- nested /- comment -/ end -/\ntheorem identity (n : Nat) : n = n := by\n  rfl\n-- ∀ x → x < 2";
	const lines = await highlightCode(code, "lean");
	expect(lines).not.toBeNull();
	expect(lines!.length).toBe(4);
	const html = renderToStaticMarkup(<>{lines!.map((line, i) => <div key={i}>{line}</div>)}</>);
	expect(html).toContain("shiki-token");
	expect(html).toContain("--shiki-light");
	expect(html).toContain("--shiki-dark");
	expect(html.replace(/<[^>]*>/g, "")).toContain("∀ x → x &lt; 2");
	expect(html).toContain("identity");
});
