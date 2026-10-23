import { ACCOUNT_DEACTIVATED } from "@/lib/auth-copy";
import { createClient } from "@/lib/supabase/server";
import { LogoutTextButton } from "@/components/logout-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Suspense } from "react";

/**
 * What each code from lib/auth.ts actually means, in words.
 *
 * Previously this page printed "Code error: <code>" and nothing else, which is
 * fine for a code nobody expects and useless for the four that are routed here
 * deliberately. `no-profile` and `profile-unavailable` in particular are a pair
 * that used to be one code, and telling them apart is the whole point of
 * having two — so the page has to actually distinguish them to the reader.
 */
const MESSAGES: Record<string, { title: string; detail: string }> = {
  "no-profile": {
    title: "This account is not set up yet",
    detail:
      "You signed in, but the account has no profile attached, so there is " +
      "nothing for it to show. An admin needs to finish creating it — it " +
      "cannot be fixed from here.",
  },
  "profile-unavailable": {
    title: "We could not load your profile",
    detail:
      "Your account is fine — reading it failed. This is a fault on our side " +
      "rather than anything about your account, and it usually means the app " +
      "and the database are out of step. The details are in the server log.",
  },
  "account-deactivated": {
    title: ACCOUNT_DEACTIVATED.title,
    detail:
      "The sign-in worked, but the account is switched off, so it has no " +
      `access to any records. ${ACCOUNT_DEACTIVATED.remedy}`,
  },
  // The two codes /auth/confirm sends (A3). It used to put GoTrue's own
  // message in the URL instead.
  "link-invalid": {
    title: "This link has expired or was already used",
    detail:
      "Sign-in and password links work once and only for a short time. " +
      "Ask for a new one, or sign in with your password.",
  },
  "link-incomplete": {
    title: "This link is incomplete",
    detail:
      "Part of the link is missing — it may have been cut off when it was " +
      "copied. Open it straight from the email, or ask for a new one.",
  },
  // Phase 7: /auth/confirm takes only the link types the app sends.
  "link-unsupported": {
    title: "This kind of link is not used here",
    detail:
      "The only email links this app sends are password resets. Sign in " +
      "with your password, or use Forgot password to get a reset link.",
  },
};

/**
 * The two states a user reaches *signed in* with nothing they can do (D-02).
 * Without a way out the session stayed live in that browser; the next person at
 * the desk was "signed in" as an account that sees nothing.
 */
const SIGN_OUT_CODES = new Set(["no-profile", "account-deactivated"]);

/** Only offer to end a session that exists — a stray link reaches here too. */
async function hasSession(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

async function ErrorContent({
  searchParams,
}: {
  searchParams: Promise<{ error: string }>;
}) {
  const params = await searchParams;
  // Own keys only: `?error=constructor` would otherwise find Object's and be
  // treated as known, echoing the value back under "Code:".
  const known =
    typeof params?.error === "string" && Object.hasOwn(MESSAGES, params.error)
      ? MESSAGES[params.error]
      : undefined;

  if (known) {
    return (
      <>
        <p className="font-medium">{known.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{known.detail}</p>
        {/* Kept visible even when we have real words for it: it is what
            someone reporting the problem can quote, and what a log search
            matches on. */}
        <p className="mt-3 text-xs text-muted-foreground">
          Code: {params.error}
        </p>
        {SIGN_OUT_CODES.has(params.error) && (await hasSession()) && (
          <div className="mt-4">
            <LogoutTextButton />
          </div>
        )}
      </>
    );
  }

  // Never the value itself (A3). `?error=` is whatever the link says, so
  // printing it let anyone put their own sentence on our page. Only the codes
  // in MESSAGES are ours; for anything else the page speaks for itself.
  return (
    <p className="text-sm text-muted-foreground">
      An unexpected error occurred. Try signing in again; if it keeps
      happening, tell an admin what you were doing when it appeared.
    </p>
  );
}

export default function Page({
  searchParams,
}: {
  searchParams: Promise<{ error: string }>;
}) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">
                Sorry, something went wrong.
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Suspense>
                <ErrorContent searchParams={searchParams} />
              </Suspense>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
