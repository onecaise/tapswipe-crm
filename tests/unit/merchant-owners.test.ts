import { describe, expect, it } from "vitest";

import { ownerOptions, type OwnerProfile } from "@/lib/merchant-owners";

const ADMIN = "a0000000-0000-0000-0000-000000000000";
const OTHER_ADMIN = "a1111111-1111-1111-1111-111111111111";
const ZED = "b0000000-0000-0000-0000-000000000000";
const AMY = "c0000000-0000-0000-0000-000000000000";
const GONE = "d0000000-0000-0000-0000-000000000000";

const PROFILES: OwnerProfile[] = [
  { id: ADMIN, full_name: "Ada Admin", role: "admin", is_active: true, agent_number: "9001" },
  { id: OTHER_ADMIN, full_name: "Olga Admin", role: "admin", is_active: true, agent_number: null },
  { id: ZED, full_name: "Zed Rep", role: "agent", is_active: true, agent_number: "4471" },
  { id: AMY, full_name: "Amy Rep", role: "agent", is_active: true, agent_number: null },
  { id: GONE, full_name: "Gone Rep", role: "agent", is_active: false, agent_number: "5555" },
];

describe("ownerOptions", () => {
  it("lists active reps by name with their Agent #, then the admin themself", () => {
    expect(ownerOptions(PROFILES, ADMIN)).toEqual([
      { id: AMY, label: "Amy Rep (no Agent #)" },
      { id: ZED, label: "Zed Rep (Agent # 4471)" },
      { id: ADMIN, label: "Ada Admin (you)" },
    ]);
  });

  it("never offers a deactivated rep or another admin as a NEW owner", () => {
    const ids = ownerOptions(PROFILES, ADMIN).map((o) => o.id);
    expect(ids).not.toContain(GONE);
    expect(ids).not.toContain(OTHER_ADMIN);
  });

  it("keeps a deactivated current owner, labelled, so editing does not silently move it", () => {
    expect(ownerOptions(PROFILES, ADMIN, GONE)[0]).toEqual({
      id: GONE,
      label: "Gone Rep (Agent # 5555) — deactivated",
    });
  });

  it("keeps another admin as current owner, labelled", () => {
    expect(ownerOptions(PROFILES, ADMIN, OTHER_ADMIN)[0]).toEqual({
      id: OTHER_ADMIN,
      label: "Olga Admin (no Agent #) — admin",
    });
  });

  it("does not duplicate a current owner who is already listed", () => {
    expect(ownerOptions(PROFILES, ADMIN, ZED).filter((o) => o.id === ZED)).toHaveLength(1);
    expect(ownerOptions(PROFILES, ADMIN, ADMIN).filter((o) => o.id === ADMIN)).toHaveLength(1);
  });
});
