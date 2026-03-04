import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const SUPABASE_URL = 'https://shticridijsejlwgjxel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodGljcmlkaWpzZWpsd2dqeGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTE5NDAsImV4cCI6MjA4ODA4Nzk0MH0.0ltXwCHsAigEWgZkZNYlYfEf5tWWs3m4XJcDk7vBv8Q';
const BATCH_SIZE = 8;

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!resp.ok) throw new Error(`Embeddings failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set in Vercel environment variables' });

  try {
    const { source_id } = req.body;
    if (!source_id) return res.status(400).json({ error: 'source_id required' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Grab next batch of pending items
    const { data: batch } = await supabase
      .from('ingest_queue')
      .select('id, url, content')
      .eq('source_id', source_id)
      .eq('status', 'pending')
      .limit(BATCH_SIZE);

    if (!batch || batch.length === 0) {
      // All done — mark source ready
      const { data: src } = await supabase
        .from('code_sources').select('chunk_count').eq('id', source_id).single();
      await supabase.from('code_sources').update({
        status: 'ready',
        last_ingested_at: new Date().toISOString(),
      }).eq('id', source_id);
      return res.status(200).json({ done: true, chunks: src?.chunk_count || 0 });
    }

    // Mark as processing
    await supabase.from('ingest_queue')
      .update({ status: 'processing' })
      .in('id', batch.map((b) => b.id));

    // Embed all chunks
    const contents = batch.map((b) => b.content as string);
    const embeddings = await embedTexts(contents, OPENAI_API_KEY);

    // Build rows for code_chunks
    const { data: source } = await supabase
      .from('code_sources').select('url').eq('id', source_id).single();

    const rows = batch.map((item, j) => ({
      source_id,
      content: item.content,
      section_title: (item.content as string).split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 200) || 'Section',
      section_path: (item.content as string).split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 300) || 'Section',
      source_url: source?.url || item.url,
      embedding: JSON.stringify(embeddings[j]),
      token_count: Math.ceil((item.content as string).split(/\s+/).length * 1.3),
    }));

    await supabase.from('code_chunks').insert(rows);
    await supabase.rpc('increment_processed_urls', {
      p_source_id: source_id,
      p_count: batch.length,
      p_chunks: rows.length,
    });

    // Mark batch done
    await supabase.from('ingest_queue')
      .update({ status: 'done', processed_at: new Date().toISOString() })
      .in('id', batch.map((b) => b.id));

    const { count: remaining } = await supabase
      .from('ingest_queue')
      .select('*', { count: 'exact', head: true })
      .eq('source_id', source_id)
      .eq('status', 'pending');

    return res.status(200).json({ done: false, processed: batch.length, remaining: remaining || 0 });
  } catch (e) {
    console.error('ingest-batch error:', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
}
