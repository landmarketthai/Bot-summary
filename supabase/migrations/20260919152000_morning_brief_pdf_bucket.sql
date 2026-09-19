-- Private storage for generated Morning Brief A4 PDFs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'morning-brief-pdfs',
  'morning-brief-pdfs',
  false,
  10485760,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
