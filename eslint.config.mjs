import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // All of supabase/ is ignored, matching the "supabase" entry in tsconfig.json's
  // exclude. Two different reasons, both real:
  //
  //   * functions/ is Deno. It resolves imports through per-function deno.json
  //     import maps that Node/TS resolution can't see, so linting it here only
  //     produces false positives. The Deno language server checks it instead
  //     (see .vscode/settings.json).
  //   * .temp/ is CLI scratch. `supabase start` writes a bundled
  //     .temp/start-secrets/.../main/index.ts — one minified line that alone
  //     produced 186 errors, so lint passed or failed depending on whether the
  //     local stack had ever been started.
  //
  // Nothing else under supabase/ is Node code (SQL and config.toml), so this
  // costs no coverage.
  //
  // .next is generated build output — flat config doesn't ignore it by default.
  { ignores: ["supabase/**", ".next/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
