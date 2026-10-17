"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

type VideoProps = {
	videoId: string;
	title?: string;
}

/** Minimal surface of the YouTube IFrame Player API that this component uses. */
type YTPlayer = {
	playVideo(): void;
	pauseVideo(): void;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	getCurrentTime(): number;
	getDuration(): number;
	setPlaybackQuality(quality: string): void;
	unloadModule(module: string): void;
	setOption(module: string, option: string, value: unknown): void;
	destroy(): void;
};

type YTNamespace = {
	Player: new (el: HTMLElement, options: {
		videoId: string;
		host?: string;
		playerVars?: Record<string, number | string>;
		events?: {
			onReady?: (event: { target: YTPlayer }) => void;
			onStateChange?: (event: { data: number }) => void;
			onApiChange?: () => void;
		};
	}) => YTPlayer;
};

declare global {
	interface Window {
		YT?: YTNamespace;
		onYouTubeIframeAPIReady?: () => void;
	}
}

const ENDED = 0;
const PLAYING = 1;
/**
 * The player is laid out at 1080p and scaled to fit, because YouTube picks the stream
 * quality from the player's size (the quality API is mostly ignored).
 */
const PLAYER_W = 1920;
const PLAYER_H = 1080;
/** How far the player's own title bar reaches into the frame; cropped by oversizing the iframe. */
const CROP = 96;

let apiReady: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
	if (window.YT?.Player) return Promise.resolve(window.YT);
	apiReady ??= new Promise((resolve) => {
		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			resolve(window.YT!);
		};
		const script = document.createElement("script");
		script.src = "https://www.youtube.com/iframe_api";
		document.head.appendChild(script);
	});
	return apiReady;
}

function formatTime(seconds: number) {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Plays a YouTube video with nothing of YouTube's chrome on top: a clean thumbnail
 * before playback, then the bare video with our own play/pause and timeline.
 */
export default function YouTubeVideo({ videoId, title = "Formal Mind demo" }: VideoProps) {
	const [started, setStarted] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [scale, setScale] = useState(1);
	const frameRef = useRef<HTMLDivElement>(null);
	const mountRef = useRef<HTMLDivElement>(null);
	const playerRef = useRef<YTPlayer | null>(null);

	useEffect(() => {
		const el = frameRef.current;
		if (!started || !el) return;
		const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / PLAYER_W));
		observer.observe(el);
		return () => observer.disconnect();
	}, [started]);

	useEffect(() => {
		if (!started || !mountRef.current) return;
		let cancelled = false;
		const mount = document.createElement("div");
		mountRef.current.appendChild(mount);

		loadYouTubeApi().then((YT) => {
			if (cancelled) return;
			playerRef.current = new YT.Player(mount, {
				videoId,
				host: "https://www.youtube-nocookie.com",
				playerVars: {
					autoplay: 1,
					cc_load_policy: 0,
					controls: 0,
					disablekb: 1,
					fs: 0,
					iv_load_policy: 3,
					modestbranding: 1,
					playsinline: 1,
					rel: 0,
				},
				events: {
					onReady: ({ target }) => {
						setDuration(target.getDuration());
						// Best effort: YouTube may ignore this; the 1080p player size is what usually decides.
						target.setPlaybackQuality("hd1080");
						target.unloadModule("captions");
						target.playVideo();
					},
					// Captions follow the viewer's YouTube setting; clear the track once the module loads.
					onApiChange: () => playerRef.current?.setOption("captions", "track", {}),
					onStateChange: ({ data }) => {
						setPlaying(data === PLAYING);
						if (data === PLAYING) playerRef.current?.setPlaybackQuality("hd1080");
						if (data === ENDED) {
							setStarted(false);
							setTime(0);
						}
					},
				},
			});
		});

		return () => {
			cancelled = true;
			playerRef.current?.destroy();
			playerRef.current = null;
			mount.remove();
		};
	}, [started, videoId]);

	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => {
			const player = playerRef.current;
			if (!player) return;
			setTime(player.getCurrentTime());
			setDuration(player.getDuration());
		}, 250);
		return () => clearInterval(timer);
	}, [playing]);

	const toggle = useCallback(() => {
		const player = playerRef.current;
		if (!player) return;
		if (playing) player.pauseVideo();
		else player.playVideo();
	}, [playing]);

	const seek = (seconds: number) => {
		setTime(seconds);
		playerRef.current?.seekTo(seconds, true);
	};

	if (!started) {
		return (
			<div className="relative aspect-video overflow-hidden bg-black">
				<button
					type="button"
					onClick={() => setStarted(true)}
					aria-label={`Play video: ${title}`}
					className="group absolute inset-0 flex items-center justify-center focus-visible:outline-none"
				>
					<Image
						src={`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`}
						alt=""
						fill
						sizes="(min-width: 1024px) 50vw, 100vw"
						className="object-cover"
						priority
					/>
					<span className="relative flex size-16 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm transition-transform duration-200 ease-out group-hover:scale-105 group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-white motion-reduce:transition-none">
						<PlayIcon className="ml-1 size-7" />
					</span>
				</button>
			</div>
		);
	}

	const progress = duration ? (time / duration) * 100 : 0;

	return (
		<div ref={frameRef} className="group relative aspect-video overflow-hidden bg-black">
			<div
				ref={mountRef}
				className="absolute left-0 top-0 origin-top-left [&>iframe]:h-full [&>iframe]:w-full"
				style={{ width: PLAYER_W, height: PLAYER_H + CROP * 2, transform: `scale(${scale}) translateY(${-CROP}px)` }}
				title={title}
			/>
			{/* Catches pointer events so the player never shows its own hover overlays. */}
			<button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="absolute inset-0 cursor-pointer focus-visible:outline-none" />

			<div
				className={`absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2.5 pt-8 text-white transition-opacity duration-200 motion-reduce:transition-none ${playing ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : "opacity-100"}`}
			>
				<button
					type="button"
					onClick={toggle}
					aria-label={playing ? "Pause" : "Play"}
					className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
				>
					{playing ? <PauseIcon className="size-4" /> : <PlayIcon className="ml-0.5 size-4" />}
				</button>
				<input
					type="range"
					min={0}
					max={duration || 0}
					step={0.1}
					value={time}
					onChange={(e) => seek(Number(e.target.value))}
					aria-label="Seek"
					className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/30 accent-white [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
					style={{ background: `linear-gradient(to right, white ${progress}%, rgb(255 255 255 / 0.3) ${progress}%)` }}
				/>
				<span className="shrink-0 font-mono text-xs tabular-nums text-white/90">
					{formatTime(time)} / {formatTime(duration)}
				</span>
			</div>
		</div>
	);
}

function PlayIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={`fill-current ${className ?? ""}`} aria-hidden>
			<path d="M8 5.5v13l10.5-6.5L8 5.5z" />
		</svg>
	);
}

function PauseIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={`fill-current ${className ?? ""}`} aria-hidden>
			<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
		</svg>
	);
}
