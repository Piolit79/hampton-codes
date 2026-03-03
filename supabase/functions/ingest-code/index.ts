import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API = "https://api.openai.com/v1";
const MAX_PAGES = 150;          // safety limit per source
const CHUNK_TARGET = 800;       // target words per chunk
const CHUNK_OVERLAP_WORDS = 80; // overlap between chunks

// ── HTML → plain text ────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, "\n\n## $2\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Extract internal ecode360 links ──────────────────────────────────────────

function extractLinks(html: string, baseHost: string): string[] {
  const hrefs: string[] = [];
  const pattern = /href="([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1];
    if (href.startsWith("/") && !href.startsWith("//")) {
      hrefs.push(`https://${baseHost}${href}`);
    } else if (href.startsWith(`https://${baseHost}`)) {
      hrefs.push(href);
    }
  }
  // deduplicate
  return [...new Set(hrefs)].filter(
    (u) => !u.includes("#") && !u.includes("?") && !u.includes("/pdf") && !u.includes("/print")
  );
}

// ── Chunk text by section headers (§ or ##) ───────────────────────────────────

function chunkText(text: string, sourceUrl: string): Array<{ content: string; section_title: string; section_path: string; source_url: string }> {
  // Split on section markers
  const sectionPattern = /(?=\n##\s|\n§\s|\nSection\s\d|\nARTICLE\s|\nChapter\s|\nCh\s\d)/gi;
  let rawSections = text.split(sectionPattern).filter((s) => s.trim().length > 50);

  // Fallback: if no sections found, split by paragraphs
  if (rawSections.length === 0) {
    const paragraphs = text.split(/\n\n+/).filter((s) => s.trim().length > 30);
    if (paragraphs.length === 0) return [];
    let current = "";
    for (const p of paragraphs) {
      if ((current + " " + p).split(/\s+/).length > CHUNK_TARGET && current.length > 0) {
        rawSections.push(current.trim());
        current = p;
      } else {
        current = current ? current + "\n\n" + p : p;
      }
    }
    if (current.trim().length > 30) rawSections.push(current.trim());
  }

  const chunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];

  for (const section of rawSections) {
    const lines = section.trim().split("\n");
    const titleLine = lines[0].replace(/^#+\s*/, "").trim();
    const words = section.split(/\s+/);

    if (words.length <= CHUNK_TARGET * 1.5) {
      chunks.push({
        content: section.trim(),
        section_title: titleLine.slice(0, 200),
        section_path: titleLine.slice(0, 300),
        source_url: sourceUrl,
      });
    } else {
      let i = 0;
      let chunkIndex = 0;
      while (i < words.length) {
        const slice = words.slice(i, i + CHUNK_TARGET);
        chunks.push({
          content: slice.join(" "),
          section_title: titleLine.slice(0, 200),
          section_path: `${titleLine} (part ${chunkIndex + 1})`.slice(0, 300),
          source_url: sourceUrl,
        });
        i += CHUNK_TARGET - CHUNK_OVERLAP_WORDS;
        chunkIndex++;
      }
    }
  }

  return chunks;
}

// ── Embed via OpenAI ──────────────────────────────────────────────────────────

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch(`${OPENAI_API}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI embeddings failed: ${resp.status} ${err}`);
  }
  const json = await resp.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { source_id } = await req.json();
    if (!source_id) throw new Error("source_id is required");

    // Get source record
    const { data: source, error: srcErr } = await supabase
      .from("code_sources")
      .select("*")
      .eq("id", source_id)
      .single();
    if (srcErr || !source) throw new Error("Source not found");

    const rootUrl = new URL(source.url);
    const visited = new Set<string>();
    const queue = [source.url];
    const allChunks: Array<{ content: string; section_title: string; section_path: string; source_url: string }> = [];

    // Crawl pages BFS up to MAX_PAGES
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      let html = "";
      try {
        console.log(`Fetching: ${url}`);
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          console.log(`  HTTP ${resp.status} for ${url}`);
          continue;
        }
        html = await resp.text();
        console.log(`  Got ${html.length} chars of HTML`);
      } catch (e) {
        console.log(`  Fetch error for ${url}: ${e}`);
        continue;
      }

      const text = htmlToText(html);
      console.log(`  Extracted ${text.length} chars of text, chunks possible: ${text.length > 200}`);
      if (text.length > 200) {
        const chunks = chunkText(text, url);
        console.log(`  Created ${chunks.length} chunks`);
        allChunks.push(...chunks);
      }

      // Follow links from all pages (within the same host)
      const links = extractLinks(html, rootUrl.host)
        .filter((l) => !visited.has(l) && !queue.includes(l))
        .slice(0, MAX_PAGES - visited.size);
      queue.push(...links);
    }

    if (allChunks.length === 0) {
      await supabase.from("code_sources").update({ status: "error" }).eq("id", source_id);
      return new Response(JSON.stringify({ error: "No content extracted from source URL" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Delete old chunks for this source
    await supabase.from("code_chunks").delete().eq("source_id", source_id);

    // Embed and store in batches of 20
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
      if (insertErr) console.error("Insert error:", insertErr);
      else stored += rows.length;
    }

    // Update source status
    await supabase.from("code_sources").update({
      status: "ready",
      chunk_count: stored,
      last_ingested_at: new Date().toISOString(),
    }).eq("id", source_id);

    return new Response(
      JSON.stringify({ success: true, chunks: stored, pages: visited.size }),
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
