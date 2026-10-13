"use client";

import { ACCOUNT_DEACTIVATED } from "@/lib/auth-copy";
import { postLoginPath } from "@/lib/login-redirect";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = createClient();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        // A banned account is a deactivated one (deactivate-user bans first),
        // so it gets the deactivated page's words rather than GoTrue's raw
        // "User is banned" (D-01). By code, with the message as a fallback for
        // an older GoTrue that sends none. Every other error — wrong password
        // and unknown address alike — keeps GoTrue's generic "Invalid login
        // credentials", which does not say whether the account exists.
        if (error.code === "user_banned" || error.message === "User is banned") {
          setError(`${ACCOUNT_DEACTIVATED.title}. ${ACCOUNT_DEACTIVATED.remedy}`);
          return;
        }
        throw error;
      }
      // Back to the page the proxy intercepted, if any (D-03), through
      // safeNextPath() — lib/login-redirect.ts. Read from window.location at
      // submit time rather than useSearchParams(), which under
      // cacheComponents would need a Suspense boundary around the whole form.
      router.push(postLoginPath(window.location.search));
      // Server components cache per-session; without this they can render the
      // pre-login session on the first paint after signing in.
      router.refresh();
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>
            Enter your email below to login to your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin}>
            {/*
              One grid, so DOM order and visual order can differ (QA-011).
              The tab order is the DOM order — Email, Password, Login, then
              "Forgot your password?" — while the link is PLACED beside the
              Password label (`col-start-2 row-start-3`). It used to sit in the
              label row before the input, so Tab from Email landed on the link
              and a keyboard-only login ended on /auth/forgot-password. Never a
              positive tabIndex: that reorders the whole page, not this form.
              `mt-4` + `gap-y-2` reproduces the old gap-6 between groups.
            */}
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2">
              <Label htmlFor="email" className="col-span-2">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="m@example.com"
                required
                className="col-span-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Label htmlFor="password" className="mt-4">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                required
                className="col-span-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <p className="col-span-2 mt-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="col-span-2 mt-4 w-full"
                disabled={isLoading}
              >
                {isLoading ? "Logging in..." : "Login"}
              </Button>
              <Link
                href="/auth/forgot-password"
                className="col-start-2 row-start-3 mt-4 justify-self-end text-sm underline-offset-4 hover:underline"
              >
                Forgot your password?
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
