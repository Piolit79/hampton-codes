import { useQuery, useMutation, useQueryClient, useCallback } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
      toast.info('Uploading PDF...');

      // Upload PDF to Supabase Storage
      const filePath = `${sourceId}/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage
        .from('code-pdfs')
        .upload(filePath, file, { contentType: 'application/pdf', upsert: true });
      if (uploadErr) throw uploadErr;

      toast.info('Extracting text from PDF...');

      // Extract text and chunk via edge function
      const { data, error: pdfErr } = await supabase.functions.invoke('ingest-pdf', {
        body: { source_id: sourceId, file_path: filePath },
      });
      if (pdfErr) throw pdfErr;
      if (data?.error) throw new Error(data.error);

      toast.info(`Processing ${data.total_chunks} chunks...`);
      qc.invalidateQueries({ queryKey: ['code-sources'] });

      // Run batches until done
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
