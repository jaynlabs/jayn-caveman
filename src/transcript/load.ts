import { glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { analyzeSession, type AnalyzeOptions, type SessionAnalysis } from './session.js';
import { BpeCounter, calibrate, memoCountTokens } from './tokens.js';

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');

function sessionKey(session: SessionAnalysis): string {
  if (session.sessionId !== 'unknown') return session.sessionId;
  return join(basename(dirname(session.file)), basename(session.file));
}

export function dedupeSessions(sessions: readonly SessionAnalysis[]): SessionAnalysis[] {
  const byKey = new Map<string, SessionAnalysis>();
  for (const session of sessions) {
    const key = sessionKey(session);
    const existing = byKey.get(key);
    if (existing === undefined || session.turns.length > existing.turns.length) byKey.set(key, session);
  }

  const kept: SessionAnalysis[] = [];
  const seen = new Set<string>();
  for (const session of byKey.values()) {
    const turns = session.turns.filter((turn) => !seen.has(turn.id));
    for (const turn of turns) seen.add(turn.id);
    if (turns.length === 0) continue;
    kept.push(turns.length === session.turns.length ? session : { ...session, turns });
  }
  return kept;
}

export async function loadSessions(
  roots: string | readonly string[] = DEFAULT_ROOT,
  liveSessionId?: string,
  options: AnalyzeOptions = {},
): Promise<SessionAnalysis[]> {
  const analysed: SessionAnalysis[] = [];
  for (const root of typeof roots === 'string' ? [roots] : roots) {
    const files: string[] = [];
    for await (const file of glob(join(root, '**', '*.jsonl'))) files.push(file);
    files.sort();

    for (const file of files) {
      if (liveSessionId && basename(file, '.jsonl') === liveSessionId) continue;
      const session = await analyzeSession(file, options);
      if (liveSessionId && session.sessionId === liveSessionId) continue;
      analysed.push(session);
    }
  }
  return dedupeSessions(analysed);
}

export interface LoadTarget {
  label: string;
  roots: readonly string[];
}

export async function loadGrouped(
  targets: readonly LoadTarget[],
  options: AnalyzeOptions = {},
): Promise<Map<SessionAnalysis, string>> {
  const labelOf = new Map<string, string>();
  const analysed: SessionAnalysis[] = [];
  for (const target of targets) {
    for (const session of await loadSessions(target.roots, undefined, options)) {
      if (!labelOf.has(session.file)) labelOf.set(session.file, target.label);
      analysed.push(session);
    }
  }

  const owned = new Map<SessionAnalysis, string>();
  for (const session of dedupeSessions(analysed)) {
    owned.set(session, labelOf.get(session.file) ?? 'unknown');
  }
  return owned;
}

export function groupByLabel(
  owned: Map<SessionAnalysis, string>,
  targets: readonly LoadTarget[],
): Map<string, SessionAnalysis[]> {
  const byLabel = new Map<string, SessionAnalysis[]>(targets.map((t) => [t.label, []]));
  for (const [session, label] of owned) {
    const sessions = byLabel.get(label);
    if (sessions === undefined) byLabel.set(label, [session]);
    else sessions.push(session);
  }
  return byLabel;
}

export function groundTruthSamples(
  sessions: SessionAnalysis[],
  limit = Infinity,
): Array<{ text: string; model: string; billedTokens: number }> {
  const samples: Array<{ text: string; model: string; billedTokens: number }> = [];
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (!turn.onlyTextBlocks || turn.hasFence || turn.proseText.length < 200) continue;
      samples.push({ text: turn.proseText, model: turn.model, billedTokens: turn.outputTokens });
      if (samples.length >= limit) return samples;
    }
  }
  return samples;
}

export function calibrateLocally(sessions: SessionAnalysis[]): {
  counter: BpeCounter;
  holdoutRatio: number | null;
  samples: number;
} {
  const all = groundTruthSamples(sessions);
  const shuffled = [...all].sort((a, b) => a.text.length - b.text.length);
  const fit = shuffled.filter((_, i) => i % 2 === 0);
  const holdout = shuffled.filter((_, i) => i % 2 === 1);

  const calibration = calibrate(
    fit.map((s) => ({
      model: s.model,
      legacyTokens: memoCountTokens(s.text),
      tokens: s.billedTokens,
    })),
  );
  const counter = new BpeCounter(calibration);

  let predicted = 0;
  let actual = 0;
  for (const sample of holdout) {
    predicted += memoCountTokens(sample.text) * counter.calibrationFor(sample.model).factor;
    actual += sample.billedTokens;
  }
  return {
    counter,
    holdoutRatio: actual > 0 ? predicted / actual : null,
    samples: all.length,
  };
}
