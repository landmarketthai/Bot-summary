# Produce Product Code Dictionary — release record and UAT handoff

Optional short codes (`ม02` = `กล้วยน้ำว้า`) so operators stop keying product
names by hand. Released 2026-08-13.

## Release identities

| | |
|---|---|
| Starting main | `8626212ae3bb32dfc48efad49195654fcd9ce603` (PR #45) |
| Branch | `claude/product-code-dictionary-4kevf5` |
| Feature commit | `5601d29b595139501b5b32839bd74cef42856b5e` |
| PR | [#46](https://github.com/Andromedas47/Bot-summary/pull/46) |
| Merge SHA | `7cfa161b5586fc4128a0ac9041211e6a1752a980` |
| CI | pg-tests run `31695232171` — 11/11 green |
| Vercel deployment | `dpl_8gGnNNRnRzKWB36YMdzpQpfYQ1qk`, target `production`, state `READY` |
| Deployed SHA | `7cfa161b5586fc4128a0ac9041211e6a1752a980` (matches merge) |
| Aliases | `bot-summary.vercel.app` |
| Supabase project | `Bot-summary` / `apjjsqibavjaitcedavn`, PostgreSQL 17.6 |
| Migration | `20260813090000_produce_product_code_dictionary.sql`, applied as `produce_product_code_dictionary` |

## What it does

A code is an optional way of *writing* a product, never a list of permitted
products. Resolution happens inside `parseWeighSession`, on the leading product
token of a line the parser has already decided is an item line — so there is no
new ingestion path, and by the time anything downstream sees an item there is no
such thing as a coded row.

```
LINE webhook → pending session → deferred finalizer
  → parser  ← the code becomes a canonical product name HERE
  → accountability-round binding → P4A entry validation → persistence
```

P4A, round binding, dedup and reporting all keep comparing canonical names with
no change of their own. `ม02` out / `กล้วยน้ำว้า` back lands on the same master
cell, and a coded document produces the same validation digest as the same
document typed in words.

Uncoded products are unaffected: a brand-new `เสาวรส` and a deliberately
excluded `เขียวมรกตเก่า` both keep working exactly as before. The one thing that
fails is a token that *looks* like a code but is not registered (`ม999`) — it
fails closed with a parse error naming the code, and nothing is persisted.

## Post-apply verification (read-only)

Dictionary content was verified by fingerprint against the approved CSV rather
than by eye:

| check | expected | Production |
|---|---|---|
| rows / enabled | 253 / 253 | 253 / 253 |
| `md5(code=name)` | `b465b603946bc4e93565bd4c1132663f` | same |
| `md5(code\|cat\|catname\|name)` | `86221bc27fccfeba6bb7a343a0eebbe4` | same |

Namespace counts: ม 62, ผ 118, ป 36, ท 26, ห 4, พ 7.
Structure: 1 PK, 5 CHECK constraints, 3 indexes, RLS enabled, identity guard
trigger `BEFORE DELETE OR UPDATE` present and enabled.

### Historical data — unchanged

Captured before the migration and re-read after. Every value identical.

| metric | before | after |
|---|---|---|
| `produce_transactions` | 29,249 | 29,249 |
| `produce_sessions` | 1,872 | 1,872 |
| `accountability_rounds` | 25 | 25 |
| open rounds | 24 | 24 |
| cancelled rounds | 1 | 1 |
| rounds fingerprint | `8285a9fc5ba01c18143ac2c8e8b092cd` | same |
| 2026-08-11 transactions | 279 | 279 |
| 2026-08-11 sessions | 23 | 23 |
| 2026-08-11 fingerprint | `3575b13353caa42fab5562366b73560a` | same |
| distinct product names | 1,056 | 1,056 |
| voided transactions | 0 | 0 |
| all product names fingerprint | `a790672bba13ceb2a52284f44c2568bf` | same |

The 2026-08-11 history was deliberately left unrepaired and remains so.

### Read-time safety

Codes resolve when raw text is parsed, and `sales/load.ts` re-parses historical
`raw_text` at read time. Checked before merge: **0 of 135,987** historical lines
match the code pattern, and **0** historical product names are code-shaped. No
historical document reads differently after this release.

## Known deviation — service_role privileges

The migration's `REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT SELECT
… TO service_role` was intended to leave the table SELECT-only for the backend.
In Production `service_role` also holds INSERT/UPDATE/DELETE/TRUNCATE on it,
inherited from the project's default privileges on `public` — the same standing
grant it has on every other table in this schema, so this is not new exposure.

- `anon`, `authenticated` and `PUBLIC` hold **no** privileges, which is the
  security-relevant half, and RLS is on.
- Code stability does not depend on the grant: the identity-guard trigger fires
  regardless of privileges, so delete / renumber / repoint are refused for
  every role including `service_role`.

The real-PostgreSQL test asserts `service_role: SELECT` and passes in CI because
the disposable bootstrap database has no Supabase default privileges. Worth a
follow-up if strict SELECT-only is wanted — either an explicit
`REVOKE INSERT, UPDATE, DELETE, TRUNCATE … FROM service_role`, or teaching the
bootstrap to mirror the project's default privileges so the test reflects
Production.

## LINE UAT — still needs a human

These messages cannot be sent from repository tooling, and Production webhooks
were deliberately not forged to simulate a human. Send each as **one LINE
message** into the produce group, in order.

Market `ทดสอบ` is the sanctioned test market. `ม01` = `กล้วยไข่`.

> **Note.** These land on business date 2026-08-13, so they will appear in the
> next 08:00 / 08:10 report for that date. Void the session afterwards if that
> is unwanted.

### UAT A — clean coded one-shot

```
ทดสอบรหัส-ทดสอบ เบิก 13/8/2569
ม01 50 บาท
2 โล
จบรายการเบิก
```

Expect: the close-pending reply
(`รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่`), then a
saved summary naming **กล้วยไข่**, never `ม01`, with a non-null accountability
round.

### UAT B — code out, word back

```
ทดสอบรหัส-ทดสอบ ชั่งคืน 13/8/2569
กล้วยไข่ 50 บาท
1 โล
จบรายการชั่งคืน
```

Expect: accepted and saved. The word matches the coded withdrawal — this is the
whole point of the feature.

### UAT C — price mismatch on the same code

```
ทดสอบรหัส-ทดสอบ ชั่งคืน 13/8/2569
ม01 60 บาท
1 โล
จบรายการชั่งคืน
```

Expect: P4A price review presented, not silently accepted. A code must never
bypass price validation.

### UAT D — unregistered code

```
ทดสอบรหัส-ทดสอบ เบิก 13/8/2569
ม999 50 บาท
1 โล
จบรายการเบิก
```

Expect: refusal naming the code —
`ไม่พบรหัสสินค้า ม999 ในทะเบียนรหัสสินค้า` — and **nothing persisted**. No
product called `ม999` may appear anywhere.

### UAT E — new uncoded product still works

```
ทดสอบรหัส-ทดสอบ เบิก 13/8/2569
เสาวรส 50 บาท
3 โล
จบรายการเบิก
```

Expect: accepted exactly as before. The dictionary is not an allowlist.

### After the human run

Verify read-only that UAT A/B/E persisted with canonical product names and a
non-null `accountability_round_id`, that C produced a review rather than a
silent save, and that D wrote nothing.

## Out of scope

No daily central pricing, price sheet, sale-price enforcement or margin policy.
Noted for that future feature: canonical names are persisted, and each code is
stable and permanent with a category attached, so a daily price sheet can key
prices by `product_code` and group by category with no further identity work.
