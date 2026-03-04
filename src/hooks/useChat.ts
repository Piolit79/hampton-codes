import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface ChatSource {
  id: string;
  section_title: string;
  section_path: string;
  municipality: string;
  source_url: string;
  similarity: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  loading?: boolean;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const sendMessage = useCallback(async (question: string, municipality?: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: question,
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      loading: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setLoading(true);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, municipality: municipality || null }),
      });
      let data: any;
      try {
        data = await resp.json();
      } catch {
        throw new Error(`Server error ${resp.status} — response was empty or timed out`);
      }
      if (!resp.ok) throw new Error(data.error || 'Chat failed');

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: data.answer, sources: data.sources, loading: false }
            : m
        )
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: `Error: ${errMsg}`, loading: false }
            : m
        )
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, loading, sendMessage, clearMessages };
}
