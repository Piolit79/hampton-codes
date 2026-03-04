import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const supabase = createClient(
    'https://shticridijsejlwgjxel.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodGljcmlkaWpzZWpsd2dqeGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTE5NDAsImV4cCI6MjA4ODA4Nzk0MH0.0ltXwCHsAigEWgZkZNYlYfEf5tWWs3m4XJcDk7vBv8Q'
  );

  const [sources, totalChunks, nullEmbeddings, sampleTitles] = await Promise.all([
    supabase.from('code_sources').select('id, name, municipality, status, chunk_count, total_urls'),
    supabase.from('code_chunks').select('id', { count: 'exact', head: true }),
    supabase.from('code_chunks').select('id', { count: 'exact', head: true }).is('embedding', null),
    supabase.from('code_chunks').select('section_title').limit(10),
  ]);

  return res.status(200).json({
    sources: sources.data,
    total_chunks: totalChunks.count,
    null_embeddings: nullEmbeddings.count,
    sample_titles: sampleTitles.data,
  });
}
