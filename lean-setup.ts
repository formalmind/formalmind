import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const LEAN_VERSION = "v4.19.0";
const PROJECT_NAME = "lean-verifier";
const FILE_NAME = "Proof.lean";

export async function runLeanVerification(code: string): Promise<string> {
	const tempDir = path.join("/tmp", PROJECT_NAME);

	try {
		if (!fs.existsSync(tempDir)) {
			execSync(`elan self update`);
			execSync(`lake +${LEAN_VERSION} new ${PROJECT_NAME}`, {
				cwd: "/tmp",
				stdio: "inherit",
			});
		}

		// Write the Lean code
		const filePath = path.join(tempDir, "LeanVerifier", FILE_NAME);
		fs.writeFileSync(filePath, code);

		// Run the build
		execSync(`lake build`, {
			cwd: path.join(tempDir, "LeanVerifier"),
			stdio: "inherit",
		});

		// Return success
		return "✅ Lean build succeeded. Proof verified or compiles cleanly.";
	} catch (err: any) {
		return `❌ Lean build failed:\n\n${err?.stderr?.toString() || err?.message}`;
	}
}

await runLeanVerification("").catch((err) => {
	console.error("Error running Lean verification:", err);
	process.exit(1);
});
