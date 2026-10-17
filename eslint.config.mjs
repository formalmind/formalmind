import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
  {
    // /auth/* is served by the Auth0 middleware and needs a full page load, so those links
    // stay <a>. The catch-all route makes this rule mistake them for client-side pages.
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
];

export default eslintConfig;
