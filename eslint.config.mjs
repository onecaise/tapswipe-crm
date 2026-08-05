import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Deno Edge Functions resolve imports through per-function deno.json import
  // maps that Node/TS resolution can't see, so linting them here only produces
  // false positives. They're checked by the Deno language server instead
  // (see .vscode/settings.json).
  //
  // .next is generated build output — flat config doesn't ignore it by default,
  // and linting it accounts for the bulk of the pre-existing error count.
  { ignores: ["supabase/functions/**", ".next/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
