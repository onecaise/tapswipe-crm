"use server";

import { parseConfirmLink } from "@/lib/confirm-link";
import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Exchanges an email link's token for a session: the step `GET /auth/confirm`
 * used to do on arrival (phase 7).
 *
 * Only a same-origin POST gets here. Next aborts a Server Action whose `Origin`
 * does not match the host, so another site cannot auto-submit this form to
 * sign a visitor in as someone else; the Continue button is then the only way
 * in, and the page says what it is about to do. The `Sec-Fetch-Site` check
 * below says the same thing again in this file, so the rule does not rest on
 * one framework default nobody here can see.
 *
 * The link is parsed again rather than trusted from the page: the form's
 * hidden fields are whatever the POST says, so the type allow-list and the
 * safe `next` are applied to them exactly as to the URL.
 */
export async function confirmEmailLink(formData: FormData) {
  const fetchSite = (await headers()).get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    redirect("/auth/error?error=link-invalid");
  }

  const parsed = parseConfirmLink(formData);
  if (!parsed.ok) redirect(`/auth/error?error=${parsed.error}`);
  const { tokenHash, type, next } = parsed.link;

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    // A fixed code, never GoTrue's message (A3). The real reason stays in the
    // server log.
    console.error("auth/confirm: verifyOtp failed:", error.message);
    redirect("/auth/error?error=link-invalid");
  }
  redirect(next);
}
