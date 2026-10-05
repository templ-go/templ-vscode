import js from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.customize({
    indent: 2,
    quotes: "double",
    semi: true,
    arrowParens: true,
    braceStyle: "1tbs",
  }),
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      curly: ["error", "all"],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      // vscode-languageclient's own public API (DynamicFeature<any>) and the
      // untyped LSP workspace/configuration response force real uses of any.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["dist/", "out/", "node_modules/"],
  },
);
