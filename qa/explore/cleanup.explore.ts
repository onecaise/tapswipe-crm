import { test } from "@playwright/test";
import { service } from "./stack";

/**
 * Removes what the exploratory runs created in the LOCAL database: rows whose
 * names start "QA " / "QA-" and the qa-*@tapswipe.test accounts (which own no
 * records). Run last. Everything here is local fake data.
 */
test("cleanup QA exploration data", async () => {
  const db = service();
  const report = (what: string, error: { message: string } | null) => console.log(what, error?.message ?? "ok");

  report("ghost_sheets", (await db.from("ghost_sheets").delete().like("dba", "QA %")).error);
  report("ghost_sheets qa", (await db.from("ghost_sheets").delete().like("dba", "E2E-QA-GHOST-%")).error);

  const { data: tickets } = await db.from("support_tickets").select("id").like("subject", "QA %");
  const ticketIds = (tickets ?? []).map((t) => t.id);
  if (ticketIds.length) {
    // support_ticket_replies cascades with its ticket (and service_role holds no grant on it).
    report("tickets", (await db.from("support_tickets").delete().in("id", ticketIds)).error);
  }

  const { data: leads } = await db.from("leads").select("id").like("dba", "QA %");
  const leadIds = (leads ?? []).map((l) => l.id);
  if (leadIds.length) {
    await db.from("notes").delete().eq("owner_type", "lead").in("owner_id", leadIds);
    await db.from("tasks").delete().eq("owner_type", "lead").in("owner_id", leadIds);
    report("leads", (await db.from("leads").delete().in("id", leadIds)).error);
  }

  const { data: pre } = await db.from("pre_apps").select("id").eq("dba_name", "QA-PREAPP-WALK");
  for (const p of pre ?? []) {
    const owners = ((await db.from("pre_app_owners").select("id").eq("pre_app_id", p.id)).data ?? []).map((o) => o.id);
    if (owners.length) await db.from("pre_app_owner_secrets").delete().in("pre_app_owner_id", owners);
    await db.from("pre_app_banking_secrets").delete().eq("pre_app_id", p.id);
    await db.from("pre_app_terminal_secrets").delete().eq("pre_app_id", p.id);
    await db.from("pre_app_owners").delete().eq("pre_app_id", p.id);
    await db.from("pre_app_terminal").delete().eq("pre_app_id", p.id);
    await db.from("pre_app_business_profile").delete().eq("pre_app_id", p.id);
    report(`pre_app ${p.id}`, (await db.from("pre_apps").delete().eq("id", p.id)).error);
  }

  report("quotes", (await db.from("quotes").delete().eq("title", "QA agent2 proposal")).error);

  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users.users.filter((x) => /^qa-.*@tapswipe\.test$/.test(x.email ?? ""))) {
    await db.from("audit_log").delete().eq("actor_id", u.id);
    await db.from("audit_log").delete().eq("row_id", u.id);
    await db.from("profiles").delete().eq("id", u.id);
    report(`user ${u.email}`, (await db.auth.admin.deleteUser(u.id)).error);
  }
});
