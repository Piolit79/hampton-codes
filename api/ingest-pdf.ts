import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';

export const maxDuration = 60;

const CHUNK_TARGET = 800;
const CHUNK_OVERLAP_WORDS = 80;

function chunkText(text: string, sourceUrl: string, title: string) {
  const sectionPattern = /(?=\n##\s|\n###\s|\n§\s|\nSection\s\d|\nARTICLE\s|\nCHAPTER\s)/gi;
  const rawSections = text.split(sectionPattern).filter((s) => s.trim().length > 50);
  const chunks: Array<{ content: string; section_title: string; section_path: string }> = [];

  for (const section of rawSections) {
    const lines = section.trim().split('\n');
    const titleLine = lines[0].replace(/^#+\s*/, '').trim() || title;
    const words = section.split(/\s+/);

    if (words.length <= CHUNK_TARGET * 1.5) {
      chunks.push({
        content: section.trim(),
        section_title: titleLine.slice(0, 200),
        section_path: titleLine.slice(0, 300),
      });
    } else {
      let i = 0, idx = 0;
      while (i < words.length) {
        chunks.push({
          content: words.slice(i, i + CHUNK_TARGET).join(' '),
          section_title: titleLine.slice(0, 200),
          section_path: `${titleLine} (part ${idx + 1})`.slice(0, 300),
        });
        i += CHUNK_TARGET - CHUNK_OVERLAP_WORDS;
        idx++;
      }
    }
  }
  return chunks;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { source_id, file_path } = req.body;
    if (!source_id || !file_path) return res.status(400).json({ error: 'source_id and file_path required' });

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: source } = await supabase
      .from('code_sources').select('*').eq('id', source_id).single();
    if (!source) return res.status(404).json({ error: 'Source not found' });

    // Download PDF from Supabase Storage
    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('code-pdfs').download(file_path);
    if (downloadErr || !fileData) throw new Error(`Failed to download PDF: ${downloadErr?.message}`);

    // Extract text with pdf-parse (Node.js — no timeout issues)
    const buffer = Buffer.from(await fileData.arrayBuffer());
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text;

    if (!text || text.length < 100) {
      throw new Error('No text extracted — PDF may be image-based (scanned). Try a text-based PDF.');
    }

    const chunks = chunkText(text, source.url, source.name);
    if (chunks.length === 0) throw new Error('No chunks created from PDF text');

    // Clear pending queue items only (preserve processed chunks for multi-part uploads)
    await supabase.from('ingest_queue').delete()
      .eq('source_id', source_id).eq('status', 'pending');

    // Insert chunks into queue in batches
    const INSERT_BATCH = 100;
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH).map((chunk) => ({
        source_id,
        url: source.url,
        content: chunk.content,
        status: 'pending',
      }));
      await supabase.from('ingest_queue').insert(batch);
    }

    // Update source status
    await supabase.from('code_sources').update({
      status: 'ingesting',
      total_urls: chunks.length,
      processed_urls: 0,
    }).eq('id', source_id);

    return res.status(200).json({ success: true, total_chunks: chunks.length });
  } catch (e) {
    console.error('ingest-pdf error:', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
}
