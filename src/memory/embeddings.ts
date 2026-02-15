import OpenAI from 'openai';

// OpenAI client - lazily initialized
let openaiClient: OpenAI | null = null;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Initialize OpenAI client
 */
export function initEmbeddings(apiKey: string): void {
  openaiClient = new OpenAI({ apiKey });
}

/**
 * Check if embeddings are available
 */
export function hasEmbeddings(): boolean {
  return openaiClient !== null;
}

/**
 * Generate embedding for text
 */
export async function embed(text: string): Promise<number[]> {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized - call initEmbeddings first');
  }

  const response = await openaiClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0].embedding;
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Serialize embedding to buffer for SQLite storage
 */
export function serializeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

/**
 * Deserialize embedding from SQLite buffer
 */
export function deserializeEmbedding(buffer: Buffer): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}
