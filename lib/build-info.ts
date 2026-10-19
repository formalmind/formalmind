declare const __APP_VERSION__: string;
declare const __COMMIT__: string;

/** What this build is: "v0.1.3 · abc1234" in the desktop app, "abc1234" on the web. Set by the Vite configs. */
const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const commit = typeof __COMMIT__ === "string" ? __COMMIT__ : "";
export const BUILD = [version && `v${version}`, commit].filter(Boolean).join(" · ");
