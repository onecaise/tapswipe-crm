import { describe, expect, it } from "vitest";

import {
  caretForSignificant,
  countSignificant,
  isAccount,
  isEin,
  isPercent,
  isPhone,
  isRouting,
  isSsn,
  isState,
  isZip,
  maskAccount,
  maskEin,
  maskPercent,
  maskPhone,
  maskRouting,
  maskSsn,
  maskState,
  maskZip,
  matchState,
  applyMask,
  US_STATES,
} from "@/lib/masks";
import {
  PRE_APP_STEPS,
  PRE_APP_STEP_LABELS,
  canEditPreApp,
  defaultPreAppFilter,
  nextStep,
  parsePreAppFilter,
  parsePreAppStep,
  preAppDefaultsFromLead,
  preAppSubmitBlockers,
  prevStep,
  statusBadgeVariant,
} from "@/lib/pre-apps";

/**
 * Pure logic only — no database. These are the rules a rep interacts with on
 * every keystroke, and they are cheap enough to test exhaustively that there is
 * no excuse not to.
 */

describe("phone mask", () => {
  it("formats progressively as digits arrive", () => {
    expect(maskPhone("6")).toBe("6");
    expect(maskPhone("615")).toBe("615");
    expect(maskPhone("6155")).toBe("615-5");
    expect(maskPhone("615555")).toBe("615-555");
    expect(maskPhone("6155551234")).toBe("615-555-1234");
  });

  it("strips whatever the rep or their clipboard supplied", () => {
    expect(maskPhone("(615) 555-1234")).toBe("615-555-1234");
    expect(maskPhone("615.555.1234")).toBe("615-555-1234");
    expect(maskPhone("+1 615 555 1234")).toBe("161-555-5123");
  });

  it("caps at ten digits", () => {
    expect(maskPhone("61555512349999")).toBe("615-555-1234");
  });

  it("is idempotent, which is what makes it safe per keystroke", () => {
    const once = maskPhone("6155551234");
    expect(maskPhone(once)).toBe(once);
  });

  it("accepts a complete number and an empty one, and nothing between", () => {
    expect(isPhone("615-555-1234")).toBe(true);
    expect(isPhone("")).toBe(true);
    expect(isPhone("615-555-123")).toBe(false);
    expect(isPhone("6155551234")).toBe(false);
  });
});

describe("EIN, SSN and ZIP masks", () => {
  it("formats an EIN as xx-xxxxxxx", () => {
    expect(maskEin("12")).toBe("12");
    expect(maskEin("123")).toBe("12-3");
    expect(maskEin("123456789")).toBe("12-3456789");
    expect(isEin("12-3456789")).toBe(true);
    expect(isEin("12-345678")).toBe(false);
  });

  it("formats an SSN as xxx-xx-xxxx", () => {
    expect(maskSsn("123")).toBe("123");
    expect(maskSsn("1234")).toBe("123-4");
    expect(maskSsn("123456")).toBe("123-45-6");
    expect(maskSsn("123456789")).toBe("123-45-6789");
    expect(isSsn("123-45-6789")).toBe(true);
    expect(isSsn("123456789")).toBe(false);
  });

  it("accepts both ZIP and ZIP+4", () => {
    expect(maskZip("37201")).toBe("37201");
    expect(maskZip("372011234")).toBe("37201-1234");
    expect(isZip("37201")).toBe(true);
    expect(isZip("37201-1234")).toBe(true);
    expect(isZip("3720")).toBe(false);
  });

  it("treats a half-typed value as savable but not valid", () => {
    // The whole point of the split: autosave persists "12-3", the step just
    // won't let the rep leave until it's finished.
    expect(maskEin("12-3")).toBe("12-3");
    expect(isEin("12-3")).toBe(false);
  });
});

describe("ABA routing checksum", () => {
  it("accepts real routing numbers", () => {
    // 3-7-1 weighted mod 10. These are genuine published ABA numbers.
    expect(isRouting("021000021")).toBe(true); // Chase
    expect(isRouting("011401533")).toBe(true); // KeyBank
    expect(isRouting("121000248")).toBe(true); // Wells Fargo
  });

  it("rejects a single-digit typo", () => {
    expect(isRouting("021000022")).toBe(false);
  });

  it("rejects a transposition, which is the typo it exists to catch", () => {
    expect(isRouting("021000012")).toBe(false);
  });

  it("is the 3-7-1 weighted checksum, not Luhn", () => {
    // The distinguishing fixture matters. 021000021 (Chase) satisfies BOTH
    // algorithms, so testing with it proves nothing about which one is in use.
    // 011401533 (KeyBank) is ABA-valid and Luhn-invalid, so it separates them.
    const luhn = (v: string) => {
      let sum = 0;
      let double = false;
      for (let i = v.length - 1; i >= 0; i--) {
        let d = Number(v[i]);
        if (double) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
      }
      return sum % 10 === 0;
    };

    expect(luhn("021000021")).toBe(true); // useless as a discriminator
    expect(isRouting("011401533")).toBe(true);
    expect(luhn("011401533")).toBe(false); // this is the one that matters
  });

  it("rejects anything that is not nine digits", () => {
    expect(isRouting("02100002")).toBe(false);
    expect(isRouting("0210000211")).toBe(false);
    expect(maskRouting("0210-0002-1")).toBe("021000021");
  });

  it("still accepts empty, so a draft can hold a partial entry", () => {
    expect(isRouting("")).toBe(true);
  });
});

describe("account number and percentage", () => {
  it("accepts 4 to 17 digits", () => {
    expect(isAccount("1234")).toBe(true);
    expect(isAccount("12345678901234567")).toBe(true);
    expect(isAccount("123")).toBe(false);
    expect(isAccount("123456789012345678")).toBe(false);
    expect(maskAccount("1234-5678")).toBe("12345678");
  });

  it("keeps a percentage inside 0-100 with two decimals", () => {
    expect(maskPercent("60")).toBe("60");
    expect(maskPercent("60.5")).toBe("60.5");
    expect(maskPercent("60.567")).toBe("60.56");
    expect(maskPercent("60.5.7")).toBe("60.57");
    expect(maskPercent("abc60")).toBe("60");
    expect(isPercent("100")).toBe(true);
    expect(isPercent("100.01")).toBe(false);
    expect(isPercent("0")).toBe(true);
  });
});

describe("state list and typeahead", () => {
  it("covers 50 states plus DC", () => {
    expect(US_STATES).toHaveLength(51);
    expect(US_STATES.some((s) => s.code === "DC")).toBe(true);
  });

  it("is sorted by code, so the typeahead order is predictable", () => {
    const codes = US_STATES.map((s) => s.code);
    expect([...codes].sort()).toEqual(codes);
  });

  it("highlights TN for a typed T, per the agreed behaviour", () => {
    expect(matchState("T")).toBe("TN");
    expect(matchState("t")).toBe("TN");
  });

  it("finds a state by name once enough is typed", () => {
    expect(matchState("tex")).toBe("TX");
    expect(matchState("Tennes")).toBe("TN");
  });

  it("prefers a code match over a name match", () => {
    // "MA" is Massachusetts' code; Maine and Maryland's names also start "Ma".
    expect(matchState("MA")).toBe("MA");
  });

  it("returns null rather than guessing", () => {
    expect(matchState("ZZ")).toBeNull();
    expect(matchState("")).toBeNull();
  });

  it("normalises free text from a lead prefill", () => {
    expect(maskState("tn")).toBe("TN");
    expect(maskState("Tennessee")).toBe("TE");
    expect(isState("TN")).toBe(true);
    expect(isState("XX")).toBe(false);
  });
});

describe("caret preservation", () => {
  it("counts only significant characters", () => {
    expect(countSignificant("615-555-1234")).toBe(10);
    expect(countSignificant("615-")).toBe(3);
  });

  it("finds the index just past the nth significant character", () => {
    expect(caretForSignificant("615-555-1234", 3)).toBe(3);
    expect(caretForSignificant("615-555-1234", 4)).toBe(5);
    expect(caretForSignificant("615-555-1234", 0)).toBe(0);
  });

  it("keeps the caret after the character just typed mid-string", () => {
    // "615-1234" with the caret after "615", type 9 -> the browser hands us
    // "6159-1234" with the caret at 4. Four significant characters precede it,
    // so it must land just after the 9 in the reformatted value, not at the end.
    const result = applyMask(maskPhone, "615-1234", "6159-1234", 4);
    expect(result.value).toBe("615-912-34");
    expect(result.caret).toBe(5);
  });

  it("sends the caret to the end on a paste", () => {
    const raw = "(615) 555-1234";
    const result = applyMask(maskPhone, "", raw, raw.length);
    expect(result.value).toBe("615-555-1234");
    expect(result.caret).toBe(result.value.length);
  });

  it("deletes a digit when backspace lands on a separator", () => {
    // The browser removes the hyphen, giving "615555-1234" with the caret at 3.
    // The digit count is unchanged, so the mask would put the hyphen straight
    // back and the key would look dead. Drop the digit before it instead, which
    // is what the rep meant — and note the VALUE changes, which is why this
    // cannot be fixed by moving the caret alone.
    const result = applyMask(
      maskPhone,
      "615-555-1234",
      "615555-1234",
      3,
      true,
    );
    expect(result.value).toBe("615-551-234");
    expect(result.caret).toBe(2);
  });

  it("deletes a digit normally when backspace lands on one", () => {
    // Here the digit count DID drop, so nothing special happens.
    const result = applyMask(
      maskPhone,
      "615-555-1234",
      "615-55-1234",
      6,
      true,
    );
    expect(result.value).toBe("615-551-234");
    // Five digits precede the caret ("61555"), and in "615-551-234" that
    // position is index 6 — the separator shifts it by one.
    expect(result.caret).toBe(6);
  });
});

describe("pre-app vocabulary", () => {
  it("falls back to all for an unknown filter", () => {
    expect(parsePreAppFilter("draft")).toBe("draft");
    expect(parsePreAppFilter("nonsense")).toBe("all");
    expect(parsePreAppFilter(undefined)).toBe("all");
  });

  it("lands an admin on the review queue and a rep on everything", () => {
    expect(defaultPreAppFilter(true)).toBe("submitted");
    expect(defaultPreAppFilter(false)).toBe("all");
  });

  it("falls back to the first step for an unknown step", () => {
    expect(parsePreAppStep("owners")).toBe("owners");
    expect(parsePreAppStep("nonsense")).toBe("business");
    expect(parsePreAppStep(undefined)).toBe("business");
  });

  it("walks the steps and stops at both ends", () => {
    expect(nextStep("business")).toBe("owners");
    expect(nextStep("secrets")).toBe("review");
    // Review is last, which is what makes the shell render Done rather than
    // Next there — and what stops a rep being walked past the submit button.
    expect(nextStep("review")).toBeNull();
    expect(prevStep("business")).toBeNull();
    expect(prevStep("owners")).toBe("business");
    expect(prevStep("review")).toBe("secrets");
  });

  it("keeps a label for every step, so the nav cannot render blank", () => {
    for (const step of PRE_APP_STEPS) {
      expect(PRE_APP_STEP_LABELS[step]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives declined its own badge treatment", () => {
    expect(statusBadgeVariant("approved")).toBe("default");
    expect(statusBadgeVariant("submitted")).toBe("secondary");
    expect(statusBadgeVariant("declined")).toBe("destructive");
    expect(statusBadgeVariant("draft")).toBe("outline");
  });

  it("lets a rep edit only a draft, and an admin anything", () => {
    expect(canEditPreApp("draft", false)).toBe(true);
    expect(canEditPreApp("submitted", false)).toBe(false);
    expect(canEditPreApp("approved", false)).toBe(false);
    expect(canEditPreApp("submitted", true)).toBe(true);
    expect(canEditPreApp("approved", true)).toBe(true);
  });
});

describe("submit blockers mirror the RPC", () => {
  const complete = {
    preApp: {
      dba_name: "Acme Diner",
      legal_business_name: "Acme Diner LLC",
      split_agent_pct: 50,
      split_company_pct: 50,
    },
    owners: [{ percent_owned: 100 }],
    profile: null,
    hasBankingSecrets: true,
    ownersMissingSsn: 0,
  };

  it("reports nothing for a complete pre-app", () => {
    expect(preAppSubmitBlockers(complete)).toEqual([]);
  });

  it("requires an owner at 51% or more", () => {
    expect(
      preAppSubmitBlockers({
        ...complete,
        owners: [{ percent_owned: 50 }, { percent_owned: 50 }],
      }),
    ).toEqual(["One owner must hold at least 51% ownership."]);
  });

  it("requires at least one owner", () => {
    expect(preAppSubmitBlockers({ ...complete, owners: [] })).toEqual([
      "Add at least one owner.",
    ]);
  });

  it("counts owners missing an SSN, singular and plural", () => {
    expect(
      preAppSubmitBlockers({ ...complete, ownersMissingSsn: 1 }),
    ).toContain("One owner has no SSN on file.");
    expect(
      preAppSubmitBlockers({ ...complete, ownersMissingSsn: 3 }),
    ).toContain("3 owners have no SSN on file.");
  });

  it("requires banking details", () => {
    expect(
      preAppSubmitBlockers({ ...complete, hasBankingSecrets: false }),
    ).toContain("Banking details have not been submitted.");
  });

  it("checks the two card-mix pairs independently", () => {
    const profile = {
      id: 1,
      pre_app_id: 1,
      card_swiped_pct: 80,
      card_keyed_pct: 10,
      card_present_pct: 70,
      card_not_present_pct: 30,
      moto_pct: null,
      internet_pct: null,
      test_product_type: null,
      notes: null,
    };
    expect(preAppSubmitBlockers({ ...complete, profile })).toEqual([
      "Swiped and keyed percentages must total 100.",
    ]);
  });

  it("ignores moto and internet entirely", () => {
    // Settled rule: two pairs only. moto/internet are informational and are
    // specifically not summed against card_not_present_pct.
    const profile = {
      id: 1,
      pre_app_id: 1,
      card_swiped_pct: 60,
      card_keyed_pct: 40,
      card_present_pct: 70,
      card_not_present_pct: 30,
      moto_pct: 99,
      internet_pct: 99,
      test_product_type: null,
      notes: null,
    };
    expect(preAppSubmitBlockers({ ...complete, profile })).toEqual([]);
  });

  it("passes a pair that is entirely empty", () => {
    const profile = {
      id: 1,
      pre_app_id: 1,
      card_swiped_pct: 60,
      card_keyed_pct: 40,
      card_present_pct: null,
      card_not_present_pct: null,
      moto_pct: null,
      internet_pct: null,
      test_product_type: null,
      notes: null,
    };
    expect(preAppSubmitBlockers({ ...complete, profile })).toEqual([]);
  });

  it("requires the splits to total 100", () => {
    expect(
      preAppSubmitBlockers({
        ...complete,
        preApp: { ...complete.preApp, split_agent_pct: 60, split_company_pct: 50 },
      }),
    ).toContain("Agent and company splits must total 100.");
  });
});

describe("carrying a lead's fields into a new pre-app", () => {
  const lead = {
    dba: "Dot's Diner",
    merchant_legal_name: "Dot's Diner LLC",
    contact_name: "Dot Owner",
    contact_phone: "(615) 555-1234",
    business_phone: "6155559999",
    contact_email: "dot@dotsdiner.test",
    address: "12 Main St",
    city: "Nashville",
    state: "TN",
    country: "USA",
    zip: "372011234",
  };

  it("maps every overlapping column onto its pre_apps name", () => {
    expect(preAppDefaultsFromLead(lead)).toEqual({
      dba_name: "Dot's Diner",
      legal_business_name: "Dot's Diner LLC",
      contact_name: "Dot Owner",
      contact_phone: "615-555-1234",
      phone_number: "615-555-9999",
      email_address: "dot@dotsdiner.test",
      physical_address: "12 Main St",
      city: "Nashville",
      state: "TN",
      country: "USA",
      zip: "37201-1234",
    });
  });

  it("resolves a state NAME rather than truncating it", () => {
    // maskState("Tennessee") is "TE" — two characters that look like a code and
    // are not one. This is the whole reason matchState is used instead.
    expect(preAppDefaultsFromLead({ ...lead, state: "Tennessee" }).state).toBe(
      "TN",
    );
    expect(preAppDefaultsFromLead({ ...lead, state: "tn" }).state).toBe("TN");
  });

  it("returns null for a state it cannot resolve, rather than guessing", () => {
    expect(preAppDefaultsFromLead({ ...lead, state: "ZZ" }).state).toBeNull();
    expect(preAppDefaultsFromLead({ ...lead, state: "  " }).state).toBeNull();
  });

  it("carries a partial phone across instead of dropping it", () => {
    // The wizard treats a half-typed value as savable-but-not-valid, so the rep
    // sees this and finishes it. Silently discarding what they typed on the
    // lead would be worse.
    const result = preAppDefaultsFromLead({ ...lead, contact_phone: "615555" });
    expect(result.contact_phone).toBe("615-555");
    expect(isPhone(result.contact_phone!)).toBe(false);
  });

  it("turns empty and whitespace-only columns into null, not empty strings", () => {
    const blank = preAppDefaultsFromLead({
      dba: null,
      merchant_legal_name: null,
      contact_name: "   ",
      contact_phone: "",
      business_phone: null,
      contact_email: null,
      address: null,
      city: "",
      state: null,
      country: null,
      zip: null,
    });

    // The two NOT NULL columns are the exception: they feed form inputs, and a
    // controlled input needs a string.
    expect(blank.dba_name).toBe("");
    expect(blank.legal_business_name).toBe("");
    expect(blank.contact_name).toBeNull();
    expect(blank.contact_phone).toBeNull();
    expect(blank.city).toBeNull();
  });

  it("trims the two required columns", () => {
    const result = preAppDefaultsFromLead({
      ...lead,
      dba: "  Dot's Diner  ",
      merchant_legal_name: "  Dot's Diner LLC  ",
    });
    expect(result.dba_name).toBe("Dot's Diner");
    expect(result.legal_business_name).toBe("Dot's Diner LLC");
  });

  it("drops a zip that masks away to nothing", () => {
    expect(preAppDefaultsFromLead({ ...lead, zip: "abc" }).zip).toBeNull();
  });
});
