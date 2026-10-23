import { continueUrl, parseConfirmLink } from "@/lib/confirm-link";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

/**
 * The address the reset email links to. It verifies NOTHING (phase 7).
 *
 * It used to call `verifyOtp` right here, on a GET, which is a login CSRF: a
 * rep could take the token out of their own email and send an admin the link,
 * and opening it signed the admin in as the rep, with no click and nothing on
 * screen to say so. It also meant a mail scanner that fetches links ahead of
 * the reader used up a reset link before the person could open it.
 *
 * Now a GET only checks the link's shape (lib/confirm-link.ts) and sends it on
 * to the Continue page. The token is exchanged by that page's Server Action,
 * which runs only on a same-origin POST. The redirects to /auth/error are the
 * same fixed codes as before (A3).
 */
export async function GET(request: NextRequest) {
  const parsed = parseConfirmLink(new URL(request.url).searchParams);
  if (!parsed.ok) redirect(`/auth/error?error=${parsed.error}`);
  redirect(continueUrl(parsed.link));
}
