import type { Turn } from './session.js';

/**
 * What happened to the prefix between two consecutive requests, read out of billing alone.
 *
 * The transcript does not say whether a cache entry survived, expired, or was compacted away.
 * The bill does, indirectly: `cache_read + cache_creation + input` is the whole input side of a
 * request, and that total is invariant to how a TTL expiry splits tokens between the read lane
 * and the write lane. Its turn-to-turn delta is therefore what actually *arrived*, and any
 * cache creation beyond that is prefix being written a second time.
 *
 * This is the same identity `corpus/anatomy.ts` attributes an observed bill with. It is stated
 * once here because `transcript/replay.ts` needs it for a different job — pricing a
 * counterfactual delta rather than splitting a real bill — and the two must not drift.
 */

/** The whole input side of one request, however the cache happened to split it. */
export function requestSize(turn: Turn): number {
  return turn.cacheRead + turn.cacheWrite5m + turn.cacheWrite1h + turn.inputTokens;
}

export function writtenTokens(turn: Turn): number {
  return turn.cacheWrite5m + turn.cacheWrite1h;
}

/**
 * Cache creation that is NOT new content: the part of this request's write lane that was
 * already in the previous request. Partial TTL expiry, a prefix crossing a cache breakpoint, or
 * a full cold start all land here.
 */
export function rewrittenTokens(prev: Turn, turn: Turn): number {
  const arrived = Math.max(0, requestSize(turn) - requestSize(prev));
  return Math.max(0, writtenTokens(turn) - arrived);
}

/**
 * Of the previous prefix that is still present, the fraction that was re-written rather than
 * read back cheaply. 0 on a clean cache hit, 1 on a full cold start, strictly between the two
 * on a partial expiry — which is the case the old `cacheRead === 0` test could not see.
 */
export function rewriteShare(prev: Turn, turn: Turn): number {
  const rewritten = rewrittenTokens(prev, turn);
  const present = turn.cacheRead + rewritten;
  if (present <= 0) return 0;
  return rewritten / present;
}

/**
 * Of the previous prefix, the fraction still present at all. Below 1 only when the request
 * genuinely shrank — compaction, context editing, a dropped prefix. A cold start re-writes
 * everything but loses nothing, so it survives at 1.
 */
export function survivingShare(prev: Turn, turn: Turn): number {
  const before = requestSize(prev);
  if (before <= 0) return 1;
  const present = turn.cacheRead + rewrittenTokens(prev, turn);
  return Math.min(1, present / before);
}

export type Transition = 'steady' | 'growth' | 'cold' | 'partial' | 'compaction' | 'compactionRewrite';

/**
 * Tokens of slack before a discrepancy counts as a re-write rather than as accounting noise.
 * Purely a reporting threshold: `rewriteShare` and `survivingShare` are exact, so nothing
 * priced depends on it.
 */
const TOLERANCE = 64;

export function classify(prev: Turn, turn: Turn): Transition {
  const arrived = requestSize(turn) - requestSize(prev);
  const rewritten = rewrittenTokens(prev, turn);

  if (turn.cacheRead === 0 && writtenTokens(turn) > 0) return 'cold';
  if (arrived < -TOLERANCE) return rewritten > TOLERANCE ? 'compactionRewrite' : 'compaction';
  if (rewritten > TOLERANCE) return 'partial';
  if (arrived > TOLERANCE) return 'growth';
  return 'steady';
}
