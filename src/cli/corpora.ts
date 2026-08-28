import type { Args, Command } from './args.js';
import { cohorts, counterFor, placementFrom, project, PLACEMENT_HELP, type Cohort } from './projection.js';
import { ROOT_HELP, targetsFrom } from './roots.js';

const SPEC = { value: ['root', 'model', 'placement'], boolean: ['exact', 'mixed-languages'] } as const;

const USAGE = `jayn-caveman corpora — what installing caveman would have done to people who never ran it

${ROOT_HELP}
  --model <family>    fit p_fire on one model family only, e.g. claude-opus-5
  --mixed-languages   keep sessions that are not entirely English
${PLACEMENT_HELP}
  --exact             count tokens with Anthropic's count_tokens API instead of the
                      offline BPE counter. Needs ANTHROPIC_API_KEY.

One row per directory, plus a pooled row. Each row is priced twice over the same
transcripts: once charging caveman's ratio to every turn, which is the number a
single-turn benchmark reports, and once with the measured p_fire wired in.

Sessions that already ran caveman are excluded and reported separately: they carry its
injections, so replaying them measures a reconstruction rather than a projection.

Sessions are restricted to English by default. caveman's deletion rules name English
function words and were measured not firing on French at all, so a mixed-language corpus
prices an instrument rather than the tool. --mixed-languages lifts that at your own risk.`;

const usd = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n * 100).toFixed(2)}%`;
const bill = (n: number) => `$${n.toFixed(2)}`;

const LABEL = 18;

function row(label: string, billUSD: number, always: [number, number], measured: [number, number]): string {
  return (
    `  ${label.padEnd(LABEL)}${bill(billUSD).padStart(11)}` +
    `${usd(always[0]).padStart(12)}${pct(always[1]).padStart(10)}` +
    `${usd(measured[0]).padStart(12)}${pct(measured[1]).padStart(10)}`
  );
}

async function renderCohort(cohort: Cohort, args: Args): Promise<string[]> {
  const counting = counterFor(args, cohort.sessions);
  try {
    const { alwaysFires, measured } = await project(
      cohort.sessions,
      counting.counter,
      args.value('model'),
      placementFrom(args),
    );
    return [
      row(
        cohort.label,
        cohort.billUSD,
        [alwaysFires.totals.availableUSD, alwaysFires.totals.availablePct],
        [measured.totals.availableUSD, measured.totals.availablePct],
      ),
      `  ${' '.repeat(LABEL)}${`${cohort.sessions.length} sessions`.padStart(11)}` +
        `   p̄ ${(measured.meanPFire * 100).toFixed(1)}%` +
        `   ceiling ${(measured.proseShareOfBill * 100).toFixed(1)}% of the bill`,
    ];
  } finally {
    counting.flush();
  }
}

async function run(args: Args): Promise<void> {
  const targets = targetsFrom(args);
  const english = !args.has('mixed-languages');
  const found = await cohorts(targets, english);
  if (found.length === 0) throw new Error('No transcripts found.');

  const header =
    `  ${'corpus'.padEnd(LABEL)}${'bill'.padStart(11)}` +
    `${'if it always fired'.padStart(22)}${'with p_fire wired in'.padStart(22)}`;
  console.log(header);
  console.log(`  ${'-'.repeat(header.length - 2)}`);

  for (const cohort of found) {
    for (const line of await renderCohort(cohort, args)) console.log(line);
  }

  if (found.length > 1) {
    const pooled: Cohort = {
      label: 'all',
      sessions: found.flatMap((cohort) => cohort.sessions),
      billUSD: found.reduce((total, cohort) => total + cohort.billUSD, 0),
      cavemanSessions: found.reduce((total, cohort) => total + cohort.cavemanSessions, 0),
      cavemanUSD: found.reduce((total, cohort) => total + cohort.cavemanUSD, 0),
      otherLanguageSessions: found.reduce((total, cohort) => total + cohort.otherLanguageSessions, 0),
      otherLanguageUSD: found.reduce((total, cohort) => total + cohort.otherLanguageUSD, 0),
    };
    console.log(`  ${'-'.repeat(header.length - 2)}`);
    for (const line of await renderCohort(pooled, args)) console.log(line);
  }

  const excludedCaveman = found.reduce((total, cohort) => total + cohort.cavemanSessions, 0);
  const excludedLanguage = found.reduce((total, cohort) => total + cohort.otherLanguageSessions, 0);
  console.log('');
  if (excludedCaveman > 0) {
    const spend = found.reduce((total, cohort) => total + cohort.cavemanUSD, 0);
    console.log(
      `! ${excludedCaveman} session(s) (${bill(spend)}) excluded: caveman was already live in them.`,
    );
  }
  if (excludedLanguage > 0) {
    const spend = found.reduce((total, cohort) => total + cohort.otherLanguageUSD, 0);
    console.log(
      `! ${excludedLanguage} session(s) (${bill(spend)}) excluded: not entirely English. A corpus that` +
        '\n  loses most of its spend here has no English-only projection worth reading.',
    );
  }

  const biggest = [...found].sort((a, b) => b.billUSD - a.billUSD)[0];
  const total = found.reduce((sum, cohort) => sum + cohort.billUSD, 0);
  if (biggest && found.length > 1 && total > 0 && biggest.billUSD / total > 0.5) {
    console.log('');
    console.log(
      `! ${biggest.label} is ${((biggest.billUSD / total) * 100).toFixed(0)}% of the pooled bill, so the pooled row is` +
        `\n  mostly that one person. Read the per-corpus rows, not the total.`,
    );
  }
}

export const corporaCommand: Command = {
  name: 'corpora',
  summary: 'per-corpus projection: what caveman would have cost people who never installed it',
  usage: USAGE,
  spec: SPEC,
  run,
};
