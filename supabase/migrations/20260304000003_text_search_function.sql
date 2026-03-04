-- Text search function (no index needed to create this — index added separately)
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
