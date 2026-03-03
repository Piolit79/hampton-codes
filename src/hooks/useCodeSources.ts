import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface CodeSource {
  id: string;
  name: string;
  url: string;
  municipality: string;
  status: 'pending' | 'ingesting' | 'ready' | 'error';
  chunk_count: number;
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
  return useMutation({
    mutationFn: async (sourceId: string) => {
      // Mark as ingesting
      await supabase
        .from('code_sources')
        .update({ status: 'ingesting' })
        .eq('id', sourceId);
      qc.invalidateQueries({ queryKey: ['code-sources'] });

      const { data, error } = await supabase.functions.invoke('ingest-code', {
        body: { source_id: sourceId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, sourceId) => {
      toast.success('Ingestion complete');
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    },
    onError: (err) => {
      toast.error('Ingestion failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
      qc.invalidateQueries({ queryKey: ['code-sources'] });
    },
  });
}
