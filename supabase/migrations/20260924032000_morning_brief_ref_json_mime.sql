-- Allow Morning Brief reference-data sidecars in the existing private PDF bucket.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['application/pdf', 'application/json']::text[]
WHERE id = 'morning-brief-pdfs';
