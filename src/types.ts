// Shared types for the MOTaxIntelligence Worker.

export interface Env {
  AI: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  /** Full-scope key for /admin/* (constant-time compared). */
  TAX_SERVICE_KEY?: string;
}

export type EntityClass = 'llc_single_member' | 'llc_multi_member' | 's_corp' | 'general';

/** Query-time entity filter value accepted by /query. */
export type EntityFilter = 'llc_single' | 'llc_multi' | 's_corp' | 'general' | 'any';

export interface ParentRecord {
  id: string;
  citation: string;
  chapter: string;
  section: string;
  catchline: string | null;
  effective_date: string | null;
  statute_year: string | null;
  authority: string | null;
  entity_tags: EntityClass[];
  ent_llc_single: boolean;
  ent_llc_multi: boolean;
  ent_s_corp: boolean;
  ent_general: boolean;
  source: string | null;
  source_url: string;
  retrieved_at: string;
  checksum: string;
  char_len: number;
  body: string;
}

export interface ChildRecord {
  id: string;
  parent_id: string;
  seq: number;
  start_char: number;
  end_char: number;
  text: string;
  breadcrumb: string | null;
  ent_llc_single: boolean;
  ent_llc_multi: boolean;
  ent_s_corp: boolean;
  ent_general: boolean;
}

/** A single citable answer: the whole section verbatim + which span matched. */
export interface Citation {
  citation: string;              // Mo. Rev. Stat. § 143.436
  section: string;
  chapter: string;
  catchline: string | null;
  effective_date: string | null;
  statute_year: string | null;
  authority: string | null;
  entity_tags: EntityClass[];
  source_url: string;
  retrieved_at: string;
  checksum: string;
  score: number;                 // best child score for this parent
  body: string;                  // VERBATIM full section
  matched_spans: { start_char: number; end_char: number; score: number }[];
}
