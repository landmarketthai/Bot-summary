-- Match the exact lost-produce candidate predicate and its ORDER BY id.
--
-- The report paginates these historical candidates by id. A trigram index helps
-- keyword search in isolation, but ORDER BY id + OFFSET can still make the
-- planner walk the primary key and re-check thousands of unrelated rows. This
-- partial index contains only rows the server-side prefilter can return, already
-- ordered by id, so every pagination page stays bounded while preserving the
-- intentional no-created_at-bound semantics for future/back-dated documents.

create index if not exists idx_raw_messages_lost_produce_candidate_id
  on public.raw_messages (id)
  where is_processed = false
    and message_type = 'text'
    and (
      raw_text ilike '%รายการชั่ง%'
      or raw_text ilike '%เบิก%'
      or raw_text ilike '%คืน%'
      or raw_text ilike '%เสีย%'
    );
