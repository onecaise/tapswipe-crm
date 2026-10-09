import { expect, test } from "@playwright/test";

import { PERSONAS, TIMELINE_FIXTURE, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * QA-008. When an Edge Function is down — the runtime answering 502/503 with a
 * plain-text body, or the request never reaching it — edgeFunctionErrorMessage()
 * found no `{ error }` JSON and fell back to supabase-js's own `.message`, so a
 * rep clicking Download read "Edge Function returned a non-2xx status code" or
 * "Failed to send a request to the Edge Function": the exact string
 * lib/edge-functions.ts exists to keep off the screen. Every caller passes a
 * readable fallback ("Could not open that document."); it was never reached.
 */
test.use({ storageState: storageStateFor("agent") });

async function timelineLeadId(): Promise<number> {
  const db = service();
  const { data: agent } = await db.from("profiles").select("id").eq("email", PERSONAS.agent.email).single();
  const { data } = await db
    .from("leads")
    .select("id")
    .eq("agent_id", agent!.id)
    .eq("dba", TIMELINE_FIXTURE.dba)
    .single();
  return data!.id as number;
}

const RAW = /non-2xx|Failed to send a request|Edge Function/i;

for (const mode of ["503 with a plain-text body", "unreachable"] as const) {
  test(`QA-008 a download while the function is ${mode} reads as a sentence`, async ({ page }) => {
    await page.route("**/functions/v1/create-download-url", (route) =>
      mode === "unreachable"
        ? route.abort("connectionrefused")
        : route.fulfill({ status: 503, contentType: "text/plain", body: "upstream connect error" }),
    );
    await page.goto(`/leads/${await timelineLeadId()}`);
    await page
      .getByRole("button", { name: `Download ${TIMELINE_FIXTURE.docFileName}` })
      .first()
      .click();

    await expect(page.getByText("Could not open that document.")).toBeVisible();
    await expect(page.getByText(RAW)).toHaveCount(0);
  });
}
