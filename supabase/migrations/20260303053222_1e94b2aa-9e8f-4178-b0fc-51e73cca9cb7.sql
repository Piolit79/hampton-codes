-- Code sources (one row per municipality)
CREATE TABLE code_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  municipality TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  chunk_count INT NOT NULL DEFAULT 0,
  last_ingested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Code chunks with vector embeddings
CREATE TABLE code_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES code_sources(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  section_title TEXT,
  section_path TEXT,
  source_url TEXT,
  embedding VECTOR(1536),
  token_count INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Vector similarity index
CREATE INDEX ON code_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- RLS
ALTER TABLE code_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read code_sources" ON code_sources FOR SELECT USING (true);
CREATE POLICY "Service all code_sources" ON code_sources FOR ALL USING (true);
CREATE POLICY "Public read code_chunks" ON code_chunks FOR SELECT USING (true);
CREATE POLICY "Service all code_chunks" ON code_chunks FOR ALL USING (true);

-- Seed the 7 Hampton municipalities
INSERT INTO code_sources (name, url, municipality) VALUES
  ('Town of Southampton',    'https://ecode360.com/SO0286', 'Town of Southampton'),
  ('Village of Southampton', 'https://ecode360.com/SO0841', 'Village of Southampton'),
  ('Town of East Hampton',   'https://ecode360.com/EA0658', 'Town of East Hampton'),
  ('Village of East Hampton','https://ecode360.com/EA0361', 'Village of East Hampton'),
  ('Village of Sag Harbor',  'https://ecode360.com/SA0314', 'Village of Sag Harbor'),
  ('Village of North Haven', 'https://ecode360.com/NO1009', 'Village of North Haven'),
  ('Village of Sagaponack',  'https://ecode360.com/SA2797', 'Village of Sagaponack');