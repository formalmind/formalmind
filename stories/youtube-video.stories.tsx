import type { Meta, StoryObj } from "@storybook/react-vite";
import YouTubeVideo from "@/components/youtube-video";

const meta = {
	title: "Login/Intro video",
	component: YouTubeVideo,
	args: { videoId: "xyZZqCQlmCE", title: "Formal Mind quick intro" },
	decorators: [(Story) => <div className="max-w-3xl"><Story /></div>],
} satisfies Meta<typeof YouTubeVideo>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
