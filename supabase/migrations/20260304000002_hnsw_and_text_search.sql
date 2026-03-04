-- Switch to HNSW index (faster to build than ivfflat, no "lists" tuning needed)
DROP INDEX IF EXISTS code_chunks_embedding_idx;

CREATE INDEX code_chunks_embedding_idx
  ON code_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search index (GIN) for fast keyword search fallback
CREATE INDEX IF NOT EXISTS code_chunks_fts_idx
  ON code_chunks
  USING GIN (to_tsvector('english', content));

-- Full-text search function (used as fallback when vector search is warming up)
CREATE OR REPLACE FUNCTION search_code_chunks_text(
  search_query TEXT,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, source_id UUID, content TEXT, section_title TEXT,
  section_path TEXT, source_url TEXT, municipality TEXT, similarity FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT cc.id, cc.source_id, cc.content, cc.section_title,
    cc.section_path, cc.source_url, cs.municipality,
    ts_rank(to_tsvector('english', cc.content), plainto_tsquery('english', search_query)) AS similarity
  FROM code_chunks cc
  JOIN code_sources cs ON cs.id = cc.source_id
  WHERE to_tsvector('english', cc.content) @@ plainto_tsquery('english', search_query)
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- Simplified vector match functions (no DISTINCT ON)
CREATE OR REPLACE FUNCTION match_code_chunks(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, source_id UUID, content TEXT, section_title TEXT,
  section_path TEXT, source_url TEXT, municipality TEXT, similarity FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT cc.id, cc.source_id, cc.content, cc.section_title,
    cc.section_path, cc.source_url, cs.municipality,
    1 - (cc.embedding <=> query_embedding) AS similarity
  FROM code_chunks cc
  JOIN code_sources cs ON cs.id = cc.source_id
  WHERE cc.embedding IS NOT NULL
  ORDER BY cc.embedding <=> query_embedding
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
  SELECT cc.id, cc.source_id, cc.content, cc.section_title,
    cc.section_path, cc.source_url, cs.municipality,
    1 - (cc.embedding <=> query_embedding) AS similarity
  FROM code_chunks cc
  JOIN code_sources cs ON cs.id = cc.source_id
  WHERE cc.embedding IS NOT NULL
    AND (filter_municipality IS NULL OR cs.municipality = filter_municipality)
  ORDER BY cc.embedding <=> query_embedding
  LIMIT match_count;
$$;
