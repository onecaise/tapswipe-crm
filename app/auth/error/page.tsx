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
    title: "This account has been deactivated",
    detail:
      "The sign-in worked, but the account is switched off, so it has no " +
      "access to any records. An admin can turn it back on.",
  },
};

async function ErrorContent({
  searchParams,
}: {
  searchParams: Promise<{ error: string }>;
}) {
  const params = await searchParams;
  const known = params?.error ? MESSAGES[params.error] : undefined;

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
      </>
    );
  }

  return params?.error ? (
    <p className="text-sm text-muted-foreground">Code error: {params.error}</p>
  ) : (
    <p className="text-sm text-muted-foreground">
      An unspecified error occurred.
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
