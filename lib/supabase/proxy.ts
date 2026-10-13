import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { nextFromDeepLink, postLoginPath } from "@/lib/login-redirect";

/**
 * The starter's `if (!hasEnvVars) return supabaseResponse;` escape hatch used to
 * sit here, and it is deliberately gone rather than merely unused.
 *
 * It failed open: with either public env var unset it skipped the session check
 * for every route, so a deploy missing a variable served the whole CRM with no
 * redirect to /auth/login in the pipeline. `lib/env-guard.ts` does not cover
 * that case — it only throws when NODE_ENV is "development". Without the hatch,
 * createServerClient() below throws on a missing key and the request 500s,
 * which is the direction an auth guard should fail in. CLAUDE.md marked
 * `hasEnvVars` for deletion "once the template UI is replaced"; that happened on
 * 2026-09-14 and this was its last caller.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // With Fluid compute, don't put this client in a global environment
  // variable. Always create a new one on each request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and
  // supabase.auth.getClaims(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: If you remove getClaims() and you use server-side rendering
  // with the Supabase client, your users may be randomly logged out.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  // `/` is a signpost with nothing on it — see app/page.tsx, which holds the
  // same two-way redirect as a backstop. Doing it here as well is what makes
  // the hop flash-free: under `cacheComponents` a page's static shell paints
  // before its dynamic segment can stream a redirect, so the page alone would
  // show a blank frame first. It was the starter's marketing page until
  // 2026-09-14, which is why it used to be exempted from the check below
  // instead of handled.
  //
  // The cookies are copied across deliberately. `getClaims()` above may have
  // rotated the session, and setAll() wrote the new pair onto `supabaseResponse`
  // — a bare NextResponse.redirect() would drop them and hand the browser a
  // token that has just been superseded, which is the random-logout failure the
  // comments in this file keep warning about. The `!user` branch below has no
  // session to preserve, so it is left as the starter wrote it.
  if (request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/dashboard" : "/auth/login";
    const redirectResponse = NextResponse.redirect(url);
    supabaseResponse.cookies
      .getAll()
      .forEach((cookie) => redirectResponse.cookies.set(cookie));
    return redirectResponse;
  }

  // A signed-in user opening /auth/login (D-03 / C1b) goes where signing in
  // would have taken them: a safe `?next=`, else /dashboard. ACTIVE profiles
  // only, and that is the whole loop guard — /dashboard sends an inactive or
  // profile-less user to /auth/error, so bouncing them from here would leave
  // them no way to reach the form and sign in as someone else. A user whose
  // profile cannot be read gets the form too: failing towards the login page
  // is the safe direction. Cookies copied across for the reason given on the
  // `/` branch above.
  if (user && request.nextUrl.pathname === "/auth/login") {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_active")
      .eq("id", user.sub)
      .maybeSingle();
    if (profile?.is_active === true) {
      const target = new URL(
        postLoginPath(request.nextUrl.search),
        request.nextUrl.origin,
      );
      const redirectResponse = NextResponse.redirect(target);
      supabaseResponse.cookies
        .getAll()
        .forEach((cookie) => redirectResponse.cookies.set(cookie));
      return redirectResponse;
    }
  }

  // The stale `/login` exemption is gone with it: auth lives under `/auth/*`
  // and there has never been a top-level `/login` route, so all it did was
  // exempt a 404 from the session check.
  if (!user && !request.nextUrl.pathname.startsWith("/auth")) {
    // no user, potentially respond by redirecting the user to the login page —
    // carrying where they were going (D-03), so signing in lands them there
    // rather than on /dashboard. Through safeNextPath() here as well as in the
    // login form: see lib/login-redirect.ts.
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    url.search = "";
    const next = nextFromDeepLink(
      request.nextUrl.pathname,
      request.nextUrl.search,
    );
    if (next !== null) url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  return supabaseResponse;
}
