CREATE TABLE ingest_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES code_sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE(source_id, url)
);
ALTER TABLE ingest_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public all ingest_queue" ON ingest_queue FOR ALL USING (true);

ALTER TABLE code_sources ADD COLUMN IF NOT EXISTS total_urls INT NOT NULL DEFAULT 0;
ALTER TABLE code_sources ADD COLUMN IF NOT EXISTS processed_urls INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION increment_processed_urls(p_source_id UUID, p_count INT, p_chunks INT)
RETURNS void LANGUAGE SQL AS $$
  UPDATE code_sources
  SET processed_urls = processed_urls + p_count,
      chunk_count = chunk_count + p_chunks
  WHERE id = p_source_id;
$$;