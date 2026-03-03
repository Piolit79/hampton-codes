import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API = "https://api.openai.com/v1";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const CHUNK_TARGET = 800;
const CHUNK_OVERLAP_WORDS = 80;
const MAX_PAGES = 80;

function extractEcode360Links(markdown: string, baseHost: string): string[] {
  const links: string[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const url = match[2];
    if (url.includes(baseHost) && !url.includes("#") && !url.includes("?")) {
      links.push(url);
    }
  }
  return [...new Set(links)];
}

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

async function firecrawlScrape(url: string, apiKey: string): Promise<{ markdown: string; title: string } | null> {
  try {
    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return {
      markdown: json.data?.markdown || "",
      title: json.data?.metadata?.title || "",
    };
  } catch {
    return null;
  }
}

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch(`${OPENAI_API}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!resp.ok) throw new Error(`OpenAI embeddings failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is not set");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY secret is not set");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { source_id } = await req.json();
    if (!source_id) throw new Error("source_id is required");

    const { data: source, error: srcErr } = await supabase.from("code_sources").select("*").eq("id", source_id).single();
    if (srcErr || !source) throw new Error("Source not found");

    const rootUrl = new URL(source.url);
    const allChunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];

    // Step 1: Scrape the main TOC page
    const tocResult = await firecrawlScrape(source.url, FIRECRAWL_API_KEY);
    if (!tocResult || !tocResult.markdown) throw new Error("Failed to fetch TOC page via Firecrawl");

    allChunks.push(...chunkText(tocResult.markdown, source.url, source.name));

    // Step 2: Extract sub-page links and scrape each
    const subLinks = extractEcode360Links(tocResult.markdown, rootUrl.host).slice(0, MAX_PAGES - 1);

    for (const link of subLinks) {
      const result = await firecrawlScrape(link, FIRECRAWL_API_KEY);
      if (!result || result.markdown.length < 100) continue;
      allChunks.push(...chunkText(result.markdown, link, result.title));
    }

    if (allChunks.length === 0) {
      await supabase.from("code_sources").update({ status: "error" }).eq("id", source_id);
      return new Response(JSON.stringify({ error: "No content extracted" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Step 3: Delete old chunks and embed new ones
    await supabase.from("code_chunks").delete().eq("source_id", source_id);

    const BATCH = 20;
    let stored = 0;
    for (let i = 0; i < allChunks.length; i += BATCH) {
      const batch = allChunks.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch.map((c) => c.content), OPENAI_API_KEY);
      const rows = batch.map((chunk, j) => ({
        source_id, content: chunk.content, section_title: chunk.section_title,
        section_path: chunk.section_path, source_url: chunk.source_url,
        embedding: JSON.stringify(embeddings[j]),
        token_count: Math.ceil(chunk.content.split(/\s+/).length * 1.3),
      }));
      const { error: insertErr } = await supabase.from("code_chunks").insert(rows);
      if (!insertErr) stored += rows.length;
    }

    await supabase.from("code_sources").update({ status: "ready", chunk_count: stored, last_ingested_at: new Date().toISOString() }).eq("id", source_id);

    return new Response(JSON.stringify({ success: true, chunks: stored, pages: subLinks.length + 1 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("ingest-code error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
