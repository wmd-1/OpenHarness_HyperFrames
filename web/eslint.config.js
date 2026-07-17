import js from "@eslint/js";
import tseslintParser from "@typescript-eslint/parser";
import tseslintPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tseslintPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...tseslintPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // TypeScript already enforces undefined references via tsc; the base
      // `no-undef` wrongly flags browser/type globals (window, fetch,
      // EventSource, RequestInit, ...). Turn it off for TS sources.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
];
