import { describe, expect, it } from "vitest";

import {
  BILLING_TYPE_OPTIONS,
  LEGAL_ENTITY_TYPES,
  TERMINAL_BOOLEANS,
  UNSET,
} from "@/lib/pre-app-validation";
import {
  BUSINESS_SECTION,
  OWNER_SECTION,
  OWNER_SSN_FIELD,
  PAPER_COMPLETENESS_CHECKLIST,
  PAPER_OWNER_BLOCKS,
  PROFILE_SECTION,
  SECRET_FIELDS,
  TERMINAL_SECTION,
  type PaperFieldEntry,
  type PaperSection,
} from "@/lib/pre-app-form-fields";

/**
 * The printable blank form's field inventory.
 *
 * Division of labour worth stating, because it decides what belongs here.
 * Whether the inventory COVERS every column is settled by the compiler — each
 * section in lib/pre-app-form-fields.ts is `satisfies Record<…Key, PaperField>`
 * over the real row type, so a new `pre_apps` column fails `npx tsc --noEmit`
 * rather than failing a test. There is no point re-asserting that here, and a
 * runtime copy of the key list would be the very drift the satisfies prevents.
 *
 * What types cannot see is everything below: that a label is not the empty
 * string, that the labels and options agree with the constants the wizard
 * actually renders from, and that no field was quietly given two entries.
 */

const fieldsOf = (section: PaperSection): PaperFieldEntry[] =>
  section.groups.flatMap((group) => group.fields);

const ALL_SECTIONS = [
  BUSINESS_SECTION,
  OWNER_SECTION,
  TERMINAL_SECTION,
  PROFILE_SECTION,
];

describe("every printed field is answerable", () => {
  it("has a non-empty label and a group", () => {
    for (const section of ALL_SECTIONS) {
      for (const field of fieldsOf(section)) {
        expect(field.label.trim(), `${section.title}.${field.key}`).not.toBe("");
        expect(field.group.trim(), `${section.title}.${field.key}`).not.toBe("");
      }
    }

    for (const field of [...SECRET_FIELDS, OWNER_SSN_FIELD]) {
      expect(field.label.trim(), field.key).not.toBe("");
    }
  });

  it("gives each column exactly one entry", () => {
    for (const section of ALL_SECTIONS) {
      const keys = fieldsOf(section).map((field) => field.key);
      expect(new Set(keys).size, `${section.title} has a duplicate`).toBe(
        keys.length,
      );
    }
  });

  it("keeps a field in exactly one group", () => {
    // groupsOf() buckets by the `group` string, so a typo would silently create
    // a second heading with one field under it rather than an error.
    for (const section of ALL_SECTIONS) {
      for (const group of section.groups) {
        expect(group.fields.length, `${section.title} / ${group.title}`)
          .toBeGreaterThan(0);
      }
    }
  });
});

describe("the paper form asks what the wizard asks", () => {
  /**
   * These counts are the wizard's, read off the step components. They are not
   * a restatement of the inventory: if someone adds a column, the compiler
   * forces an inventory entry, and THIS is what then notices the paper form
   * grew — so the number has to be updated deliberately, with a look at the
   * printed layout, rather than drifting.
   */
  it("carries the same number of fields per step", () => {
    expect(fieldsOf(BUSINESS_SECTION)).toHaveLength(24);
    expect(fieldsOf(OWNER_SECTION)).toHaveLength(16);
    expect(fieldsOf(TERMINAL_SECTION)).toHaveLength(24);
    expect(fieldsOf(PROFILE_SECTION)).toHaveLength(8);
    // SSN is per owner and lives in the owner block; the other three are the
    // banking pair plus the terminal password.
    expect(SECRET_FIELDS).toHaveLength(3);
  });

  it("marks exactly the two fields that are required at entry", () => {
    const required = ALL_SECTIONS.flatMap((section) =>
      fieldsOf(section).filter((field) => field.required === true),
    ).map((field) => field.key);

    expect(required).toEqual(["dba_name", "legal_business_name"]);
  });

  it("prints every terminal option the wizard offers, with its own label", () => {
    // The strongest assertion here: TERMINAL_BOOLEANS is what terminal-step.tsx
    // renders from, so comparing against it pins all eleven labels to their
    // real source rather than to a copy someone eyeballed.
    const ticks = fieldsOf(TERMINAL_SECTION)
      .filter((field) => field.kind === "checkbox")
      .map((field) => [field.key, field.label]);

    expect(ticks).toEqual(TERMINAL_BOOLEANS.map(([key, label]) => [key, label]));
  });

  it("offers the real billing types and entity types", () => {
    const billing = fieldsOf(BUSINESS_SECTION).find(
      (field) => field.key === "billing_type",
    );
    // The wizard's list carries the "not set" sentinel, which is a select's way
    // of saying nothing was chosen. On paper that is just a box left blank.
    const realBilling = BILLING_TYPE_OPTIONS.filter(
      (option) => option.value !== UNSET,
    ).map((option) => option.label);

    expect(billing?.options).toEqual(realBilling);

    const entity = fieldsOf(BUSINESS_SECTION).find(
      (field) => field.key === "legal_entity_type",
    );
    expect(entity?.options).toEqual([...LEGAL_ENTITY_TYPES]);
  });
});

describe("the completeness checklist", () => {
  it("lists every submission blocker", () => {
    // preAppBlockers() produces nine distinct reasons; the paper form reprints
    // them because only two fields are required to SAVE a draft, so the field
    // list alone cannot tell a rep whether the form is finished.
    expect(PAPER_COMPLETENESS_CHECKLIST).toHaveLength(9);
    for (const item of PAPER_COMPLETENESS_CHECKLIST) {
      expect(item.trim()).not.toBe("");
    }
  });

  it("prints more than one owner block", () => {
    // One block would leave a two-owner business nowhere to record the second,
    // which is exactly the paper-to-digital loss this form exists to prevent.
    expect(PAPER_OWNER_BLOCKS).toBeGreaterThan(1);
  });
});
