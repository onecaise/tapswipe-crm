import { confirmEmailLink } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CONFIRM_LINK_COPY, parseConfirmLink } from "@/lib/confirm-link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The page an email link lands on, via `GET /auth/confirm` (phase 7). Opening
 * it changes nothing: the token is exchanged only when the button POSTs to
 * `confirmEmailLink`. So a link someone else sent you cannot sign you in as
 * them unless you press Continue on a page that says what it does, and a mail
 * scanner fetching the link ahead of you no longer uses it up.
 */
async function ContinueForm({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const parsed = parseConfirmLink({
    get: (name: string) => {
      const value = params[name];
      return Array.isArray(value) ? value[0] : value;
    },
  });
  // Only reachable by editing the URL: /auth/confirm already sent a bad link
  // to the error page.
  if (!parsed.ok) redirect(`/auth/error?error=${parsed.error}`);
  const { tokenHash, type, next } = parsed.link;
  const copy = CONFIRM_LINK_COPY[type];

  // The attack this page exists for lands on someone who is already signed in,
  // so say whose session continuing would replace.
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const signedInAs =
    typeof data?.claims?.email === "string" ? data.claims.email : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{copy.title}</CardTitle>
        <CardDescription>{copy.detail}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={confirmEmailLink} className="flex flex-col gap-4">
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="next" value={next} />
          {signedInAs && (
            <p className="text-sm text-muted-foreground" role="note">
              You are signed in as <strong>{signedInAs}</strong>. Continuing
              signs you out of that account and into the one this link was
              sent to. If you did not ask for this email, close this page.
            </p>
          )}
          <Button type="submit" className="w-full">
            {copy.button}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense>
          <ContinueForm searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
