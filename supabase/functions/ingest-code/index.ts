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
const MAX_SECTION_URLS = 400;

function chunkText(text: string, sourceUrl: string, title: string) {
  const sectionPattern = /(?=\n##\s|\n###\s|\n§\s|\nSection\s\d|\nARTICLE\s)/gi;
  const rawSections = text.split(sectionPattern).filter((s) => s.trim().length > 50);
  const chunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];

  for (const section of rawSections) {
    const lines = section.trim().split("\n");
    const titleLine = lines[0].replace(/^#+\s*/, "").trim() || title;
    const words = section.split(/\s+/);

    if (words.length <= CHUNK_TARGET * 1.5) {
      chunks.push({
        content: section.trim(),
        section_title: titleLine.slice(0, 200),
        section_path: titleLine.slice(0, 300),
        source_url: sourceUrl,
      });
    } else {
      let i = 0, idx = 0;
      while (i < words.length) {
        chunks.push({
          content: words.slice(i, i + CHUNK_TARGET).join(" "),
          section_title: titleLine.slice(0, 200),
          section_path: `${titleLine} (part ${idx + 1})`.slice(0, 300),
          source_url: sourceUrl,
        });
        i += CHUNK_TARGET - CHUNK_OVERLAP_WORDS;
        idx++;
      }
    }
  }
  return chunks;
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

function extractFilteredLinks(markdown: string, host: string): string[] {
  const linkPattern = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const urls = new Set<string>();
  let match;
  while ((match = linkPattern.exec(markdown)) !== null) {
    try {
      const parsed = new URL(match[2]);
      if (parsed.hostname === host) {
        urls.add(parsed.origin + parsed.pathname);
      }
    } catch { /* skip invalid URLs */ }
  }
  return Array.from(urls);
}

// For link discovery — include sidebar navigation (where section links live)
async function scrapeForLinks(url: string, apiKey: string): Promise<string> {
  try {
    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return "";
    const json = await resp.json();
    return json.data?.markdown || "";
  } catch { return ""; }
}

// For content extraction — strip nav/sidebar for clean text
async function scrapeForContent(url: string, apiKey: string): Promise<{ markdown: string; title: string } | null> {
  try {
    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return { markdown: json.data?.markdown || "", title: json.data?.metadata?.title || "" };
  } catch { return null; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is not set");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY secret is not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { source_id } = await req.json();
    if (!source_id) throw new Error("source_id is required");

    const { data: source, error: srcErr } = await supabase
      .from("code_sources").select("*").eq("id", source_id).single();
    if (srcErr || !source) throw new Error("Source not found");

    const host = new URL(source.url).hostname;
    const allUrls = new Set<string>();
    allUrls.add(source.url);

    // Level 1: get chapter links from TOC (include nav)
    console.log(`Level 1: Scraping TOC at ${source.url}`);
    const tocMarkdown = await scrapeForLinks(source.url, FIRECRAWL_API_KEY);
    const chapterUrls = extractFilteredLinks(tocMarkdown, host);
    for (const cu of chapterUrls) allUrls.add(cu);
    console.log(`Found ${chapterUrls.length} chapter URLs, total: ${allUrls.size}`);

    // Level 2: get section links from each chapter (include nav)
    console.log(`Level 2: Scraping up to ${Math.min(chapterUrls.length, 50)} chapters for section links`);
    for (const chapterUrl of chapterUrls.slice(0, 50)) {
      if (allUrls.size >= MAX_SECTION_URLS) break;
      const chapterMarkdown = await scrapeForLinks(chapterUrl, FIRECRAWL_API_KEY);
      const sectionUrls = extractFilteredLinks(chapterMarkdown, host);
      for (const su of sectionUrls) {
        if (allUrls.size >= MAX_SECTION_URLS) break;
        allUrls.add(su);
      }
    }
    console.log(`Total URLs after level 2: ${allUrls.size}`);

    // Level 3: scrape content from all discovered URLs (clean content only)
    const allChunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];

    console.log(`Level 3: Scraping content from ${allUrls.size} URLs`);
    for (const url of allUrls) {
      const result = await scrapeForContent(url, FIRECRAWL_API_KEY);
      if (!result || result.markdown.length < 200) continue;
      allChunks.push(...chunkText(result.markdown, url, result.title));
    }

    if (allChunks.length === 0) {
      await supabase.from("code_sources").update({ status: "error" }).eq("id", source_id);
      return new Response(JSON.stringify({ error: "No content extracted" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 4: Delete old chunks and store new ones
    await supabase.from("code_chunks").delete().eq("source_id", source_id);

    const BATCH = 20;
    let stored = 0;
    for (let i = 0; i < allChunks.length; i += BATCH) {
      const batch = allChunks.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch.map((c) => c.content), OPENAI_API_KEY);
      const rows = batch.map((chunk, j) => ({
        source_id,
        content: chunk.content,
        section_title: chunk.section_title,
        section_path: chunk.section_path,
        source_url: chunk.source_url,
        embedding: JSON.stringify(embeddings[j]),
        token_count: Math.ceil(chunk.content.split(/\s+/).length * 1.3),
      }));
      const { error: insertErr } = await supabase.from("code_chunks").insert(rows);
      if (!insertErr) stored += rows.length;
    }

    await supabase.from("code_sources").update({
      status: "ready",
      chunk_count: stored,
      last_ingested_at: new Date().toISOString(),
    }).eq("id", source_id);

    return new Response(
      JSON.stringify({ success: true, chunks: stored, pages: allUrls.size }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ingest-code error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
