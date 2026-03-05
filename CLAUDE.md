# Hamptons Code — Project Context

## What This App Does
AI-powered building code Q&A chatbot for Hamptons municipalities. Users ask natural language questions about building codes (setbacks, permits, height limits, ADUs, pools, etc.) and get answers with cited code sections.

## Live URL
https://hampton-codes.vercel.app (confirm this)

## GitHub
https://github.com/Piolit79/hampton-codes

## Tech Stack
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Vercel serverless functions (TypeScript)
- **Database**: Supabase (vector store for code sections)
- **AI**: OpenAI — GPT-4o (responses) + text-embedding-3-small (embeddings)
- **Deployment**: Vercel

## Key Files
| File | Purpose |
|------|---------|
| `src/pages/Index.tsx` | Main chat interface — municipality filter, message thread, source citations, suggested queries |
| `src/pages/Admin.tsx` | Admin panel |
| `src/components/AppLayout.tsx` | App layout wrapper |
| `api/chat.ts` | Main chat handler — embeddings → vector search → GPT-4o response (60s timeout) |
| `api/ingest-pdf.ts` | Ingest a single PDF building code document into Supabase vector store |
| `api/ingest-batch.ts` | Batch ingestion of multiple code documents |
| `api/run-setup.ts` | Setup/initialization script |
| `api/debug.ts` | Debug utilities |

## Chat Flow
1. User asks a question (with optional municipality filter)
2. Question is embedded via `text-embedding-3-small`
3. Vector similarity search against stored code sections in Supabase
4. If no results: keyword fallback search (3+ char terms, excludes stop words, searches section titles)
5. Context passed to GPT-4o with specialized system prompt
6. Response returned with source metadata (URLs, section titles, similarity scores)

## UI Features
- Municipality dropdown filter (search one or all)
- Conversational chat format (user right-aligned, assistant left-aligned)
- Clickable source citations per response
- Suggested queries on empty state
- Enter to send, Shift+Enter for new line
- Clear conversation button
- Markdown rendering for responses

## Session Log

### 2026-03-05
- First time reviewing this project in Claude Code
- Reviewed full project structure via GitHub
- Set up CLAUDE.md for session memory across all three projects
- **Next**: Ask user what they want to work on

## Notes
- Two routes: `/` (chat) and `/admin`
- Code sections stored as vector embeddings in Supabase
- GPT-4o prompt emphasizes accuracy and citing specific municipal codes
