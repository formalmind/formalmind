import { useId } from "react";

/**
 * The Formal Mind mark: an isometric F on a black tile. Traced from public/brand/formal-mind-logo.png.
 * Hovering its link builds the F again, facet by facet; while agents work (on the swarm page) its bar breathes.
 */
export function LogoMark({ size = 20, className, bare = false, shimmer = false }: { size?: number; className?: string; /** The F alone, without its black tile; `size` is then its height. */ bare?: boolean; /** A light that sweeps across the F now and then. */ shimmer?: boolean }) {
	const side = useId();
	const sheen = useId();
	return (
		<svg width={bare ? Math.round((size * 450) / 661) : size} height={size} viewBox={bare ? "418 280 450 661" : "263 230 760 760"} className={`fm-logo ${className ?? ""}`} aria-hidden>
			<defs>
				<linearGradient id={side} x1="428" y1="0" x2="580" y2="0" gradientUnits="userSpaceOnUse">
					<stop offset="0" stopColor="#cbcbcb" />
					<stop offset="1" stopColor="#8a8a8a" />
				</linearGradient>
				{shimmer ? (
					<linearGradient id={sheen} x1="0" y1="0" x2="220" y2="0" gradientUnits="userSpaceOnUse">
						<stop offset="0" stopColor="#fff" stopOpacity="0" />
						<stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
						<stop offset="1" stopColor="#fff" stopOpacity="0" />
						<animateTransform attributeName="gradientTransform" type="translate" values="200 0; 900 0; 900 0" keyTimes="0; 0.45; 1" dur="3.2s" repeatCount="indefinite" />
					</linearGradient>
				) : null}
			</defs>
			{bare ? null : <rect x="263" y="230" width="760" height="760" rx="170" fill="#000" />}
			<polygon className="fm-logo-top" points="428,418 669,290 816,371 580,500" fill="#c9c9c9" />
			<polygon className="fm-logo-stem" points="428,418 580,500 580,931 428,845" fill={`url(#${side})`} />
			<polygon className="fm-logo-bar" points="580,580 727,509 858,583 580,731" fill="#c4c4c4" />
			{shimmer ? (
				<g fill={`url(#${sheen})`} className="motion-reduce:hidden">
					<polygon points="428,418 669,290 816,371 580,500" />
					<polygon points="428,418 580,500 580,931 428,845" />
					<polygon points="580,580 727,509 858,583 580,731" />
				</g>
			) : null}
		</svg>
	);
}
