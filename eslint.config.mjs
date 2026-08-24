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
  //
  // playwright-report/ and test-results/ are the same trap as supabase/.temp/,
  // and it has already sprung once: the HTML reporter only unpacks its bundled
  // trace-viewer assets when a run has something to show, so `npm run lint` was
  // clean until an e2e test failed and then reported 3027 errors in
  // playwright-report/trace/assets/*.js. Lint that passes or fails according to
  // whether the last test run was green is worse than no lint. Both are
  // gitignored, so nothing here is repo code.
  {
    ignores: [
      "supabase/**",
      ".next/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
