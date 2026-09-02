// Shared helpers for create-user / deactivate-user / admin-reset-password.
//
// Deliberately dependency-free: it takes clients as arguments rather than
// importing @supabase/server, so it needs no deno.json import map of its own.
// Same arrangement as _shared/documents.ts.

/** The roles profiles.role's CHECK constraint allows. */
export const ROLES = ["agent", "admin"] as const;

export type Role = (typeof ROLES)[number];

/**
 * A ban long enough to be permanent in practice (~100 years).
 *
 * GoTrue has no "disable forever" flag — `banned_until` is a timestamp, so
 * blocking an account means setting one far enough out that it never arrives.
 * "none" is the documented value that clears it again.
 */
export const PERMANENT_BAN_DURATION = "876000h";

/**
 * The minimum surface of a supabase-js client these helpers need.
 *
 * Structural rather than importing SupabaseClient, so this file stays free of
 * the import map. The shapes are only as wide as what is actually called.
 */
type QueryClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type AdminClient = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
};

/**
 * Four lines duplicated from _shared/documents.ts on purpose.
 *
 * Sharing it would mean either importing a documents-named module into the admin
 * functions, or extracting a third _shared file and editing two working
 * deployed functions to point at it. Neither is worth it for a JSON wrapper;
 * if a third caller ever appears, extract then.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Fails closed unless the caller is an active admin.
 *
 * Must go through the CALLER-scoped client. is_admin() is `security definer` and
 * reads the caller's own profile via auth.uid(), so on a service-role connection
 * — which has no auth.uid() — it returns false for everyone, including real
 * admins. Exactly the same trap callerIsActive() documents in documents.ts.
 *
 * is_admin() already requires `is_active`, so this subsumes the active check for
 * admins. The functions still call callerIsActive() first, so a deactivated
 * caller gets "account is not active" rather than a misleading "admin only".
 */
export async function callerIsAdmin(supabase: QueryClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return data === true;
}

/**
 * Fails closed unless the caller has an active profile.
 *
 * Same reasoning and the same caller-scoped requirement as callerIsAdmin above.
 */
export async function callerIsActive(supabase: QueryClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_active_agent");
  if (error) return false;
  return data === true;
}

/**
 * Alphabet for generated passwords, minus the characters a human misreads.
 *
 * No 0/O, 1/l/I, or symbols: this password is read aloud over a phone or pasted
 * from a chat message by an admin onboarding a rep, and a temporary credential
 * that gets mistyped just generates a support request. Length carries the
 * entropy instead — 20 characters over this 55-character alphabet is ~115 bits,
 * far past anything the six-character minimum in config.toml requires.
 */
const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const PASSWORD_LENGTH = 20;

/**
 * A cryptographically random temporary password.
 *
 * crypto.getRandomValues, not Math.random: this is a credential.
 *
 * Rejection sampling rather than `% alphabet.length`, which would bias toward
 * the first few characters. The bias would be small and completely invisible,
 * which is the reason to just avoid it.
 */
export function generateTempPassword(): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const out: string[] = [];

  while (out.length < PASSWORD_LENGTH) {
    const bytes = new Uint8Array(PASSWORD_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) {
        out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
        if (out.length === PASSWORD_LENGTH) break;
      }
    }
  }

  return out.join("");
}

export function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

/**
 * Deliberately permissive: one @, no spaces, a dot in the domain.
 *
 * The authority on whether an address is usable is GoTrue, which rejects what it
 * cannot accept — this only catches obvious typos before a round trip. A stricter
 * regex here would reject valid addresses and be the harder bug to diagnose.
 */
export function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/** Trimmed, non-empty display name. */
export function isFullName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The cap set_agent_number() enforces in SQL. Keep the two in step. */
export const AGENT_NUMBER_MAX_LENGTH = 32;

/**
 * A processor's rep code, as it appears in the "Agent #" column of a residual
 * report.
 *
 * Deliberately permissive about *shape*: no digits-only rule, because processors
 * issue codes with letters and hyphens, and a stricter regex here would reject a
 * real code on the one screen that can record it. The only rules are the ones the
 * database also enforces — trimmed, non-empty, and within the length the column's
 * consumers expect.
 *
 * Duplicated in SQL, not shared: set_agent_number() in
 * 20260817101500_agent_number.sql applies the same trim and the same 32-character
 * cap. Nothing type-checks the pair (the RPC is the other write path to this
 * column), so change both together. The failure mode if they drift is
 * one-directional and confusing: create-user accepts a value the RPC would
 * refuse, or vice versa, and the admin sees an error on one screen but not the
 * other for the same string.
 */
export function isAgentNumber(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= AGENT_NUMBER_MAX_LENGTH;
}

/**
 * Records an admin action against a user.
 *
 * actor_id is passed explicitly rather than defaulting to auth.uid(): this runs
 * on the service-role client, which has no auth.uid() at all, so the caller's id
 * has to be carried over from the verified JWT.
 *
 * Best-effort by design. A failed audit write must not roll back an action that
 * already happened at the Auth layer — that would leave the account changed and
 * the response claiming failure, which is a worse lie than a missing log line.
 * Returns the error so the caller can surface it.
 */
export async function writeAudit(
  supabaseAdmin: AdminClient,
  actorId: string,
  action: string,
  targetUserId: string,
): Promise<unknown> {
  const { error } = await supabaseAdmin.from("audit_log").insert({
    actor_id: actorId,
    action,
    table_name: "profiles",
    row_id: targetUserId,
  });
  return error ?? null;
}

/**
 * The minimum surface of the service-role client's Auth admin API needed to
 * look a user up by address. Structural, for the same reason as the types above.
 */
type AuthAdminClient = {
  auth: {
    admin: {
      listUsers: (params: { page: number; perPage: number }) => PromiseLike<{
        data: { users?: { id: string; email?: string | null }[] } | null;
        error: unknown;
      }>;
    };
  };
};

export type AuthUser = { id: string; email?: string | null };

/**
 * Three outcomes, kept distinct on purpose: found, definitively absent, and
 * "the lookup itself failed". Collapsing the last two would make a transient
 * Auth error look like proof that no such account exists, which is the one
 * conclusion a caller must not draw from a failed read.
 */
export type AuthUserLookup =
  | { ok: true; user: AuthUser | null }
  | { ok: false; error: string };

const USER_PAGE_SIZE = 200;

/**
 * Bounded so a lookup can never become an unbounded scan on a project that grew
 * past what anyone expected. 50 x 200 is 10,000 accounts — orders of magnitude
 * past this CRM's ceiling, and if it is ever exceeded the answer is a "not
 * found" that the caller reports rather than a function that hangs.
 */
const USER_MAX_PAGES = 50;

/**
 * Finds the auth.users row for an address.
 *
 * GoTrue's admin API has no get-by-email, so this pages listUsers and matches
 * locally. Addresses are compared lower-cased because callers normalise before
 * writing but GoTrue is the authority on what it actually stored.
 *
 * Only for use where profiles cannot answer the question. profiles carries a
 * denormalised `email` copy and is the cheaper read — but the case this exists
 * for is precisely an auth.users row with no profiles row, which that copy
 * cannot see by definition.
 */
export async function findAuthUserByEmail(
  supabaseAdmin: AuthAdminClient,
  email: string,
): Promise<AuthUserLookup> {
  const wanted = email.trim().toLowerCase();

  for (let page = 1; page <= USER_MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: USER_PAGE_SIZE,
    });

    if (error) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "unknown error";
      return { ok: false, error: message };
    }

    const users = data?.users ?? [];
    const match = users.find(
      (user) => (user.email ?? "").trim().toLowerCase() === wanted,
    );
    if (match) return { ok: true, user: match };

    // A short page is the last page.
    if (users.length < USER_PAGE_SIZE) return { ok: true, user: null };
  }

  return { ok: true, user: null };
}
