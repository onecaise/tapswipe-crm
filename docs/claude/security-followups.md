# Security follow-ups: recorded, not built

Items from the October 2026 outside review (and found while fixing it) that were deliberately **not** built on branch `security-fixes`. Each has a severity, the evidence for it, and a suggested fix. The fixes that were built are in `docs/claude/security-fixes.md`.

## Block a staged residual row whose merchant's MID changed since the file was read

- **Severity:** Low (defence in depth; the attack it covers needs an admin since 20261021120000).
- **Evidence:** `commit_residual_import_v2` finds the share for a staged row with `left join merchants m on m.mid = r.mid_raw` — the merchant's MID **at commit**. `parse-residual-import` already stores `merchant_id` on each staged row, resolved from `mid_raw` when the file was read. If the merchant's MID changes between the read and the commit, the row matches no merchant, commits as an ordinary line, and a shared account is paid unshared. Phase 1 made MID admin-only and audited every change (`merchant_mid_changed`); an admin padding or correcting a MID during review still produces this.
- **Suggested fix:** in `commit_residual_import_v2`'s guards, refuse the batch (PT409, before the plan) when any staged row has `merchant_id is not null` and that merchant's current `mid is distinct from mid_raw`, with a sentence like "A merchant's MID changed after this file was read. Read the file again." Mirror it in `parse-residual-import` as a blocker so the review screen shows it, since "read again" already re-resolves `merchant_id`. Tests: the phase 1 attack test, re-run as an admin, must refuse instead of committing unshared.
- **Rejected alternative:** storing the MID on `merchant_rep_shares` and matching on it. A legitimate MID change would then detach the share in the other direction, and it needs two sources of truth kept in step. Reasoning in `docs/claude/security-fixes.md`, phase 1.
