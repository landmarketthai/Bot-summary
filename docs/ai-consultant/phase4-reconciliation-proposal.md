# Phase 4 proposal — Consultant ↔ Auto Reconciliation (NOT implemented)

Status: proposal only. Nothing in Phase 1–3 writes business data, and this
document does not authorize any write path.

## Goal

When a document ends without being saved (for example the 2026-10-07 ชั่งคืน of
น้อย–ราชพฤกษ์: 23 lines read, line 22 unreadable, round closed), the consultant
should be able to tell the worker *what an admin can do about it* and, later,
*what the admin actually did* — without the consultant itself ever changing
records.

## Proposed boundary

```
worker question ─▶ consultant (read-only) ─▶ diagnosis + "admin recovery available?"
                                              │
admin action  ─▶ reconciliation service (writes, separately authorized, audited)
                                              │
                                              ▼
                       recovery outcome row (append-only)
                                              │
worker question ─▶ consultant reads outcome ─▶ "ผู้ดูแลกู้รายการให้แล้ว / ยังรอตรวจ"
```

1. **Dry-run evidence feed.** Reuse `planFailedSessionRecovery`
   (`src/lib/produce/failed-session-recovery.ts`, already read-only). Expose its
   verdict per generation (`would_recover`, `already_persisted`,
   `still_blocked`, `empty`) to the consultant as an extra read-only field, so
   the worker hears "ผู้ดูแลกู้รายการนี้ได้" vs "ต้องให้ผู้ดูแลตรวจเอกสารก่อน".
2. **Apply stays outside the consultant.** The apply step must re-enter the
   normal finalizer as a NEW generation (as the dry-run module already
   requires), so `imported_sessions` fingerprints remain the only duplicate
   guard and the 23 accepted lines are never inserted twice.
3. **Outcome record.** An additive, append-only table (e.g.
   `produce_recovery_outcomes(failed_generation, new_generation,
   produce_session_id, decided_by, decided_at, verdict)`) lets the consultant
   report a recovery truthfully. The consultant reads it; only the admin
   reconciliation path writes it.
4. **Authorization.** Recovery apply is an admin web action (Supabase auth +
   `app_metadata.role = admin`, see `src/lib/auth/admin.ts`), never a LINE
   command and never a model tool.

## Explicitly out of scope until approved

- Any LLM tool that writes, approves, finalizes or reopens.
- Automatic recovery of the 2026-10-07 incident.
- Changes to sales sold-out rules (see `sold-out-risk.md`).
