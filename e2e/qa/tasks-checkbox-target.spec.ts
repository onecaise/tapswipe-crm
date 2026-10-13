import { expect, test, type Page } from "@playwright/test";

import { storageStateFor, type PersonaKey } from "../fixtures/seed";

/**
 * B3 (D-06). The complete-task checkbox on /tasks is 16×16px. That passes
 * WCAG 2.2 AA 2.5.8 through its spacing exception, but on a phone it is a
 * small thing to hit with a thumb. The claim: at 390px wide, every visible
 * checkbox has a 44×44 hit area centred on it, its painted box is still
 * 16×16, and that hit area overlaps no other control.
 *
 * Bounding boxes cannot see a hit area that comes from a pseudo-element (the
 * box stays 16×16 — which is half the point), so the area is measured the way
 * a finger meets it: elementFromPoint across the 44×44 square must land on the
 * checkbox at every sampled point.
 */
const HIT = 44;

async function checkTargets(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks");
  const boxes = page.getByRole("checkbox");
  await expect(boxes.first()).toBeVisible();

  const report = await page.evaluate((hit) => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const checkboxes = Array.from(document.querySelectorAll('[role="checkbox"]')).filter(isVisible);
    const controls = Array.from(
      document.querySelectorAll('a[href], button, input, select, textarea, [role="checkbox"]'),
    )
      .filter(isVisible)
      // Radix renders an aria-hidden, pointer-events:none <input> beside each
      // checkbox for form submission. It is part of the checkbox, not a control
      // a finger can reach, so it is not a "neighbouring control".
      .filter((el) => el.getAttribute("aria-hidden") !== "true")
      .filter((el) => getComputedStyle(el).pointerEvents !== "none");

    return checkboxes.map((cb) => {
      cb.scrollIntoView({ block: "center" });
      const r = cb.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const half = hit / 2 - 1; // 1px inside the square's edge
      const offsets = [-half, -half / 2, 0, half / 2, half];
      const misses: string[] = [];
      for (const dx of offsets) {
        for (const dy of offsets) {
          const at = document.elementFromPoint(cx + dx, cy + dy);
          if (!at || at.closest('[role="checkbox"]') !== cb) {
            misses.push(`(${dx},${dy}) -> ${at?.tagName ?? "nothing"}`);
          }
        }
      }
      const square = { l: cx - hit / 2, t: cy - hit / 2, r: cx + hit / 2, b: cy + hit / 2 };
      const overlaps = controls
        .filter((other) => other !== cb && !cb.contains(other) && !other.contains(cb))
        .filter((other) => {
          const o = other.getBoundingClientRect();
          return o.left < square.r && o.right > square.l && o.top < square.b && o.bottom > square.t;
        })
        .map((other) => `${other.tagName} "${(other.textContent ?? "").trim().slice(0, 30)}"`);
      return {
        label: cb.getAttribute("aria-label"),
        width: Math.round(r.width),
        height: Math.round(r.height),
        misses,
        overlaps,
      };
    });
  }, HIT);

  expect(report.length).toBeGreaterThan(0);
  for (const row of report) {
    expect({ label: row.label, w: row.width, h: row.height }).toEqual({ label: row.label, w: 16, h: 16 });
    expect(row.misses, `${row.label} hit area`).toEqual([]);
    expect(row.overlaps, `${row.label} overlaps`).toEqual([]);
  }
}

for (const persona of ["agent", "admin"] as PersonaKey[]) {
  test.describe(`as ${persona}`, () => {
    test.use({ storageState: storageStateFor(persona) });
    test(`B3 /tasks checkboxes have a 44px hit area at 390px (${persona})`, async ({ page }) => {
      await checkTargets(page);
    });
  });
}
