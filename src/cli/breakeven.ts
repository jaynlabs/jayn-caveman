import type { SessionResult } from '../transcript/replay.js';
import type { Args, Command } from './args.js';
import { cohorts, counterFor, placementFrom, project, PLACEMENT_HELP } from './projection.js';
import { ROOT_HELP, targetsFrom } from './roots.js';

const SPEC = {
  value: ['root', 'model', 'buckets', 'placement'],
  boolean: ['exact', 'mixed-languages'],
} as const;

const DEFAULT_BUCKETS = [200, 400, 600, 800, 1000, 1500, 2500];

const USAGE = `jayn-caveman breakeven — the one variable that decides whether caveman pays

${ROOT_HELP}
  --buckets <a,b,c>   bucket edges in prose per prompt (default: ${DEFAULT_BUCKETS.join(',')})
  --model <family>    fit p_fire on one model family only, e.g. claude-opus-5
  --mixed-languages   keep sessions that are not entirely English
${PLACEMENT_HELP}
  --exact             count tokens with Anthropic's count_tokens API instead of the
                      offline BPE counter. Needs ANTHROPIC_API_KEY.

Buckets every session by the prose tokens the model wrote per prompt the user sent, then
reports what the replay did to each bucket.

That variable is arithmetic, not correlation. caveman's cost is charged per prompt: one
reminder every time you hit enter, plus the ruleset once per session. Its benefit is a
fraction of the prose in the answer. It pays exactly when the answer is long enough to
cover the reminder that asked for it.

Sessions that already ran caveman are excluded, and sessions are restricted to English by
default, for the reasons \`corpora\` prints.`;

const pct = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n * 100).toFixed(3)}%`;
const share = (n: number) => `${(n * 100).toFixed(1)}%`;

interface Bucket {
  label: string;
  sessions: number;
  billUSD: number;
  savedUSD: number;
  gained: number;
}

function bucketsFrom(args: Args): number[] {
  const raw = args.list('buckets');
  if (raw === undefined) return DEFAULT_BUCKETS;
  const edges = raw.map(Number);
  if (edges.some((edge) => !Number.isFinite(edge) || edge <= 0)) {
    throw new Error(`--buckets takes positive numbers, got "${args.value('buckets')}"`);
  }
  return [...edges].sort((a, b) => a - b);
}

function labelsFor(edges: number[]): string[] {
  const labels = edges.map((edge, index) => `${index === 0 ? 0 : edges[index - 1]}–${edge}`);
  labels.push(`${edges[edges.length - 1]}+`);
  return labels;
}

function bucketOf(perPrompt: number, edges: number[]): number {
  const found = edges.findIndex((edge) => perPrompt < edge);
  return found === -1 ? edges.length : found;
}

function tally(results: SessionResult[], edges: number[]): Bucket[] {
  const buckets: Bucket[] = labelsFor(edges).map((label) => ({
    label,
    sessions: 0,
    billUSD: 0,
    savedUSD: 0,
    gained: 0,
  }));

  for (const result of results) {
    if (result.userPrompts === 0) continue;
    const bucket = buckets[bucketOf(result.proseTokens / result.userPrompts, edges)]!;
    const saved = result.actualUSD - result.optimizedUSD;
    bucket.sessions++;
    bucket.billUSD += result.actualUSD;
    bucket.savedUSD += saved;
    if (saved > 0) bucket.gained++;
  }
  return buckets;
}

function crossing(buckets: Bucket[], edges: number[]): string | null {
  const first = buckets.findIndex((bucket) => bucket.sessions > 0 && bucket.savedUSD > 0);
  if (first === -1) return null;
  if (first === 0) return `below ${edges[0]} prose tokens per prompt — every bucket here pays`;
  const below = edges[first - 1]!;
  const above = edges[first];
  return above === undefined
    ? `above ${below} prose tokens per prompt`
    : `between ${below} and ${above} prose tokens per prompt`;
}

async function run(args: Args): Promise<void> {
  const edges = bucketsFrom(args);
  const found = await cohorts(targetsFrom(args), !args.has('mixed-languages'));
  const sessions = found.flatMap((cohort) => cohort.sessions);
  if (sessions.length === 0) throw new Error('No usable sessions found.');

  const counting = counterFor(args, sessions);
  let buckets: Bucket[];
  try {
    const { measured } = await project(sessions, counting.counter, args.value('model'), placementFrom(args));
    buckets = tally(measured.results, edges);
  } finally {
    counting.flush();
  }

  const totalUSD = buckets.reduce((total, bucket) => total + bucket.billUSD, 0);
  const width = Math.max(...buckets.map((bucket) => bucket.label.length), 24);

  const corpora = found.length === 1 ? '1 corpus' : `${found.length} corpora`;
  console.log(`# break-even — ${sessions.length} sessions across ${corpora}`);
  console.log('');
  console.log(
    `  ${'prose per prompt'.padEnd(width)}${'sessions'.padStart(10)}${'share of bill'.padStart(15)}` +
      `${'share that gain'.padStart(17)}${'money-weighted'.padStart(16)}`,
  );
  console.log(`  ${'-'.repeat(width + 58)}`);

  for (const bucket of buckets) {
    if (bucket.sessions === 0) continue;
    console.log(
      `  ${bucket.label.padEnd(width)}${String(bucket.sessions).padStart(10)}` +
        `${share(totalUSD === 0 ? 0 : bucket.billUSD / totalUSD).padStart(15)}` +
        `${share(bucket.gained / bucket.sessions).padStart(17)}` +
        `${pct(bucket.billUSD === 0 ? 0 : bucket.savedUSD / bucket.billUSD).padStart(16)}`,
    );
  }

  const where = crossing(buckets, edges);
  console.log('');
  if (where === null) {
    console.log('  No bucket comes out positive here. On this corpus caveman never pays.');
  } else {
    console.log(`  Breaks even ${where}.`);
  }
  console.log('');
  console.log('  Prose tokens here are the whole prose of a session, which is English-only unless');
  console.log('  you passed --mixed-languages. Divide your own by the prompts you send: well under');
  console.log('  the crossing, do not bother; well over, it might pay.');
}

export const breakevenCommand: Command = {
  name: 'breakeven',
  summary: 'bucket sessions by prose per prompt — the variable that decides the sign',
  usage: USAGE,
  spec: SPEC,
  run,
};
