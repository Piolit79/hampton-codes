import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const MAX_SECTION_URLS = 400;

function isCodeLink(linkText: string): boolean {
  const badPatterns = [
    /filed/i, /notice/i, /enactment/i, /local law/i,
    /\d{1,2}\/\d{1,2}\/\d{2,4}/,
    /january|february|march|april|may|june|july|august|september|october|november|december/i,
  ];
  return !badPatterns.some((p) => p.test(linkText));
}

function extractFilteredLinks(markdown: string, host: string): string[] {
  const links: string[] = [];
  const pattern = /\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const text = match[1];
    const url = match[2];
    try {
      const parsed = new URL(url);
      if (parsed.hostname === host && !url.includes("#") && isCodeLink(text)) {
        links.push(url);
      }
    } catch { /* skip */ }
  }
  return [...new Set(links)];
}

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { source_id } = await req.json();
    if (!source_id) throw new Error("source_id required");

    const { data: source } = await supabase.from("code_sources").select("*").eq("id", source_id).single();
    if (!source) throw new Error("Source not found");

    const host = new URL(source.url).hostname;
    const allUrls = new Set<string>();
    allUrls.add(source.url);

    // Level 1: scrape TOC for chapter links
    console.log(`Discovering URLs for ${source.url}`);
    const tocMarkdown = await scrapeForLinks(source.url, FIRECRAWL_API_KEY);
    const chapterUrls = extractFilteredLinks(tocMarkdown, host);
    for (const u of chapterUrls) allUrls.add(u);
    console.log(`Level 1: ${chapterUrls.length} chapter URLs found`);

    // Level 2: scrape each chapter for section links
    for (const chapterUrl of chapterUrls.slice(0, 60)) {
      if (allUrls.size >= MAX_SECTION_URLS) break;
      const chapterMarkdown = await scrapeForLinks(chapterUrl, FIRECRAWL_API_KEY);
      const sectionUrls = extractFilteredLinks(chapterMarkdown, host);
      for (const su of sectionUrls) {
        if (allUrls.size >= MAX_SECTION_URLS) break;
        allUrls.add(su);
      }
    }
    console.log(`Total URLs discovered: ${allUrls.size}`);

    // Clear old queue + chunks, populate new queue
    await supabase.from("ingest_queue").delete().eq("source_id", source_id);
    await supabase.from("code_chunks").delete().eq("source_id", source_id);

    const queueRows = [...allUrls].map((url) => ({ source_id, url, status: "pending" }));
    await supabase.from("ingest_queue").insert(queueRows);

    await supabase.from("code_sources").update({
      status: "ingesting",
      total_urls: allUrls.size,
      processed_urls: 0,
      chunk_count: 0,
    }).eq("id", source_id);

    return new Response(JSON.stringify({ success: true, total_urls: allUrls.size }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ingest-discover error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
