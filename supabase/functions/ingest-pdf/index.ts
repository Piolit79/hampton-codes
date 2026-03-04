import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractText } from "npm:unpdf";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CHUNK_TARGET = 800;
const CHUNK_OVERLAP_WORDS = 80;

function chunkText(text: string, sourceUrl: string, title: string) {
  const sectionPattern = /(?=\n##\s|\n###\s|\n§\s|\nSection\s\d|\nARTICLE\s|\nCHAPTER\s)/gi;
  const rawSections = text.split(sectionPattern).filter((s) => s.trim().length > 50);
  const chunks: Array<{ content: string; section_title: string; section_path: string }> = [];

  for (const section of rawSections) {
    const lines = section.trim().split("\n");
    const titleLine = lines[0].replace(/^#+\s*/, "").trim() || title;
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
          content: words.slice(i, i + CHUNK_TARGET).join(" "),
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { source_id, file_path } = await req.json();
    if (!source_id || !file_path) throw new Error("source_id and file_path required");

    const { data: source } = await supabase
      .from("code_sources").select("*").eq("id", source_id).single();
    if (!source) throw new Error("Source not found");

    // Download PDF directly from Supabase Storage
    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("code-pdfs")
      .download(file_path);
    if (downloadErr || !fileData) throw new Error(`Failed to download PDF: ${downloadErr?.message}`);

    // Extract text locally using unpdf (edge-compatible) — no external API, no timeout issues
    const buffer = await fileData.arrayBuffer();
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });

    if (!text || text.length < 100) {
      throw new Error("No text extracted — PDF may be image-based (scanned). Try a text-based PDF.");
    }

    // Chunk the extracted text
    const chunks = chunkText(text, source.url, source.name);
    if (chunks.length === 0) throw new Error("No chunks created from PDF text");

    // Clear only pending queue items — preserve already-processed chunks so
    // multi-part uploads accumulate rather than overwrite
    await supabase.from("ingest_queue").delete()
      .eq("source_id", source_id).eq("status", "pending");

    // Store chunks in the queue with content pre-filled
    const INSERT_BATCH = 100;
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH).map((chunk) => ({
        source_id,
        url: source.url,
        content: chunk.content,
        status: "pending",
      }));
      await supabase.from("ingest_queue").insert(batch);
    }

    // Update source status — keep existing chunk_count so multi-part uploads accumulate
    await supabase.from("code_sources").update({
      status: "ingesting",
      total_urls: chunks.length,
      processed_urls: 0,
    }).eq("id", source_id);

    return new Response(
      JSON.stringify({ success: true, total_chunks: chunks.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ingest-pdf error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
