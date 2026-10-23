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

/**
 * The local stack's mail catcher (Mailpit, :54324). Local only, like the rest
 * of this file: the URL is fixed rather than read from anywhere a hosted
 * address could come from.
 */
const MAILPIT = "http://127.0.0.1:54324/api/v1";

/** Deletes every message to `email`, so the next one read is the new one. */
export async function clearMailTo(email: string): Promise<void> {
  const res = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`mailpit clear: ${res.status}`);
}

/** The newest message to `email`, waiting up to `timeoutMs` for one to arrive. */
export async function latestMailTo(
  email: string,
  timeoutMs = 10_000,
): Promise<{ subject: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`);
    const found = (await res.json()) as { messages: { ID: string; Subject: string }[] };
    if (found.messages.length > 0) {
      const msg = found.messages[0];
      const full = (await (await fetch(`${MAILPIT}/message/${msg.ID}`)).json()) as { HTML: string };
      return { subject: msg.Subject, html: full.HTML };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail to ${email} within ${timeoutMs}ms`);
}

/** Every href in an email's HTML, entity-decoded. */
export function mailLinks(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
}

/**
 * Whose session a browser context holds, read from the @supabase/ssr cookie
 * (possibly chunked as `.0`, `.1`, …). `null` for no session. The cookie is
 * the thing a login CSRF changes, so this asks it directly rather than
 * inferring from what a page renders.
 */
export function sessionEmail(cookies: { name: string; value: string }[]): string | null {
  const chunks = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (chunks.length === 0) return null;
  const raw = chunks.map((c) => decodeURIComponent(c.value)).join("");
  const json = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString() : raw;
  try {
    return (JSON.parse(json) as { user?: { email?: string } }).user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * The local stack as an unauthenticated outsider sees it: the publishable key
 * and nothing else. Implicit flow, so an email it asks for carries the plain
 * token GoTrue's default template puts in the link.
 */
export function publicClient(): SupabaseClient {
  const { apiUrl, publishableKey } = stack();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, flowType: "implicit" },
  });
}
