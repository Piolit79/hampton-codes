import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

serve(async (_req) => {
  const dbUrl = Deno.env.get('SUPABASE_DB_URL');
  if (!dbUrl) {
    return new Response(JSON.stringify({ error: 'SUPABASE_DB_URL not available' }), {
      headers: { 'Content-Type': 'application/json' }, status: 500,
    });
  }

  const client = new Client(dbUrl);
  const results: string[] = [];

  try {
    await client.connect();

    // Full-text search index (GIN) — fast to build, enables keyword search
    await client.queryArray(`
      CREATE INDEX IF NOT EXISTS code_chunks_fts_idx
        ON code_chunks
        USING GIN (to_tsvector('english', content))
    `);
    results.push('Created GIN full-text search index');

    // Full-text search function
    await client.queryArray(`
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
      $$
    `);
    results.push('Created search_code_chunks_text function');

    // Rebuild vector index using HNSW (works on populated tables)
    await client.queryArray(`DROP INDEX IF EXISTS code_chunks_embedding_idx`);
    results.push('Dropped old vector index');

    await client.queryArray(`
      CREATE INDEX code_chunks_embedding_idx
        ON code_chunks
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);
    results.push('Created HNSW vector index');

    await client.end();

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (e: any) {
    try { await client.end(); } catch {}
    return new Response(JSON.stringify({ error: e.message, results }), {
      headers: { 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
