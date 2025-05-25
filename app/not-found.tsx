import Image from "next/image"

export default function Page() {
	return (
		<div className="flex bg-muted flex-1 h-svh justify-center items-center">
			<Image src="/NotFound.svg" width={250} height={250} alt="Page Not Found." />
		</div>
	)
}
