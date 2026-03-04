import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
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
  });
}

export function useIngestSource() {
  const qc = useQueryClient();

  const discover = useMutation({
    mutationFn: async (sourceId: string) => {
      const { data, error } = await supabase.functions.invoke('ingest-discover', { body: { source_id: sourceId } });
      if (error) throw error;
      return data;
    },
  });

  const runBatch = useCallback(async (sourceId: string): Promise<boolean> => {
    const { data, error } = await supabase.functions.invoke('ingest-batch', { body: { source_id: sourceId } });
    if (error) throw error;
    qc.invalidateQueries({ queryKey: ['code-sources'] });
    return data.done;
  }, [qc]);

  const ingest = useCallback(async (sourceId: string) => {
    try {
      // Step 1: discover all URLs (fast)
      await discover.mutateAsync(sourceId);
      qc.invalidateQueries({ queryKey: ['code-sources'] });
      toast.info('URLs discovered — processing pages...');

      // Step 2: process batches until done
      let done = false;
      while (!done) {
        done = await runBatch(sourceId);
        await new Promise((r) => setTimeout(r, 1000));
      }
      toast.success('Ingestion complete');
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    } catch (err) {
      toast.error('Ingestion failed', { description: err instanceof Error ? err.message : 'Unknown error' });
      await supabase.from('code_sources').update({ status: 'error' } as any).eq('id', sourceId);
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    }
  }, [discover, runBatch, qc]);

  return { ingest, isPending: discover.isPending };
}
