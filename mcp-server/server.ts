import { serve } from "bun";
import { walkRepo } from "./agents/listener";
import { generateSpecs } from "./agents/spec-agent";
import { runVerification } from "./agents/verify-agent";

serve({
  fetch: async (req: Request) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/verify") {
      const body = await req.json();
      const repoPath = body.repoPath;

      const commits = await walkRepo(repoPath);
      if (!commits || commits.length === 0) {
        return new Response("No commits found in the repository", { status: 404 });
      }
      for (const commit of commits) {
        await generateSpecs(repoPath, commit);
        await runVerification(repoPath, commit);
      }

      return new Response("Verification complete 🧠💥");
    }

    return new Response("Hello from Lean MCP");
  },
  port: 3005,
});
