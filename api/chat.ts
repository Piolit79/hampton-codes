import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const SUPABASE_URL = 'https://shticridijsejlwgjxel.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodGljcmlkaWpzZWpsd2dqeGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTE5NDAsImV4cCI6MjA4ODA4Nzk0MH0.0ltXwCHsAigEWgZkZNYlYfEf5tWWs3m4XJcDk7vBv8Q';
const MATCH_COUNT = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  try {
    const { question, municipality } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Embed the question
    const embedResp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: question }),
    });
    if (!embedResp.ok) throw new Error(`Embedding failed: ${embedResp.status}`);
    const embedJson = await embedResp.json();
    const queryEmbedding: number[] = embedJson.data[0].embedding;

    // Vector search
    const rpcName = municipality ? 'match_code_chunks_filtered' : 'match_code_chunks';
    const rpcArgs = municipality
      ? { query_embedding: queryEmbedding, match_count: MATCH_COUNT, filter_municipality: municipality }
      : { query_embedding: queryEmbedding, match_count: MATCH_COUNT };

    let { data: chunks, error: matchErr } = await supabase.rpc(rpcName, rpcArgs);

    // Keyword fallback if vector search times out or returns nothing
    if (matchErr || !chunks || chunks.length === 0) {
      console.log('Vector search unavailable, using keyword fallback:', matchErr?.message);

      const terms = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w: string) => w.length > 4)
        .slice(0, 3);

      if (terms.length > 0) {
        const { data: kbChunks, error: kbErr } = await supabase
          .from('code_chunks')
          .select('id, source_id, content, section_title, section_path, source_url')
          .ilike('content', `%${terms[0]}%`)
          .limit(MATCH_COUNT * 3); // fetch more so we can filter by municipality

        if (!kbErr && kbChunks && kbChunks.length > 0) {
          const sourceIds = [...new Set(kbChunks.map((c: any) => c.source_id))];
          const { data: sources } = await supabase
            .from('code_sources')
            .select('id, municipality')
            .in('id', sourceIds);

          const sourceMap = Object.fromEntries(
            (sources || []).map((s: any) => [s.id, s.municipality])
          );

          const withMunicipality = kbChunks.map((c: any) => ({
            ...c,
            municipality: sourceMap[c.source_id] || 'Unknown',
            similarity: 0.5,
          }));

          const filtered = municipality
            ? withMunicipality.filter((c: any) => c.municipality === municipality)
            : withMunicipality;

          if (filtered.length > 0) {
            chunks = filtered.slice(0, MATCH_COUNT);
            matchErr = null;
          }
        }
      }
    }

    if (matchErr) throw matchErr;

    if (!chunks || chunks.length === 0) {
      return res.status(200).json({
        answer: "I couldn't find relevant sections in the building codes for your question. Try rephrasing, or make sure the relevant municipality's code has been ingested.",
        sources: [],
      });
    }

    // Build context
    const context = chunks
      .map((c: { section_title: string; municipality: string; content: string }, i: number) =>
        `[${i + 1}] ${c.section_title ? `Section: ${c.section_title}\n` : ''}Municipality: ${c.municipality}\n${c.content}`
      )
      .join('\n\n---\n\n');

    // GPT-4o
    const chatResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are an expert on building codes and zoning regulations for the Hamptons area of Long Island, New York.
Answer questions clearly and precisely based only on the provided code sections.
If the answer varies by municipality, note the differences.
Always cite which municipality and section your answer comes from.
If the code sections don't contain enough information to answer definitively, say so clearly.`,
          },
          {
            role: 'user',
            content: `Based on the following building code sections, answer this question:\n\n${question}\n\n---\nCODE SECTIONS:\n${context}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    if (!chatResp.ok) throw new Error(`GPT-4o failed: ${chatResp.status}`);
    const chatJson = await chatResp.json();
    const answer = chatJson.choices[0].message.content;

    const sources = chunks.map((c: {
      id: string; section_title: string; section_path: string;
      municipality: string; source_url: string; similarity: number;
    }) => ({
      id: c.id, section_title: c.section_title, section_path: c.section_path,
      municipality: c.municipality, source_url: c.source_url, similarity: c.similarity,
    }));

    return res.status(200).json({ answer, sources });
  } catch (e: any) {
    console.error('chat error:', e);
    const msg = e?.message || e?.error_description || JSON.stringify(e) || 'Unknown error';
    return res.status(500).json({ error: msg });
  }
}
