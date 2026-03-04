import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API = "https://api.openai.com/v1";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const BATCH_SIZE = 15;
const CHUNK_TARGET = 800;
const CHUNK_OVERLAP_WORDS = 80;

function chunkText(text: string, sourceUrl: string, title: string) {
  const sectionPattern = /(?=\n##\s|\n###\s|\n§\s|\nSection\s\d|\nARTICLE\s)/gi;
  const rawSections = text.split(sectionPattern).filter((s) => s.trim().length > 50);
  const chunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];
  for (const section of rawSections) {
    const lines = section.trim().split("\n");
    const titleLine = lines[0].replace(/^#+\s*/, "").trim() || title;
    const words = section.split(/\s+/);
    if (words.length <= CHUNK_TARGET * 1.5) {
      chunks.push({ content: section.trim(), section_title: titleLine.slice(0, 200), section_path: titleLine.slice(0, 300), source_url: sourceUrl });
    } else {
      let i = 0, idx = 0;
      while (i < words.length) {
        chunks.push({ content: words.slice(i, i + CHUNK_TARGET).join(" "), section_title: titleLine.slice(0, 200), section_path: `${titleLine} (part ${idx + 1})`.slice(0, 300), source_url: sourceUrl });
        i += CHUNK_TARGET - CHUNK_OVERLAP_WORDS;
        idx++;
      }
    }
  }
  return chunks;
}

async function scrapeForContent(url: string, apiKey: string): Promise<{ markdown: string; title: string } | null> {
  try {
    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return { markdown: json.data?.markdown || "", title: json.data?.metadata?.title || "" };
  } catch { return null; }
}

const EMBED_BATCH = 20;

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  // Truncate any individual text to ~8000 tokens (~6000 words) to stay under OpenAI's limit
  const truncated = texts.map((t) => {
    const words = t.split(/\s+/);
    return words.length > 6000 ? words.slice(0, 6000).join(" ") : t;
  });
  const resp = await fetch(`${OPENAI_API}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: truncated }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    console.error("OpenAI embeddings error:", resp.status, errBody);
    throw new Error(`Embeddings failed: ${resp.status} - ${errBody.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(batch, apiKey);
    allEmbeddings.push(...embeddings);
  }
  return allEmbeddings;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { source_id } = await req.json();
    if (!source_id) throw new Error("source_id required");

    // Grab next batch of pending URLs
    const { data: batch } = await supabase
      .from("ingest_queue")
      .select("id, url")
      .eq("source_id", source_id)
      .eq("status", "pending")
      .limit(BATCH_SIZE);

    if (!batch || batch.length === 0) {
      // All done — mark source ready
      const { data: src } = await supabase.from("code_sources").select("chunk_count").eq("id", source_id).single();
      await supabase.from("code_sources").update({ status: "ready", last_ingested_at: new Date().toISOString() }).eq("id", source_id);
      return new Response(JSON.stringify({ done: true, chunks: src?.chunk_count || 0 }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mark batch as processing
    await supabase.from("ingest_queue").update({ status: "processing" }).in("id", batch.map((b) => b.id));

    // Scrape, chunk, embed
    const allChunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];
    for (const item of batch) {
      const result = await scrapeForContent(item.url, FIRECRAWL_API_KEY);
      if (!result || result.markdown.length < 200) continue;
      allChunks.push(...chunkText(result.markdown, item.url, result.title));
    }

    if (allChunks.length > 0) {
      const embeddings = await embedTexts(allChunks.map((c) => c.content), OPENAI_API_KEY);
      const rows = allChunks.map((chunk, j) => ({
        source_id, content: chunk.content, section_title: chunk.section_title,
        section_path: chunk.section_path, source_url: chunk.source_url,
        embedding: JSON.stringify(embeddings[j]),
        token_count: Math.ceil(chunk.content.split(/\s+/).length * 1.3),
      }));
      await supabase.from("code_chunks").insert(rows);
    }

    // Mark batch done and update progress
    await supabase.from("ingest_queue").update({ status: "done", processed_at: new Date().toISOString() }).in("id", batch.map((b) => b.id));
    await supabase.rpc("increment_processed_urls", { p_source_id: source_id, p_count: batch.length, p_chunks: allChunks.length });

    // Count remaining
    const { count: remaining } = await supabase.from("ingest_queue").select("*", { count: "exact", head: true }).eq("source_id", source_id).eq("status", "pending");

    return new Response(JSON.stringify({ done: false, processed: batch.length, remaining: remaining || 0, chunks_added: allChunks.length }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ingest-batch error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
