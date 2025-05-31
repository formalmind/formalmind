/**
 * NOTE: This function builds file diffs from the provided files array.
 * Builds a string of file diffs from the provided files array.
 * Limits the total number of lines to maxLines.
 * @param files - Array of file objects containing patch data.
 * @param maxLines - Maximum number of lines to include in the diff output.
 * @returns A formatted string containing the diffs for each file.
 */
export function buildFileDiffs(files: any[], maxLines = 1000): string {
	const diffs: string[] = [];
	let totalLines = 0;

	for (const file of files) {
		if (!file.patch) continue;

		const patchLines = file.patch.split("\n");
		const remaining = maxLines - totalLines;

		if (remaining <= 0) break;

		const chunk = patchLines.slice(0, remaining);
		totalLines += chunk.length;

		const diffBlock = `### ${file.filename}\n\`\`\`diff\n${chunk.join("\n")}${chunk.length < patchLines.length ? "\n... [truncated]" : ""}\n\`\`\``;
		diffs.push(diffBlock);
	}

	return diffs.join("\n\n");
}


export function extractJsonCodeBlock(comment: string): string | null {
	console.log("📬 Running extractLeanCodeBlock");
	const unquoted = comment
		.split("\n")
		.map(line => line.startsWith(">") ? line.slice(1).trim() : line)
		.join("\n");

	const patterns = [
		{ label: "unquoted", text: unquoted },
		{ label: "raw", text: comment },
	];

	for (const { label, text } of patterns) {
		const match = text.match(/```json\s*\n([\s\S]*?)\n```/i);
		if (match) {
			console.log(`✅ Json code block found in ${label} input`);
			return match[1].trim();
		}
	}

	console.warn("❌ No Lean code block found in comment.");
	return null;
}

export function extractLeanCodeBlock(comment: string): string | null {
	console.log("📬 Running extractLeanCodeBlock");
	const unquoted = comment
		.split("\n")
		.map(line => line.startsWith(">") ? line.slice(1).trim() : line)
		.join("\n")

	const patterns = [
		{ label: "unquoted", text: unquoted },
		{ label: "raw", text: comment },
	];

	for (const { label, text } of patterns) {
		const match = text.match(/```lean\s*\n([\s\S]*?)\n```/i);
		if (match) {
			console.log(`✅ Lean code block found in ${label} input`);
			return match[1].trim();
		}
	}

	console.warn("❌ No Lean code block found in comment.");
	return null;
}
