declare const __APP_VERSION__: string;
declare const __COMMIT__: string;

/** What this build is, on the web and in the desktop app: "v0.1.3 · abc1234". Set by the Vite configs. */
const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const commit = typeof __COMMIT__ === "string" ? __COMMIT__ : "";
export const BUILD = [version && `v${version}`, commit].filter(Boolean).join(" · ");
