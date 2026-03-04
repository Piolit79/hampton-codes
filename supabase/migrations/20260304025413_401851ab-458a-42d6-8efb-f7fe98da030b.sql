DROP INDEX IF EXISTS code_chunks_embedding_idx;

CREATE INDEX code_chunks_embedding_idx ON code_chunks
USING hnsw (embedding vector_cosine_ops);