import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatComposer } from "@/components/chat-composer";
import type { OpenAIModel } from "@/lib/models";

const meta = {
	title: "Chat/Composer",
	component: ChatComposer,
	args: {
		value: "",
		onChange: () => {},
		onSubmit: () => {},
		onStop: () => {},
		isLoading: false,
		model: "gpt-6-luna",
		onModelChange: () => {},
	},
	render: function Render(args) {
		const [value, setValue] = useState(args.value);
		const [model, setModel] = useState<OpenAIModel>(args.model ?? "gpt-6-luna");
		return (
			<div className="max-w-2xl">
				<ChatComposer {...args} value={value} onChange={(e) => setValue(e.target.value)} onSubmit={() => setValue("")} model={model} onModelChange={setModel} />
			</div>
		);
	},
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithRepo: Story = { args: { repo: { owner: "asyncswap", name: "v2-proofs" } } };

export const SwarmContext: Story = {
	args: {
		placeholder: "Ask about the agents…",
		context: <span className="inline-flex h-8 items-center rounded-full bg-muted px-3 text-xs font-medium">asyncswap/v2-proofs swarm</span>,
	},
};

export const Streaming: Story = { args: { value: "What is each agent doing right now?", isLoading: true } };
