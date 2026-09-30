# bot-summary

Production-ready dashboard for parsing and visualising LINE messages via the LINE Messaging API webhook.

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd bot-summary
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Fill in the values in `.env.local`.

### 3. Run the database migration

In your Supabase SQL editor, paste and run:

```
supabase/migrations/0001_initial_schema.sql
```

Or with the Supabase CLI:

```bash
npx supabase db push
```

### 4. Start the dev server

```bash
npm run dev
```

Open http://localhost:3000.

### 5. Configure the LINE webhook

1. In LINE Developers Console, open your channel.
2. Go to Messaging API → Webhook settings.
3. Set the webhook URL:
   - Local dev: use ngrok → `https://your-ngrok-id.ngrok.io/api/webhook/line`
   - Production: `https://your-domain.com/api/webhook/line`
4. Enable **Use webhook** and click **Verify**.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS v4 |
| Database | Supabase (PostgreSQL + RLS) |
| Messaging | LINE Messaging API |

## Deployment (Vercel)

Set all environment variables in your Vercel project settings, then:

```bash
vercel --prod
```

## Produce-session deferred finalizer (Release B)

`จบรายการ` no longer finalizes a pending produce session inside the LINE
webhook request. The webhook stores the first close boundary and replies
immediately that pending items are being checked.

An external durable scheduler must call:

```text
GET /api/cron/finalize-pending-produce-sessions
Authorization: Bearer <CRON_SECRET>
```

Production calls this route once per minute through Supabase Cron. Release B
does not create a Vercel cron, so `vercel.json` remains empty and Vercel is not
invoked more frequently than the production scheduler requires.

User-visible timing:

- With no late webhook, finalization becomes eligible 8 seconds after close and
  starts on the next once-per-minute scheduler call, so the visible delay can
  be up to about one minute.
- Every eligible late item rearms eligibility to 8 seconds after that item,
  capped at 30 seconds after the first close.
- `จบรายการ N รายการ` waits for every indexed number `1..N`. At the first due
  check it reports exact missing numbers; at the 30-second deadline it fails
  closed without produce writes if any remain.
- Bare `จบรายการ` is quiet-window best-effort and has no indexed-completeness
  guarantee.

The same call also reconciles the ordered LINE webhook queue. Rows received
within the last 60 minutes may be retried; older pending rows move to status
`stale` inside the claim RPC and are never auto-replayed. Each stale row is
logged once (`ordered webhook events went stale and need manual review`) and
the response carries internal `webhookQueue` counts. After review, close a row
without replay by setting `status = 'failed'` with an `error_message`.

## Physical Inventory deferred finalizer (P2A Slice C)

Physical Inventory routing is enabled only for LINE group IDs in
`PHYSICAL_INVENTORY_LINE_GROUP_IDS`. The V1 warehouse is always `MAIN`.

The close webhook stores the immutable LINE boundary and returns without waiting
for finalization. Next.js `after()` keeps a prompt finalization attempt alive
after the response, while the database enforces the 8-second quiet window,
30-second admission deadline, generation, revision, and ingest-set hash.

The scheduled recovery workflow calls:

```text
GET /api/cron/finalize-physical-inventory
Authorization: Bearer <CRON_SECRET>
```

This recovery path is why finalization does not depend on the webhook process
surviving. Terminal LINE pushes use the session generation as
`X-Line-Retry-Key`; the close raw-message processed marker is updated only after
LINE accepts the push, so ambiguous delivery retries do not duplicate the
success or failure message.

Database state remains due when a scheduler request fails, so a later scheduler
call retries it. Finalization is generation-, sender-, and revision-pinned and
is idempotent under concurrent calls. Per Release B scope there is no
notification outbox: if the database transaction succeeds but the later LINE
push fails, the failure is logged and the database result remains authoritative.
