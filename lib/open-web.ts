/** True inside the Mac app. */
export const inDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
