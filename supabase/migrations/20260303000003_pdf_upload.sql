-- Add content column to ingest_queue (for PDF chunks that don't need scraping)
ALTER TABLE ingest_queue ADD COLUMN IF NOT EXISTS content TEXT;

-- Add progress tracking to code_sources
ALTER TABLE code_sources ADD COLUMN IF NOT EXISTS total_urls INT NOT NULL DEFAULT 0;
ALTER TABLE code_sources ADD COLUMN IF NOT EXISTS processed_urls INT NOT NULL DEFAULT 0;

-- Helper function for batch progress tracking
CREATE OR REPLACE FUNCTION increment_processed_urls(p_source_id UUID, p_count INT, p_chunks INT)
RETURNS void LANGUAGE SQL AS $$
  UPDATE code_sources
  SET processed_urls = processed_urls + p_count,
      chunk_count = chunk_count + p_chunks
  WHERE id = p_source_id;
$$;

-- Storage bucket for PDF uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('code-pdfs', 'code-pdfs', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY IF NOT EXISTS "Upload code-pdfs" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'code-pdfs');

CREATE POLICY IF NOT EXISTS "Read code-pdfs" ON storage.objects
  FOR SELECT USING (bucket_id = 'code-pdfs');

-- Deduplicate any existing chunks
DELETE FROM code_chunks
WHERE id NOT IN (
  SELECT DISTINCT ON (source_id, section_title, section_path) id
  FROM code_chunks
  ORDER BY source_id, section_title, section_path, created_at
);

-- Updated match functions with deduplication
CREATE OR REPLACE FUNCTION match_code_chunks(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, source_id UUID, content TEXT, section_title TEXT,
  section_path TEXT, source_url TEXT, municipality TEXT, similarity FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (cc.section_title, cs.municipality)
      cc.id, cc.source_id, cc.content, cc.section_title,
      cc.section_path, cc.source_url, cs.municipality,
      1 - (cc.embedding <=> query_embedding) AS similarity
    FROM code_chunks cc
    JOIN code_sources cs ON cs.id = cc.source_id
    WHERE cc.embedding IS NOT NULL
    ORDER BY cc.section_title, cs.municipality, cc.embedding <=> query_embedding
  ) sub
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_code_chunks_filtered(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 10,
  filter_municipality TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID, source_id UUID, content TEXT, section_title TEXT,
  section_path TEXT, source_url TEXT, municipality TEXT, similarity FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (cc.section_title)
      cc.id, cc.source_id, cc.content, cc.section_title,
      cc.section_path, cc.source_url, cs.municipality,
      1 - (cc.embedding <=> query_embedding) AS similarity
    FROM code_chunks cc
    JOIN code_sources cs ON cs.id = cc.source_id
    WHERE cc.embedding IS NOT NULL
      AND (filter_municipality IS NULL OR cs.municipality = filter_municipality)
    ORDER BY cc.section_title, cc.embedding <=> query_embedding
  ) sub
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
