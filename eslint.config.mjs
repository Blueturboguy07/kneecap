import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import preferObjectParams from "./eslint/rules/prefer-object-params.mjs";

const webFiles = ["apps/web/src/**/*.{ts,tsx}"];

// kneecap M2: the headless engine moved to packages/editor-core. Without this
// scope those ~365 files would silently drop out of lint entirely and the
// error count would "improve" for no reason. It gets the JS + TS rule sets and
// this repo's own `prefer-object-params` rule, but NOT the React / JSX-a11y /
// Next plugins — the whole point of the package is that none of those apply.
// `react/` is the one exception inside the package and is linted as web code.
const coreFiles = ["packages/editor-core/src/**/*.ts"];
const coreReactFiles = ["packages/editor-core/react/**/*.ts"];

const opencutEslintPlugin = {
	meta: {
		name: "eslint-plugin-opencut",
		version: "0.0.0",
	},
	rules: {
		"prefer-object-params": preferObjectParams,
	},
};

function scopeToWebFiles(config) {
	return {
		...config,
		files: webFiles,
	};
}

function scopeToCoreFiles(config) {
	return {
		...config,
		files: [...coreFiles, ...coreReactFiles],
	};
}

export default [
	{
		ignores: ["**/.next/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
	},
	{
		files: webFiles,
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		linterOptions: {
			reportUnusedDisableDirectives: "error",
		},
		settings: {
			react: {
				version: "detect",
			},
		},
	},
	scopeToWebFiles(js.configs.recommended),
	...tseslint.configs.recommended.map(scopeToWebFiles),
	scopeToWebFiles(react.configs.flat.recommended),
	scopeToWebFiles(react.configs.flat["jsx-runtime"]),
	scopeToWebFiles(reactHooks.configs.flat["recommended-latest"]),
	scopeToWebFiles(jsxA11y.flatConfigs.recommended),
	scopeToWebFiles(next.configs["core-web-vitals"]),
	{
		files: webFiles,
		plugins: {
			opencut: opencutEslintPlugin,
		},
		rules: {
			"@typescript-eslint/no-empty-object-type": "warn",
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
			"no-empty": "warn",
			"opencut/prefer-object-params": "error",
			
			// `react/prop-types` is for the JS-era React workflow where runtime
			// `propTypes` declarations are the prop contract. In this TS-only
			// scope the prop types already are the contract; the rule's only
			// effect is false positives when it can't trace destructured props
			// back to a `propTypes` definition that doesn't exist.
			"react/prop-types": "off",
		},
	},
	scopeToWebFiles(eslintConfigPrettier),

	// --- packages/editor-core ------------------------------------------------
	{
		files: [...coreFiles, ...coreReactFiles],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				// The engine targets a WebView, so browser globals are legitimate
				// (Canvas, IndexedDB, WebCodecs, OffscreenCanvas). Node globals are
				// here only for the migration/serializer code paths exercised by
				// `bun test`.
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		linterOptions: {
			reportUnusedDisableDirectives: "error",
		},
	},
	scopeToCoreFiles(js.configs.recommended),
	...tseslint.configs.recommended.map(scopeToCoreFiles),
	{
		files: [...coreFiles, ...coreReactFiles],
		plugins: {
			opencut: opencutEslintPlugin,
		},
		rules: {
			"@typescript-eslint/no-empty-object-type": "warn",
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
			"no-empty": "warn",
			"opencut/prefer-object-params": "error",
			// Belt-and-braces alongside scripts/check-headless.mjs: this one fires
			// in the editor as you type, before CI ever runs.
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "react",
							message:
								"packages/editor-core/src is headless (plan M2). The only React-aware file is packages/editor-core/react/use-editor.ts.",
						},
						{
							name: "sonner",
							message:
								"Use the notification port in @/core/notifications; the host installs a renderer.",
						},
						{
							name: "zustand",
							message:
								"UI state belongs in the host. Engine state lives on EditorCore's managers.",
						},
					],
					patterns: [
						{
							group: ["next", "next/*", "react-dom", "react-dom/*"],
							message:
								"packages/editor-core must not depend on a UI framework or its server renderer (plan M2 exit criterion).",
						},
					],
				},
			],
		},
	},
	// The React bridge is the documented exception to the `react` ban above.
	{
		files: coreReactFiles,
		rules: {
			"no-restricted-imports": "off",
		},
	},
	scopeToCoreFiles(eslintConfigPrettier),
];
