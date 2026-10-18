import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
	{ ignores: ["dist", ".wrangler", "node_modules", "storybook-static", "desktop/dist", "desktop/src-tauri/target", "desktop/src-tauri/gen"] },
	...tseslint.configs.recommended,
	{
		plugins: { "react-hooks": reactHooks },
		rules: {
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
		},
	},
);
