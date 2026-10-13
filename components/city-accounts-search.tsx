"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import { US_STATES } from "@/lib/masks";
import {
  CITY_ACCOUNTS_CAP,
  MAX_CITY_LENGTH,
  type CityAccountsResult,
  statusIntent,
} from "@/lib/merchants";
import { StatusBadge } from "@/components/status-badge";
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

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; city: string; state: string; result: CityAccountsResult };

/**
 * "Find accounts in a city" — does the company already have accounts there?
 *
 * Calls accounts_in_city(), which is security definer and reads every rep's
 * book, so WHAT THIS RENDERS IS DECIDED BY THE FUNCTION, NOT BY THIS FILE. A
 * rep's rows arrive with four keys (dba, legal name, city, state) and nothing
 * else; an admin's carry the link id, rep, status, street and zip as well.
 * The extra columns below render when the KEYS are present rather than when
 * a role prop says so, so there is no client-side flag that could show a field
 * the server did not send — and nothing to show if it did not.
 *
 * Deliberately a submit-to-search form with no typeahead and no list of
 * cities: the function only answers a city the caller already names, and an
 * autocomplete would turn it into a directory of where the company does
 * business, one keystroke at a time.
 */
export function CityAccountsSearch() {
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const cityId = useId();
  const stateId = useId();
  const statusId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // The one check worth doing before the round trip. Everything else —
    // length, letters after normalising, the state's shape — is the
    // function's rule and comes back as a sentence (22023 passes through
    // friendlyDbError verbatim).
    if (city.trim() === "") {
      setSearch({ kind: "error", message: "Enter a city." });
      return;
    }

    setSearch({ kind: "loading" });
    const supabase = createClient();
    const { data, error } = await supabase.rpc("accounts_in_city", {
      city,
      state: state === "" ? null : state,
    });

    if (error) {
      setSearch({
        kind: "error",
        message: friendlyDbError(error, "Could not search that city."),
      });
      return;
    }

    setSearch({
      kind: "done",
      city: city.trim(),
      state,
      result: data as CityAccountsResult,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Find accounts in a city</h2>
        </CardTitle>
        <CardDescription>
          Check whether the company already has accounts in a city, across
          every rep&apos;s book. Type the full city name.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          aria-describedby={statusId}
          noValidate
        >
          <div className="grid min-w-0 flex-1 gap-2">
            <Label htmlFor={cityId}>City</Label>
            <Input
              id={cityId}
              name="city"
              autoComplete="off"
              maxLength={MAX_CITY_LENGTH}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="grid gap-2 sm:w-48">
            <Label htmlFor={stateId}>State (optional)</Label>
            <select
              id={stateId}
              name="state"
              className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">Any state</option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={search.kind === "loading"}>
            {search.kind === "loading" ? "Searching…" : "Search"}
          </Button>
        </form>

        <div id={statusId} aria-live="polite" className="flex flex-col gap-3">
          <SearchOutcome search={search} />
        </div>
      </CardContent>
    </Card>
  );
}

function SearchOutcome({ search }: { search: SearchState }) {
  if (search.kind === "idle") return null;

  if (search.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Searching…</p>;
  }

  if (search.kind === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {search.message}
      </p>
    );
  }

  const { results, has_more } = search.result;
  const where = search.state ? `${search.city}, ${search.state}` : search.city;

  if (results.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No accounts found in that city.
      </p>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {has_more
          ? `Showing the first ${CITY_ACCOUNTS_CAP} accounts in ${where}.`
          : `${results.length} ${results.length === 1 ? "account" : "accounts"} in ${where}.`}
      </p>
      <ul className="flex flex-col gap-2" aria-label={`Accounts in ${where}`}>
        {results.map((account, i) => (
          <li
            key={account.merchant_id ?? `${account.dba}-${i}`}
            className="flex min-w-0 flex-col gap-1 rounded-md border p-3"
          >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 break-words font-medium">
                {account.merchant_id !== undefined ? (
                  <Link
                    href={`/merchants/${account.merchant_id}`}
                    className="underline underline-offset-4"
                  >
                    {account.dba}
                  </Link>
                ) : (
                  account.dba
                )}
              </span>
              {account.status !== undefined && (
                <StatusBadge intent={statusIntent(account.status)}>
                  {account.status}
                </StatusBadge>
              )}
            </div>
            {account.legal_business_name && (
              <span className="min-w-0 break-words text-sm text-muted-foreground">
                {account.legal_business_name}
              </span>
            )}
            <span className="text-sm">
              {account.city}, {account.state}
            </span>
            {account.agent_id !== undefined && (
              <span className="min-w-0 break-words text-xs text-muted-foreground">
                Rep: {account.agent_name ?? "Unknown rep"}
                {account.street || account.zip
                  ? ` · ${[account.street, account.zip].filter(Boolean).join(", ")}`
                  : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
      {has_more && (
        <p className="text-sm text-muted-foreground">
          {search.state
            ? "More accounts exist than are shown here."
            : "More accounts exist than are shown here. Pick a state to narrow the list."}
        </p>
      )}
    </>
  );
}
