/**
 * Embedding provider — turns text into a fixed-length numeric vector
 * suitable for cosine-similarity comparison.
 *
 * Production may inject a sentence-transformer (e.g.
 * `all-MiniLM-L6-v2` via `@xenova/transformers`) for semantic quality.
 * We default to `localTextEmbed`, a deterministic bag-of-words pseudo-
 * embedding that is:
 *   • free, offline, no model download
 *   • good enough for "two articles about the same event share enough
 *     entity tokens that cosine sim crosses the duplicate threshold"
 *   • fast (no ONNX runtime; pure JS)
 *
 * The trade-off: BoW misses synonym-only paraphrases ("dropped" vs
 * "fell"). Real news coverage of the same event almost always shares
 * entity tokens (company name, dollar figure, location), which the BoW
 * captures. The pluggable interface lets us upgrade later without
 * touching call sites.
 *
 * Companion tests: tests/freshness.test.ts (covers embedding + classifier).
 */

export interface EmbeddingProvider {
  embed(text: string): number[];
}

let _provider: EmbeddingProvider | null = null;

/**
 * Inject a custom embedding provider (e.g. a real sentence-transformer
 * in production, or a deterministic mock in tests). Pass null to revert
 * to the BoW default.
 */
export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  _provider = p;
}

/** Compute an embedding using the active provider (or the BoW default). */
export function embed(text: string): number[] {
  return _provider ? _provider.embed(text) : localTextEmbed(text);
}

// ─────────────────────────────────────────────────────────────────────────
// Bag-of-words pseudo-embedding
// ─────────────────────────────────────────────────────────────────────────

/** Dimensionality of the BoW vector. 96 buckets balance discrimination
 *  (different events score low) against overlap (same event scores high)
 *  for the unigram + bigram features we hash in. */
const DIM = 96;

/**
 * Stable string hash with seed → bucket in [0, DIM). FNV-1a variant.
 * The seed lets us populate K hash slots per feature ("hashing trick"),
 * which raises overlap between documents that share the feature without
 * adding model state.
 */
function hash(s: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0; // FNV offset basis xor seed
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % DIM;
}

/**
 * Stopwords stripped before embedding. These dominate raw word counts
 * but carry no event-distinguishing signal — including them dilutes the
 * cosine for paraphrased coverage.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "at", "by", "from",
  "with", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "being", "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "as", "that", "this", "these",
  "those", "it", "its", "into", "over", "under", "than", "then", "so",
  "if", "out", "up", "down", "no", "not", "all", "any", "more", "most",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Bag-of-words pseudo-embedding with bigrams + multi-hash. Each unigram
 * token lands in 2 buckets (different hash seeds) and each adjacent
 * bigram in 1 bucket. This captures more structure than pure unigrams
 * — paraphrased coverage of the same event scores noticeably higher
 * because bigrams like "coinbase outage" and entity-rich tokens get
 * stronger overlap.
 *
 * Properties:
 *   • Identical text → cosine = 1.0
 *   • Same event paraphrased → cosine 0.6-0.85 (above continuation)
 *   • Different events → cosine 0.1-0.3
 *
 * Limitation: pure synonym substitution ("dropped" → "fell") still
 * misses; sentence transformers would catch it. Acceptable trade for
 * the freshness-dedup use case where entity tokens dominate.
 */
export function localTextEmbed(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  if (!text) return vec;
  const toks = tokenize(text);
  // Unigrams with two hash seeds (multi-hash boosts feature overlap).
  for (const t of toks) {
    vec[hash(t, 0)] += 1;
    vec[hash(t, 17)] += 1;
  }
  // Adjacent bigrams.
  for (let i = 0; i + 1 < toks.length; i++) {
    const big = `${toks[i]} ${toks[i + 1]}`;
    vec[hash(big, 53)] += 1;
  }
  return l2normalize(vec);
}

function l2normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

// ─────────────────────────────────────────────────────────────────────────
// Cosine similarity
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity for two vectors of equal length. Assumes inputs are
 * L2-normalized (which `localTextEmbed` always is). Falls back to the
 * full formula otherwise.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aSq += a[i] * a[i];
    bSq += b[i] * b[i];
  }
  const norm = Math.sqrt(aSq) * Math.sqrt(bSq);
  if (norm === 0) return 0;
  return dot / norm;
}
