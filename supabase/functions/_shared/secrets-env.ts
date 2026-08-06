// The one Deno-specific line in the secrets path, isolated so _shared/crypto.ts
// stays runtime-agnostic and testable from Node.
//
// Local serve: `npx supabase functions serve --env-file ./supabase/functions/.env`
// Deployed:    `npx supabase secrets set PRE_APP_SECRETS_KEY=...`

import { KEY_ENV_VAR } from "./crypto.ts";

export function getSecretsKeyEnv(): string | undefined {
  return Deno.env.get(KEY_ENV_VAR);
}
