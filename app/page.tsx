import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { SWARM_REPO } from "@/lib/swarm";

export const metadata = { title: "Swarm · Formal Mind" };

export default function HomePage() {
	return <SwarmWorkspace repo={SWARM_REPO} />;
}
