#!/usr/bin/env node
/**
 * Usage:
 *   set OPENAI_API_KEY=sk-...
 *   node scripts/ingest.mjs "C:\path\to\east-hampton.pdf" "Town of East Hampton"
 */

import pdfParse from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const SUPABASE_URL = 'https://shticridijsejlwgjxel.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodGljcmlkaWpzZWpsd2dqeGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTE5NDAsImV4cCI6MjA4ODA4Nzk0MH0.0ltXwCHsAigEWgZkZNYlYfEf5tWWs3m4XJcDk7vBv8Q';
const CHUNK_TARGET = 800;
const CHUNK_OVERLAP = 80;
const EMBED_BATCH = 20;

function chunkText(text, sourceUrl, title) {
  const sectionPattern = /(?=\n§\s|\nSection\s\d|\nARTICLE\s|\nCHAPTER\s|\n\d+\.\d+\s)/gi;
  const rawSections = text.split(sectionPattern).filter(s => s.trim().length > 50);
  const chunks = [];

  for (const section of rawSections) {
    const lines = section.trim().split('\n');
    const titleLine = lines[0].replace(/^#+\s*/, '').trim() || title;
    const words = section.split(/\s+/);

    if (words.length <= CHUNK_TARGET * 1.5) {
      chunks.push({ content: section.trim(), section_title: titleLine.slice(0, 200), section_path: titleLine.slice(0, 300), source_url: sourceUrl });
    } else {
      let i = 0, idx = 0;
      while (i < words.length) {
        chunks.push({
          content: words.slice(i, i + CHUNK_TARGET).join(' '),
          section_title: titleLine.slice(0, 200),
          section_path: `${titleLine} (part ${idx + 1})`.slice(0, 300),
          source_url: sourceUrl,
        });
        i += CHUNK_TARGET - CHUNK_OVERLAP;
        idx++;
      }
    }
  }
  return chunks;
}

async function embedBatch(texts, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  return json.data.map(d => d.embedding);
}

async function main() {
  const [,, pdfPath, municipalityName] = process.argv;
  if (!pdfPath || !municipalityName) {
    console.error('Usage: node scripts/ingest.mjs <pdf-path> "<Municipality Name>"');
    process.exit(1);
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error('Error: set OPENAI_API_KEY environment variable first');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Find the source
  const { data: source } = await supabase
    .from('code_sources')
    .select('*')
    .eq('municipality', municipalityName)
    .single();

  if (!source) {
    console.error(`No source found for municipality: "${municipalityName}"`);
    console.log('Available municipalities:');
    const { data: all } = await supabase.from('code_sources').select('municipality');
    all?.forEach(s => console.log(' -', s.municipality));
    process.exit(1);
  }

  console.log(`Processing: ${source.name}`);

  // Extract text from PDF
  console.log('Extracting text from PDF...');
  const buffer = fs.readFileSync(pdfPath);
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;
  console.log(`Extracted ${text.length.toLocaleString()} characters, ${pdfData.numpages} pages`);

  if (text.length < 100) {
    console.error('No text extracted — PDF may be image-based (scanned)');
    process.exit(1);
  }

  // Chunk the text
  const chunks = chunkText(text, source.url, source.name);
  console.log(`Created ${chunks.length} chunks`);

  // Clear old data for this source
  console.log('Clearing old data...');
  await supabase.from('code_chunks').delete().eq('source_id', source.id);
  await supabase.from('ingest_queue').delete().eq('source_id', source.id);
  await supabase.from('code_sources').update({
    status: 'ingesting', chunk_count: 0, processed_urls: 0, total_urls: chunks.length
  }).eq('id', source.id);

  // Embed and insert in batches
  let inserted = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(batch.map(c => c.content), OPENAI_API_KEY);

    const rows = batch.map((chunk, j) => ({
      source_id: source.id,
      content: chunk.content,
      section_title: chunk.section_title,
      section_path: chunk.section_path,
      source_url: chunk.source_url,
      embedding: JSON.stringify(embeddings[j]),
      token_count: Math.ceil(chunk.content.split(/\s+/).length * 1.3),
    }));

    const { error } = await supabase.from('code_chunks').insert(rows);
    if (error) throw new Error(`Insert failed: ${error.message}`);

    inserted += batch.length;
    process.stdout.write(`\rEmbedding: ${inserted}/${chunks.length} chunks`);
  }

  // Mark source ready
  await supabase.from('code_sources').update({
    status: 'ready',
    chunk_count: inserted,
    processed_urls: inserted,
    last_ingested_at: new Date().toISOString(),
  }).eq('id', source.id);

  console.log(`\nDone! ${inserted} chunks embedded for ${source.name}`);
}

main().catch(err => { console.error(err); process.exit(1); });
