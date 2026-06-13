import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Ignore generated and dependency directories
  { ignores: ["dist/", "node_modules/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Disable ESLint rules that conflict with Prettier formatting
  prettier,

  {
    rules: {
      // Use logger (Pino) everywhere — console is not allowed in app code
      "no-console": "error",

      // Always use === / !==
      eqeqeq: ["error", "always"],

      // TypeScript-specific
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Enforce `import type` for type-only imports (already the convention)
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },

  {
    // cli.ts is a user-facing script — console output is intentional
    files: ["src/cli.ts"],
    rules: { "no-console": "off" },
  },
);
