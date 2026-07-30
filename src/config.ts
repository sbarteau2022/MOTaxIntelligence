// Single source of truth for the model + index identity. These MUST match the
// Elle stack exactly, or the vectors won't share a space with elle-corpus and
// Atlas can't query them natively.
//
// bge-large-en-v1.5 → 1024 dims, cosine. Same model Elle uses in
// src/index.ts / retrieval/config.ts.
export const EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';
export const EMBEDDING_DIMS = 1024;
export const VECTORIZE_INDEX = 'mo-tax-vectors';
export const D1_DATABASE = 'mo-tax';
