/**
 * Service-role access to the LOCAL stack for the QA regression specs, plus the
 * fixture-id lookups they share with the exploratory runs in qa/explore/.
 * Refuses a non-local API URL, like e2e/fixtures/seed.ts.
 */
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: { apiUrl: string; serviceKey: string; publishableKey: string } | null = null;

/** Local stack only — refuses anything else, like e2e/fixtures/seed.ts. */
export function stack() {
  if (cached) return cached;
  const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
  const cfg = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) cfg.set(m[1], m[2]);
  }
  const apiUrl = cfg.get("API_URL")!;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) throw new Error(`non-local ${apiUrl}`);
  cached = { apiUrl, serviceKey: cfg.get("SERVICE_ROLE_KEY")!, publishableKey: cfg.get("PUBLISHABLE_KEY")! };
  return cached;
}

export function service(): SupabaseClient {
  const { apiUrl, serviceKey } = stack();
  return createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type Ids = {
  personaId: string;
  merchant: number; lead: number; preApp: number; ticket: number;
  ghost: number | null; proposalGroup: string | null;
};

export async function idsFor(email: string, persona: string): Promise<Ids> {
  const db = service();
  const { data: p } = await db.from("profiles").select("id").eq("email", email).single();
  const id = p!.id as string;
  const marker = `E2E-DOC-${persona}`;
  const one = async (t: string, col: string) =>
    ((await db.from(t).select("id").eq("agent_id", id).eq(col, marker).maybeSingle()).data?.id as number);
  const ghost = (await db.from("ghost_sheets").select("id").eq("agent_id", id).limit(1).maybeSingle()).data?.id ?? null;
  const pg = (await db.from("quotes").select("quote_group_id").eq("agent_id", id).limit(1).maybeSingle()).data?.quote_group_id ?? null;
  return {
    personaId: id,
    merchant: await one("merchants", "mid"),
    lead: await one("leads", "dba"),
    preApp: await one("pre_apps", "dba_name"),
    ticket: await one("support_tickets", "subject"),
    ghost: ghost as number | null,
    proposalGroup: pg as string | null,
  };
}

export const QA_PASSWORD = "qa-test-password-123";

/**
 * A throwaway QA account, created or reset to a known state. `profile: null`
 * removes the profiles row (the ghost-user state); otherwise the row is
 * upserted with the overrides given. Owns no records, so it can be deleted
 * with a bare deleteUser.
 */
export async function ensureQaUser(
  email: string,
  profile: Record<string, unknown> | null,
): Promise<string> {
  const db = service();
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  let user = data.users.find((u) => u.email === email);
  if (!user) {
    const created = await db.auth.admin.createUser({ email, password: QA_PASSWORD, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`${email}: ${created.error?.message}`);
    user = created.data.user;
  }
  const reset = await db.auth.admin.updateUserById(user.id, { password: QA_PASSWORD, ban_duration: "none" });
  if (reset.error) throw new Error(`${email} reset: ${reset.error.message}`);
  if (profile === null) {
    await db.from("profiles").delete().eq("id", user.id);
  } else {
    const { error } = await db.from("profiles").upsert({
      id: user.id, email, full_name: `QA ${email.split("@")[0]}`, role: "agent",
      is_active: true, must_change_password: false, ...profile,
    });
    if (error) throw new Error(`${email} profile: ${error.message}`);
  }
  return user.id;
}
