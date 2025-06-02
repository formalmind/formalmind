type VideoProps = {
	videoId: string;
}
export default function YouTubeVideo(props: VideoProps) {
	const url = `https://www.youtube.com/embed/${props.videoId}`
	return (
		<div className="video-container">
			<iframe width="560" height="315" src={url} title="YouTube video player" frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen></iframe>
		</div >
	);
}
