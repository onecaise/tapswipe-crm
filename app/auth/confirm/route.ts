import { safeNextPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // Followed after the OTP verifies, so it must be a path on this site — see
  // lib/safe-redirect.ts (QA-001). Anything else lands on `/`, which the proxy
  // sends on to /dashboard.
  const next = safeNextPath(searchParams.get("next"), "/");

  if (token_hash && type) {
    const supabase = await createClient();

    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    if (!error) {
      // redirect user to specified redirect URL or root of app
      redirect(next);
    } else {
      // A fixed code, never GoTrue's message (A3): the message used to go into
      // the URL unencoded, and /auth/error printed whatever arrived. The real
      // reason stays in the server log, where it is useful and nobody can
      // forge it.
      console.error("auth/confirm: verifyOtp failed:", error.message);
      redirect("/auth/error?error=link-invalid");
    }
  }

  redirect("/auth/error?error=link-incomplete");
}
