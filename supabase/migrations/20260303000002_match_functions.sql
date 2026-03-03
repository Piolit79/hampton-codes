-- Match chunks across all municipalities
CREATE OR REPLACE FUNCTION match_code_chunks(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 6
)
RETURNS TABLE (
  id UUID,
  source_id UUID,
  content TEXT,
  section_title TEXT,
  section_path TEXT,
  source_url TEXT,
  municipality TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    cc.id,
    cc.source_id,
    cc.content,
    cc.section_title,
    cc.section_path,
    cc.source_url,
    cs.municipality,
    1 - (cc.embedding <=> query_embedding) AS similarity
  FROM code_chunks cc
  JOIN code_sources cs ON cs.id = cc.source_id
  WHERE cc.embedding IS NOT NULL
  ORDER BY cc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Match chunks filtered by municipality
CREATE OR REPLACE FUNCTION match_code_chunks_filtered(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 6,
  filter_municipality TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  source_id UUID,
  content TEXT,
  section_title TEXT,
  section_path TEXT,
  source_url TEXT,
  municipality TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    cc.id,
    cc.source_id,
    cc.content,
    cc.section_title,
    cc.section_path,
    cc.source_url,
    cs.municipality,
    1 - (cc.embedding <=> query_embedding) AS similarity
  FROM code_chunks cc
  JOIN code_sources cs ON cs.id = cc.source_id
  WHERE cc.embedding IS NOT NULL
    AND (filter_municipality IS NULL OR cs.municipality = filter_municipality)
  ORDER BY cc.embedding <=> query_embedding
  LIMIT match_count;
$$;
