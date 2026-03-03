import { AppLayout } from '@/components/AppLayout';
import { useCodeSources, useIngestSource } from '@/hooks/useCodeSources';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, CheckCircle, AlertCircle, Clock, ExternalLink } from 'lucide-react';

const STATUS_CONFIG = {
  pending: { label: 'Not ingested', variant: 'outline' as const, icon: Clock },
  ingesting: { label: 'Ingesting...', variant: 'warning' as const, icon: Loader2 },
  ready: { label: 'Ready', variant: 'success' as const, icon: CheckCircle },
  error: { label: 'Error', variant: 'destructive' as const, icon: AlertCircle },
};

export default function Admin() {
  const { data: sources, isLoading } = useCodeSources();
  const ingest = useIngestSource();

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  const totalChunks = (sources || []).reduce((sum, s) => sum + (s.chunk_count || 0), 0);
  const readyCount = (sources || []).filter((s) => s.status === 'ready').length;

  return (
    <AppLayout>
      <div className="p-6 lg:p-8 max-w-3xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">Manage Code Sources</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Ingest building codes to make them searchable. {readyCount}/{(sources || []).length} sources ready · {totalChunks.toLocaleString()} total chunks
          </p>
        </div>

        <div className="space-y-4">
          {(sources || []).map((source) => {
            const cfg = STATUS_CONFIG[source.status] || STATUS_CONFIG.pending;
            const StatusIcon = cfg.icon;
            const isIngesting = ingest.isPending && ingest.variables === source.id;

            return (
              <Card key={source.id} className="border border-border">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-foreground">{source.name}</h3>
                        <Badge variant={cfg.variant} className="gap-1">
                          <StatusIcon className={`h-3 w-3 ${source.status === 'ingesting' ? 'animate-spin' : ''}`} />
                          {cfg.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {source.url}
                        </a>
                        {source.chunk_count > 0 && (
                          <span>{source.chunk_count.toLocaleString()} chunks</span>
                        )}
                        {source.last_ingested_at && (
                          <span>Last ingested {new Date(source.last_ingested_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={source.status === 'ready' ? 'outline' : 'default'}
                      className="gap-1.5 shrink-0"
                      disabled={isIngesting || source.status === 'ingesting'}
                      onClick={() => ingest.mutate(source.id)}
                    >
                      {isIngesting || source.status === 'ingesting' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : source.status === 'ready' ? (
                        <RefreshCw className="h-3.5 w-3.5" />
                      ) : null}
                      {source.status === 'ready' ? 'Re-ingest' : 'Ingest'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-8 rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">How ingestion works</p>
          <p>Clicking "Ingest" fetches the building code from the source URL, splits it into sections, and generates vector embeddings so it can be searched semantically.</p>
          <p>Ingestion may take 1–5 minutes depending on the code's length. You can navigate away while it runs.</p>
        </div>
      </div>
    </AppLayout>
  );
}
