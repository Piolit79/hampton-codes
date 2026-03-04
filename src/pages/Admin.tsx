import { useRef, useState } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { useCodeSources, useUploadAndIngest } from '@/hooks/useCodeSources';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle, AlertCircle, Clock, ExternalLink, Upload } from 'lucide-react';

const STATUS_CONFIG = {
  pending: { label: 'Not ingested', variant: 'outline' as const, icon: Clock },
  ingesting: { label: 'Ingesting...', variant: 'warning' as const, icon: Loader2 },
  ready: { label: 'Ready', variant: 'success' as const, icon: CheckCircle },
  error: { label: 'Error', variant: 'destructive' as const, icon: AlertCircle },
};

export default function Admin() {
  const { data: sources, isLoading } = useCodeSources();
  const uploadAndIngest = useUploadAndIngest();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeSourceId) return;
    e.target.value = '';
    setUploading(activeSourceId);
    await uploadAndIngest(activeSourceId, file);
    setUploading(null);
    setActiveSourceId(null);
  };

  return (
    <AppLayout>
      <div className="p-6 lg:p-8 max-w-3xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">Manage Code Sources</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload the PDF for each municipality to make it searchable.{' '}
            {readyCount}/{(sources || []).length} ready · {totalChunks.toLocaleString()} total chunks
          </p>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="space-y-4">
          {(sources || []).map((source) => {
            const cfg = STATUS_CONFIG[source.status] || STATUS_CONFIG.pending;
            const StatusIcon = cfg.icon;
            const isUploading = uploading === source.id;
            const isIngesting = source.status === 'ingesting';
            const progress = source.total_urls > 0
              ? Math.round((source.processed_urls / source.total_urls) * 100)
              : 0;

            return (
              <Card key={source.id} className="border border-border">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-foreground">{source.name}</h3>
                        <Badge variant={cfg.variant} className="gap-1">
                          <StatusIcon className={`h-3 w-3 ${isIngesting ? 'animate-spin' : ''}`} />
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
                          View online
                        </a>
                        {source.chunk_count > 0 && (
                          <span>{source.chunk_count.toLocaleString()} chunks</span>
                        )}
                        {source.last_ingested_at && (
                          <span>Last ingested {new Date(source.last_ingested_at).toLocaleDateString()}</span>
                        )}
                      </div>

                      {/* Progress bar */}
                      {isIngesting && source.total_urls > 0 && (
                        <div className="mt-2">
                          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
                            <span>Processing chunks...</span>
                            <span>{source.processed_urls}/{source.total_urls}</span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-1.5">
                            <div
                              className="bg-primary h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 shrink-0"
                      disabled={isUploading || isIngesting}
                      onClick={() => {
                        setActiveSourceId(source.id);
                        fileInputRef.current?.click();
                      }}
                    >
                      {isUploading || isIngesting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="h-3.5 w-3.5" />
                      )}
                      {source.status === 'ready' ? 'Replace PDF' : 'Upload PDF'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-8 rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">How to upload building codes</p>
          <ol className="space-y-1 list-decimal list-inside">
            <li>Go to the municipality's ecode360 page (click "View online")</li>
            <li>Press <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[10px]">Ctrl+P</kbd> → Save as PDF</li>
            <li>Click "Upload PDF" above and select the saved file</li>
            <li>The app will extract, chunk, and embed the full code automatically</li>
          </ol>
        </div>
      </div>
    </AppLayout>
  );
}
