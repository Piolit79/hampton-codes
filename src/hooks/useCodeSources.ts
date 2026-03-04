import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import * as pdfjsLib from 'pdfjs-dist';

// Use CDN worker — no bundling needed
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

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

async function extractTextFromPDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

export interface CodeSource {
  id: string;
  name: string;
  url: string;
  municipality: string;
  status: 'pending' | 'ingesting' | 'ready' | 'error';
  chunk_count: number;
  total_urls: number;
  processed_urls: number;
  last_ingested_at: string | null;
  created_at: string;
}

export function useCodeSources() {
  return useQuery({
    queryKey: ['code-sources'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('code_sources')
        .select('*')
        .order('name');
      if (error) throw error;
      return data as CodeSource[];
    },
    refetchInterval: (query) => {
      const sources = query.state.data as CodeSource[] | undefined;
      return sources?.some((s) => s.status === 'ingesting') ? 3000 : false;
    },
  });
}

export function useUploadAndIngest() {
  const qc = useQueryClient();

  return useCallback(async (sourceId: string, file: File) => {
    try {
      // Step 1: Extract text in the browser (no server, no timeouts)
      toast.info('Extracting text from PDF...');
      const text = await extractTextFromPDF(file);
      if (!text || text.length < 100) {
        throw new Error('No text extracted — PDF may be image-based (scanned).');
      }

      // Step 2: Get source info
      const { data: source } = await supabase
        .from('code_sources').select('*').eq('id', sourceId).single();
      if (!source) throw new Error('Source not found');

      // Step 3: Chunk the text
      const chunks = chunkText(text, source.url, source.name);
      if (chunks.length === 0) throw new Error('No chunks created from PDF text');
      toast.info(`Uploading ${chunks.length} chunks...`);

      // Step 4: Upload PDF to storage (for record-keeping)
      const filePath = `${sourceId}/${Date.now()}_${file.name}`;
      await supabase.storage
        .from('code-pdfs')
        .upload(filePath, file, { contentType: 'application/pdf', upsert: true });

      // Step 5: Clear pending queue, insert new chunks
      await supabase.from('ingest_queue').delete()
        .eq('source_id', sourceId).eq('status', 'pending');

      const INSERT_BATCH = 100;
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const batch = chunks.slice(i, i + INSERT_BATCH).map((chunk) => ({
          source_id: sourceId,
          url: source.url,
          content: chunk.content,
          status: 'pending',
        }));
        await supabase.from('ingest_queue').insert(batch);
      }

      // Step 6: Update source status
      await supabase.from('code_sources').update({
        status: 'ingesting',
        total_urls: chunks.length,
        processed_urls: 0,
      }).eq('id', sourceId);

      qc.invalidateQueries({ queryKey: ['code-sources'] });
      toast.info(`Processing ${chunks.length} chunks...`);

      // Step 7: Run ingest-batch until done
      let done = false;
      while (!done) {
        const { data: batchData, error: batchErr } = await supabase.functions.invoke('ingest-batch', {
          body: { source_id: sourceId },
        });
        if (batchErr) throw batchErr;
        if (batchData?.error) throw new Error(batchData.error);
        done = batchData.done;
        qc.invalidateQueries({ queryKey: ['code-sources'] });
        if (!done) await new Promise((r) => setTimeout(r, 500));
      }

      toast.success('Ingestion complete');
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
      await supabase.from('code_sources').update({ status: 'error' } as any).eq('id', sourceId);
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    }
  }, [qc]);
}
