import { LEFT, ROW } from "./project-roadmap";

/** Bar placements for the placeholder rows: [start, length] as fractions of the timeline, fixed so it never jumps. */
const BARS: [number, number][] = [
	[0.62, 0.3], [0.55, 0.12], [0.7, 0.2], [0.4, 0.45], [0.66, 0.08], [0.2, 0.5], [0.5, 0.35], [0.3, 0.25], [0.6, 0.15], [0.1, 0.6],
];
const TITLES = [0.72, 0.6, 0.66, 0.5, 0.7, 0.62, 0.55, 0.68, 0.48, 0.64];

const Bone = ({ className = "", style }: { className?: string; style?: React.CSSProperties }) => (
	<span className={`fm-shimmer block rounded ${className}`} style={style} aria-hidden />
);

/** The roadmap while its items load: the same toolbar, header, group and rows, shimmering in place. */
export function RoadmapSkeleton() {
	return (
		<div className="flex h-full min-h-0 flex-col" role="status" aria-label="Loading the roadmap">
			<div className="flex flex-wrap items-center gap-2 pb-3">
				<Bone className="h-7 w-64 rounded-md" />
				<Bone className="h-7 w-52 rounded-md" />
				<Bone className="h-7 w-16 rounded-md" />
			</div>
			<div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border">
				<div className="flex border-b">
					<div style={{ width: LEFT }} className="flex h-12 shrink-0 items-end border-r px-3 pb-2">
						<Bone className="h-3 w-10" />
					</div>
					<div className="flex h-12 flex-1 items-end gap-16 px-3 pb-2">
						<Bone className="h-3 w-12" />
						<Bone className="h-3 w-12" />
						<Bone className="h-3 w-12" />
					</div>
				</div>
				<div className="flex border-b bg-muted/40" style={{ height: ROW }}>
					<div style={{ width: LEFT }} className="flex shrink-0 items-center gap-2 border-r bg-muted px-2">
						<Bone className="h-3 w-3" />
						<Bone className="h-3 w-36" />
						<Bone className="ml-auto h-4 w-6 rounded-full" />
					</div>
				</div>
				{BARS.map(([from, len], i) => (
					<div key={i} className="flex border-b" style={{ height: ROW }}>
						<div style={{ width: LEFT }} className="flex shrink-0 items-center gap-2 border-r px-3">
							<Bone className="size-3.5 rounded-full" />
							<Bone className="h-3" style={{ width: `${TITLES[i] * 100}%` }} />
						</div>
						<div className="relative flex-1">
							<Bone className="absolute top-1/2 h-5 -translate-y-1/2 rounded-md" style={{ left: `${from * 100}%`, width: `${len * 100}%` }} />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
