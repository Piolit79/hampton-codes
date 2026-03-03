import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API = "https://api.openai.com/v1";
const MATCH_COUNT = 6;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { question, municipality } = await req.json();
    if (!question) throw new Error("question is required");

    // 1. Embed the question
    const embedResp = await fetch(`${OPENAI_API}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: question }),
    });
    if (!embedResp.ok) throw new Error(`Embedding failed: ${embedResp.status}`);
    const embedJson = await embedResp.json();
    const queryEmbedding: number[] = embedJson.data[0].embedding;

    // 2. Vector similarity search
    let query = supabase.rpc("match_code_chunks", {
      query_embedding: queryEmbedding,
      match_count: MATCH_COUNT,
    });

    // Filter by municipality if specified
    if (municipality) {
      query = supabase.rpc("match_code_chunks_filtered", {
        query_embedding: queryEmbedding,
        match_count: MATCH_COUNT,
        filter_municipality: municipality,
      });
    }

    const { data: chunks, error: matchErr } = await query;
    if (matchErr) throw matchErr;

    if (!chunks || chunks.length === 0) {
      return new Response(
        JSON.stringify({
          answer: "I couldn't find relevant sections in the building codes for your question. Try rephrasing, or make sure the relevant municipality's code has been ingested.",
          sources: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Build context from top chunks
    const context = chunks
      .map((c: { section_title: string; municipality: string; content: string }, i: number) =>
        `[${i + 1}] ${c.section_title ? `Section: ${c.section_title}\n` : ""}Municipality: ${c.municipality}\n${c.content}`
      )
      .join("\n\n---\n\n");

    // 4. Call GPT-4o
    const systemPrompt = `You are an expert on building codes and zoning regulations for the Hamptons area of Long Island, New York.
Answer questions clearly and precisely based only on the provided code sections.
If the answer varies by municipality, note the differences.
Always cite which municipality and section your answer comes from.
If the code sections don't contain enough information to answer definitively, say so clearly.`;

    const chatResp = await fetch(`${OPENAI_API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Based on the following building code sections, answer this question:\n\n${question}\n\n---\nCODE SECTIONS:\n${context}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    if (!chatResp.ok) {
      const err = await chatResp.text();
      throw new Error(`GPT-4o failed: ${chatResp.status} ${err}`);
    }

    const chatJson = await chatResp.json();
    const answer = chatJson.choices[0].message.content;

    // 5. Return answer + source metadata
    const sources = chunks.map((c: {
      id: string;
      section_title: string;
      section_path: string;
      municipality: string;
      source_url: string;
      similarity: number;
    }) => ({
      id: c.id,
      section_title: c.section_title,
      section_path: c.section_path,
      municipality: c.municipality,
      source_url: c.source_url,
      similarity: c.similarity,
    }));

    return new Response(
      JSON.stringify({ answer, sources }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
