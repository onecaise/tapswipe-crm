// Shared helpers for create-upload-url / create-download-url.
//
// Deliberately dependency-free: it takes clients as arguments rather than
// importing @supabase/server, so it doesn't need its own deno.json import map.

/** Mirrors the check constraint on documents.owner_type. */
export const DOCUMENT_OWNER_TYPES = [
  "pre_app",
  "merchant",
  "support_ticket",
  "lead",
] as const;

export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

/**
 * owner_type -> the table that carries the agent_id for that owner.
 *
 * documents.owner_id has no foreign key (it can't — it's polymorphic), so
 * nothing in the schema stops a row pointing at a record the uploader doesn't
 * own. This map is what lets the upload path close that gap.
 */
const OWNER_TABLES: Record<DocumentOwnerType, string> = {
  pre_app: "pre_apps",
  merchant: "merchants",
  support_ticket: "support_tickets",
  lead: "leads",
};

/**
 * The minimum surface of a supabase-js client that these helpers need.
 *
 * Exported so a function can type a helper of its own against the caller-scoped
 * client without importing supabase-js — the point of this module being
 * dependency-free is that it needs no import map, and pulling in the real
 * SupabaseClient type would undo that.
 */
export type QueryClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        maybeSingle: () => PromiseLike<{
          data: Record<string, unknown> | null;
          error: unknown;
        }>;
      };
    };
  };
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function isOwnerType(value: unknown): value is DocumentOwnerType {
  return DOCUMENT_OWNER_TYPES.includes(value as DocumentOwnerType);
}

/**
 * Fails closed unless the caller has an active profile.
 *
 * These functions run with `verify_jwt = false`, so `withSupabase({auth:"user"})`
 * is what authenticates the JWT — but a valid JWT only proves *who* the caller
 * is, not that their account is still enabled. A deactivated agent keeps a
 * working token until it expires, so this is checked explicitly rather than
 * assumed.
 *
 * is_active_agent() is `security definer` and reads the caller's own profile via
 * auth.uid(), so calling it through the RLS-scoped client returns the truth for
 * whoever presented the JWT. Calling it via supabaseAdmin would NOT work — there
 * is no auth.uid() on a service-role connection, so it would return false.
 */
export async function callerIsActive(supabase: QueryClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_active_agent");
  if (error) return false;
  return data === true;
}

/**
 * Resolves the agent that owns the parent record, or null if the caller can't
 * see it.
 *
 * The lookup deliberately goes through the caller-scoped client, so Row Level
 * Security decides visibility. That means the agent_id comparison and the
 * is_active_agent() gating are enforced by the same policies the rest of the app
 * uses, rather than being re-implemented here where they could drift. An agent
 * sees only their own records; an admin sees all.
 *
 * Returns null both when the record doesn't exist and when it belongs to someone
 * else — indistinguishable on purpose, so this can't be used to probe ids.
 */
export async function resolveParentAgentId(
  supabase: QueryClient,
  ownerType: DocumentOwnerType,
  ownerId: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(OWNER_TABLES[ownerType])
    .select("agent_id")
    .eq("id", ownerId)
    .maybeSingle();

  if (error || !data) return null;
  const agentId = data.agent_id;
  return typeof agentId === "string" ? agentId : null;
}

/**
 * Storage object key: {agent_id}/{owner_type}/{owner_id}/{uuid}
 *
 * agent_id is the *parent record's* owner, not necessarily the uploader — so an
 * admin uploading on a rep's behalf files it under that rep, keeping everything
 * for one merchant under one prefix and ownership auditable from the key alone.
 *
 * The original filename is not part of the key: it's stored in documents.file_name
 * instead, so the display name survives without letting user input shape a
 * storage path or collide across agents.
 */
export function buildFileKey(
  agentId: string,
  ownerType: DocumentOwnerType,
  ownerId: number,
  uuid: string,
): string {
  return `${agentId}/${ownerType}/${ownerId}/${uuid}`;
}

/**
 * True when a stored file_key really is the key for that row's owner triple.
 *
 * The documents row is inserted by the BROWSER — create-upload-url signs a key
 * and hands it back, and the client writes the metadata. So file_key,
 * owner_type and owner_id all arrive from the client, and the insert policy
 * checks only agent_id. Signing whatever file_key a row carries therefore used
 * to be a cross-agent read: insert a row with your own agent_id and someone
 * else's key, ask for a download URL, and the service role signs it for you.
 * Measured, against the running stack, before this existed.
 *
 * Re-deriving the key here rather than trusting the column is the same instinct
 * as resolveParentAgentId going through the caller's client: don't re-implement a
 * check, and don't accept a value the client could have chosen.
 *
 * The database now carries the same rule as a CHECK constraint
 * (documents_file_key_matches_owner). This is not redundant with it: that
 * constraint is NOT VALID, so rows written before it exist are exempt, and this
 * is what stops one of those being used as a read primitive.
 *
 * Structural rather than a prefix test, and the difference is not cosmetic. A
 * bare `startsWith` on the prefix also accepts `{agent}/{type}/{id}/` with
 * nothing after it — a directory, which signs a URL that can never resolve — and
 * `{agent}/{type}/{id}/a/b`, a nested key create-upload-url would never mint.
 * Neither crosses a trust boundary, but going through parseFileKey costs nothing
 * and makes this agree exactly with the constraint instead of approximately.
 * The uuid segment itself is only required to be non-empty; it is random, so
 * there is nothing to compare it to.
 */
export function fileKeyMatchesOwner(
  fileKey: unknown,
  agentId: unknown,
  ownerType: unknown,
  ownerId: unknown,
): boolean {
  if (
    typeof fileKey !== "string" ||
    typeof agentId !== "string" ||
    typeof ownerType !== "string" ||
    (typeof ownerId !== "number" && typeof ownerId !== "string")
  ) {
    return false;
  }

  const parsed = parseFileKey(fileKey);
  if (!parsed) return false;

  return (
    parsed.agentId === agentId &&
    parsed.ownerType === ownerType &&
    // ownerId arrives as a number from PostgREST and as whatever JSON carried
    // elsewhere, so compare as text — the parsed value is already known to be a
    // positive integer.
    String(parsed.ownerId) === String(ownerId)
  );
}

/**
 * Reads a storage key back into the triple it encodes, or null if it isn't one.
 *
 * The inverse of buildFileKey. Used by delete-document's orphan-cleanup path,
 * which has no documents row to read owner_type and owner_id from — the whole
 * point of that path is that the row was never written. Parsing them out of the
 * key is safe because nothing is *trusted*: the parsed owner record is then
 * looked up through the caller's own client, so RLS still decides.
 *
 * Deliberately strict about shape. Exactly four segments, none empty, and the
 * third must be a positive integer — so a key with a traversal segment, a
 * trailing slash, or extra path depth is rejected outright rather than
 * half-understood.
 */
export function parseFileKey(
  fileKey: string,
): { agentId: string; ownerType: string; ownerId: number; uuid: string } | null {
  const parts = fileKey.split("/");
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) return null;

  const [agentId, ownerType, ownerIdRaw, uuid] = parts;
  if (!/^[0-9]+$/.test(ownerIdRaw)) return null;
  const ownerId = Number(ownerIdRaw);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return null;

  return { agentId, ownerType, ownerId, uuid };
}

/** Positive integer check — owner_id is `int not null` in the schema. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export const STORAGE_BUCKET = "documents";
