-- Speed up the fail-closed lost-produce scan used by the 08:00 Morning Brief.
--
-- The report intentionally scans all historical unprocessed text messages because
-- an operator can send a future/back-dated Produce document; adding a created_at
-- bound would change correctness. The existing server-side prefilter therefore
-- uses leading-wildcard ILIKE predicates on raw_text. pg_trgm lets PostgreSQL
-- accelerate those predicates without changing which rows are considered.
--
-- This migration is additive and backwards-compatible with every deployed app
-- version. It does not rewrite raw_messages or change report semantics.

create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_raw_messages_unprocessed_text_trgm
  on public.raw_messages
  using gin (raw_text extensions.gin_trgm_ops)
  where is_processed = false
    and message_type = 'text';
