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

/** The minimum surface of a supabase-js client that these helpers need. */
type QueryClient = {
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

/** Positive integer check — owner_id is `int not null` in the schema. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export const STORAGE_BUCKET = "documents";
