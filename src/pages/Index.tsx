import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { useChat } from '@/hooks/useChat';
import { useCodeSources } from '@/hooks/useCodeSources';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Send, Loader2, ExternalLink, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';

const SUGGESTIONS = [
  'What are the setback requirements for a single-family home?',
  'What permits are required for a deck or patio?',
  'What are the height limits for fences?',
  'Are ADUs (accessory dwelling units) allowed?',
  'What are the rules for swimming pools?',
];

export default function Index() {
  const { messages, loading, sendMessage, clearMessages } = useChat();
  const { data: sources } = useCodeSources();
  const [input, setInput] = useState('');
  const [municipality, setMunicipality] = useState<string>('all');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const readySources = (sources || []).filter((s) => s.status === 'ready');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');
    sendMessage(q, municipality === 'all' ? undefined : municipality);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="border-b border-border px-6 py-3 flex items-center gap-3 shrink-0">
          <div className="flex-1">
            <Select value={municipality} onValueChange={setMunicipality}>
              <SelectTrigger className="w-64 h-8 text-xs">
                <SelectValue placeholder="All municipalities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All municipalities</SelectItem>
                {readySources.map((s) => (
                  <SelectItem key={s.id} value={s.municipality}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={clearMessages}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6 max-w-3xl mx-auto">
            {messages.length === 0 ? (
              <div className="pt-12 text-center">
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  Ask about Hampton building codes
                </h2>
                <p className="text-sm text-muted-foreground mb-8">
                  {readySources.length === 0
                    ? 'No code sources loaded yet. Go to Manage Sources to ingest the building codes.'
                    : `Searching across ${readySources.length} municipal code${readySources.length !== 1 ? 's' : ''}.`}
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                      className="text-xs px-3 py-2 rounded-full border border-border hover:bg-muted transition-colors text-left"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[85%]', msg.role === 'user' ? 'order-2' : 'order-1')}>
                    <div
                      className={cn(
                        'rounded-2xl px-4 py-3 text-sm',
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground'
                      )}
                    >
                      {msg.loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : msg.role === 'assistant' ? (
                        <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-p:my-1">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        msg.content
                      )}
                    </div>
                    {/* Source citations */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-[11px] text-muted-foreground px-1">Sources:</p>
                        {msg.sources.map((src) => (
                          <div key={src.id} className="flex items-start gap-2 bg-muted/50 rounded-lg px-3 py-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-foreground truncate">{src.section_title || src.section_path}</p>
                              <p className="text-[11px] text-muted-foreground">{src.municipality}</p>
                            </div>
                            <a href={src.source_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground transition-colors">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t border-border p-4 shrink-0">
          <div className="max-w-3xl mx-auto flex gap-2">
            <Textarea
              ref={textareaRef}
              placeholder="Ask a question about building codes..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              className="resize-none min-h-[40px] max-h-32"
            />
            <Button onClick={handleSend} disabled={!input.trim() || loading} size="icon" className="shrink-0 self-end">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground text-center mt-2">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
