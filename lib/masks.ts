/**
 * Input formatters for the pre-app form.
 *
 * Eight formats, all of the same shape: strip to a character class, cap the
 * length, splice separators in at fixed offsets. That's small enough that a
 * masking library would be more code than it saves, and it keeps the rules in
 * the same file as the validators that pair with them.
 *
 * Every `mask*` here is **idempotent** — `mask(mask(x)) === mask(x)` — which is
 * what makes it safe to run on every keystroke, on paste, and on a value loaded
 * back out of the database.
 *
 * Every `is*` accepts `""`. A draft has to be able to hold a half-typed value:
 * autosave persists whatever is in the field, and the validator's job is to
 * decide whether the step may be left, not whether the value may be stored.
 *
 * These apply ONLY to `text` columns. A `date`, `time` or `numeric` column
 * cannot accept a partially typed value — PostgREST rejects `"12/3"` for a date
 * with 22007 — so those fields use native inputs instead and never come through
 * here. See SPEC.md §6.1.
 */

const digits = (value: string): string => value.replace(/\D/g, "");

/** Characters a caret can meaningfully sit after; separators are not. */
const isSignificant = (char: string): boolean => /[0-9A-Za-z]/.test(char);

// ---------------------------------------------------------------------------
// Phones — xxx-xxx-xxxx
// ---------------------------------------------------------------------------

export function maskPhone(value: string): string {
  const d = digits(value).slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export const isPhone = (value: string): boolean =>
  value === "" || /^\d{3}-\d{3}-\d{4}$/.test(value);

// ---------------------------------------------------------------------------
// EIN — xx-xxxxxxx
// ---------------------------------------------------------------------------

export function maskEin(value: string): string {
  const d = digits(value).slice(0, 9);
  return d.length <= 2 ? d : `${d.slice(0, 2)}-${d.slice(2)}`;
}

export const isEin = (value: string): boolean =>
  value === "" || /^\d{2}-\d{7}$/.test(value);

// ---------------------------------------------------------------------------
// SSN — xxx-xx-xxxx. Never stored in a normal column; this formats the input
// on its way to submit-pre-app-secrets.
// ---------------------------------------------------------------------------

export function maskSsn(value: string): string {
  const d = digits(value).slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export const isSsn = (value: string): boolean =>
  value === "" || /^\d{3}-\d{2}-\d{4}$/.test(value);

// ---------------------------------------------------------------------------
// ZIP — xxxxx or xxxxx-xxxx
// ---------------------------------------------------------------------------

export function maskZip(value: string): string {
  const d = digits(value).slice(0, 9);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

export const isZip = (value: string): boolean =>
  value === "" || /^\d{5}(-\d{4})?$/.test(value);

// ---------------------------------------------------------------------------
// ABA routing number — 9 digits plus its check digit
// ---------------------------------------------------------------------------

export function maskRouting(value: string): string {
  return digits(value).slice(0, 9);
}

/**
 * Nine digits, and nothing more.
 *
 * The 3-7-1 weighted mod-10 check digit was enforced here until 25 Sep 2026 and
 * was removed deliberately. It refused numbers reps knew were right, and a
 * routing number the processor accepts but this form rejects costs more than
 * the typo it catches. The price is real and worth stating plainly: a
 * transposed pair now reaches the database, gets encrypted, and becomes
 * something nobody can eyeball again.
 *
 * If a checksum is ever restored, it is the 3-7-1 weighted sum
 * `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)` and **not** Luhn —
 * 011401533 (KeyBank) is ABA-valid and Luhn-invalid, so reaching for Luhn
 * rejects real numbers. And it would have to go back into
 * `supabase/functions/_shared/pre-app-secrets.ts` in the same commit, or the
 * form accepts what the function returns a 400 for.
 */
export const isRouting = (value: string): boolean =>
  value === "" || /^\d{9}$/.test(value);

// ---------------------------------------------------------------------------
// Bank account number — 4 to 17 digits
// ---------------------------------------------------------------------------

export function maskAccount(value: string): string {
  return digits(value).slice(0, 17);
}

export const isAccount = (value: string): boolean =>
  value === "" || /^\d{4,17}$/.test(value);

// ---------------------------------------------------------------------------
// Percentages — 0 to 100, at most two decimal places
// ---------------------------------------------------------------------------

export function maskPercent(value: string): string {
  // Keep one decimal point at most, and only digits around it.
  const cleaned = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
  const [whole, fraction] = cleaned.split(".");
  return fraction === undefined
    ? whole.slice(0, 3)
    : `${whole.slice(0, 3)}.${fraction.slice(0, 2)}`;
}

export const isPercent = (value: string): boolean =>
  value === "" ||
  (/^\d{1,3}(\.\d{1,2})?$/.test(value) && Number(value) <= 100);

// ---------------------------------------------------------------------------
// US states — a fixed list, so the value is a code and not free text
// ---------------------------------------------------------------------------

/**
 * The 50 states plus DC, **ordered by code**.
 *
 * That is the order the combobox displays and the order the typeahead resolves
 * ties in, so a typed letter lands on the first option by code: "T" gives TN,
 * which is the agreed behaviour (and holds under either ordering, since
 * Tennessee also precedes Texas by name). Code order is chosen over name order
 * for one practical reason — a test can assert it mechanically with a sort, so
 * it cannot rot. The first draft of this list was silently half one and half
 * the other (AL/AK/AZ/AR by name, IA/ID/IL/IN by code) and nothing caught it.
 */
export const US_STATES = [
  { code: "AK", name: "Alaska" },
  { code: "AL", name: "Alabama" },
  { code: "AR", name: "Arkansas" },
  { code: "AZ", name: "Arizona" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DC", name: "District of Columbia" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "IA", name: "Iowa" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "MA", name: "Massachusetts" },
  { code: "MD", name: "Maryland" },
  { code: "ME", name: "Maine" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MO", name: "Missouri" },
  { code: "MS", name: "Mississippi" },
  { code: "MT", name: "Montana" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "NE", name: "Nebraska" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NV", name: "Nevada" },
  { code: "NY", name: "New York" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VA", name: "Virginia" },
  { code: "VT", name: "Vermont" },
  { code: "WA", name: "Washington" },
  { code: "WI", name: "Wisconsin" },
  { code: "WV", name: "West Virginia" },
  { code: "WY", name: "Wyoming" },
] as const;

export type StateCode = (typeof US_STATES)[number]["code"];

/**
 * Normalises free text toward a state code.
 *
 * Still needed even though the wizard uses a combobox: a pre-app started from a
 * lead inherits `leads.state`, which is unconstrained free text.
 */
export function maskState(value: string): string {
  return value.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
}

export const isState = (value: string): boolean =>
  value === "" || US_STATES.some((state) => state.code === value);

/**
 * The states matching what has been typed, in list (code) order.
 *
 * A match is a prefix of either the code or the name, so "TN" and "tenn" both
 * find Tennessee. An empty query matches everything, which is what the combobox
 * shows when it first opens.
 *
 * This is the single definition of the matching rule: the combobox filters with
 * it and `matchState` is derived from it, so the highlighted option and the
 * visible list can never disagree.
 */
export function filterStates(query: string): readonly (typeof US_STATES)[number][] {
  const q = query.trim().toUpperCase();
  if (q === "") return US_STATES;
  return US_STATES.filter(
    (state) =>
      state.code.startsWith(q) || state.name.toUpperCase().startsWith(q),
  );
}

/**
 * The state the combobox should highlight for what has been typed so far.
 *
 * The first match in list order, so typing "T" lands on TN. Returns null when
 * nothing matches, which is the signal to show no highlight rather than to
 * guess at one.
 */
export function matchState(query: string): StateCode | null {
  if (query.trim() === "") return null;
  return filterStates(query)[0]?.code ?? null;
}

// ---------------------------------------------------------------------------
// Caret preservation
// ---------------------------------------------------------------------------

/**
 * The caret's position means "N significant characters precede me", not "I am
 * at index N". Re-masking changes where the separators fall, so the index has
 * to be re-derived from the count rather than carried over — otherwise typing
 * into the middle of a formatted value throws the caret to the end and the rep
 * types the rest of the number backwards.
 */
export function countSignificant(value: string): number {
  let count = 0;
  for (const char of value) if (isSignificant(char)) count++;
  return count;
}

/** The index just past the nth significant character of `value`. */
export function caretForSignificant(value: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < value.length; i++) {
    if (isSignificant(value[i])) {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return value.length;
}

/**
 * Applies `mask` to what the browser produced, and says where the caret goes.
 *
 * Returns the value as well as the caret because the backspace case cannot be
 * fixed by moving the caret alone. Backspacing over a separator removes a
 * character that carries no information: the digit count is unchanged, the mask
 * puts the separator straight back, and the field looks identical — the key
 * appears dead. The fix is to drop the digit *before* the separator instead,
 * which is what the rep meant, and that changes the value.
 *
 * Detected by comparing significant-character counts against the previous
 * value rather than by inspecting the deleted character, which is not available
 * from a React change event.
 *
 * @param previous the field's value before this edit
 * @param raw      the value the browser produced
 * @param caret    the caret position within `raw`
 */
export function applyMask(
  mask: (value: string) => string,
  previous: string,
  raw: string,
  caret: number,
  deletingBackward = false,
): { value: string; caret: number } {
  let working = raw;
  let before = countSignificant(raw.slice(0, caret));

  if (
    deletingBackward &&
    before > 0 &&
    countSignificant(previous) === countSignificant(raw)
  ) {
    const cut = caretForSignificant(working, before);
    working = working.slice(0, cut - 1) + working.slice(cut);
    before -= 1;
  }

  const value = mask(working);
  return { value, caret: caretForSignificant(value, before) };
}
