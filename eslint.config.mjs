import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import configPrettier from "eslint-config-prettier";
import pluginOnlyWarn from "eslint-plugin-only-warn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	{
		extends: [
			eslint.configs.recommended,
			tseslint.configs.strictTypeChecked,
			configPrettier,
		],
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: 2022,
			globals: globals.node,
			parserOptions: {
				project: ["./tsconfig.eslint.json"],
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			"only-warn": pluginOnlyWarn,
		},
		rules: {
			// ---------- JavaScript ----------

			// Enforce consistent brace style for all control statements
			curly: "warn",

			// Require `===` when `==` can be ambiguous
			eqeqeq: ["warn", "always"],

			// Disallow the use of `console.log`, which helps not forget them after debugging; for permanent logging, use `console.info/warn/warn`
			"no-console": ["warn", { allow: ["info", "warn", "error"] }],

			// Disallow the use of `eval()`; if `eval()` is necessary, use `// eslint-disable-next-line no-eval` where it's needed
			"no-eval": "warn",

			// Disallow `new` operators with the `Function` object, as this is similar to `eval()`; if necessary, use `// eslint-disable-next-line no-new-func` where it's needed
			"no-new-func": "warn",

			// Disallow reassigning function parameters
			"no-param-reassign": "warn",

			"no-restricted-syntax": [
				"warn",
				{
					// "selector": ":not(BinaryExpression:matches([operator='!=='], [operator='==='])) > Literal[value=null]",
					selector: "Literal[value=null]",
					message: "Don't use 'null', use 'undefined'.",
				},
			],

			// Disallow ternary operators when simpler alternatives exist; example: prevent `const x = y === 1 ? true : false` in favour of `const x = y === 1`
			"no-unneeded-ternary": "warn",

			// Disallow renaming import, export, and destructured assignments to the same name; example: prevent `const { a: a } = b;` in favour of `const { a } = b;`
			"no-useless-rename": "warn",

			// Disallow throwing anything else than the `Error object`
			"no-throw-literal": "warn",

			// Require method and property shorthand syntax for object literals; example: prevent `a = { b: b };` in favour of `a = { b };`
			"object-shorthand": "warn",

			// ---------- TypeScript ----------

			// Enforce consistent usage of type imports
			// Will activate when VS Code's feature "organise imports" manages that automatically
			// "@typescript-eslint/consistent-type-imports": "warn",

			// Disallow variable declarations from shadowing variables declared in the outer scope; necessitates to disable `no-shadow`, see https://typescript-eslint.io/rules/no-shadow
			"no-shadow": "off",
			"@typescript-eslint/no-shadow": "warn",

			// Disallow certain types in boolean expressions
			"@typescript-eslint/strict-boolean-expressions": [
				"warn",
				{ allowNullableBoolean: true },
			],

			// Allow numbers in template literals — common in CLI output
			"@typescript-eslint/restrict-template-expressions": [
				"warn",
				{ allowNumber: true },
			],
		},
	},
	{
		// Vitest's matcher types can't be resolved with commonjs moduleResolution;
		// disable the unsafe-* rules for test files to avoid noise.
		files: ["**/*.test.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
		},
	},
);
