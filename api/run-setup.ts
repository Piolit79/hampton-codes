import type { VercelRequest, VercelResponse } from '@vercel/node';

const SUPABASE_URL = 'https://shticridijsejlwgjxel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodGljcmlkaWpzZWpsd2dqeGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTE5NDAsImV4cCI6MjA4ODA4Nzk0MH0.0ltXwCHsAigEWgZkZNYlYfEf5tWWs3m4XJcDk7vBv8Q';

export const maxDuration = 60;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/setup-search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const data = await resp.json();
  return res.status(resp.ok ? 200 : 500).json(data);
}
