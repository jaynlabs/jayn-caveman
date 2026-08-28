import { renderAnalysis } from '../report/analyzer.js';
import { calibrateLocally, loadSessions, DEFAULT_ROOT } from '../transcript/load.js';
import { ApiCounter, resolveApiKey, type TokenCounter } from '../transcript/tokens.js';
import { analyze } from '../effects/caveman/analyze.js';
import { CAVEMAN } from '../effects/caveman/effect.js';
import { placementFrom, PLACEMENT_HELP } from './projection.js';
import type { Args, Command } from './args.js';

const SPEC = { value: ['root', 'model', 'placement'], boolean: ['exact', 'brief'] } as const;

const USAGE = `jayn-caveman analyze — the tool-effect replay on its own, in full detail

  --root <dir>,<dir>
                   transcripts to read, one directory per contributor group
                   (default: ${DEFAULT_ROOT})
  --model <family> fit p_fire on one model family only, e.g. claude-opus-5
  --exact          count tokens with Anthropic's count_tokens API instead of the
                   offline BPE counter. Needs ANTHROPIC_API_KEY.
${PLACEMENT_HELP}
  --brief          headline only, without the sensitivity band and audit trail

Pointing --root at a frozen copy of ~/.claude/projects is the only way to compare two
revisions of the model against identical input: the live corpus grows while it is read.

--model restricts what p_fire is ESTIMATED from, both arms, not what is priced: vanilla
terseness spans 28 points between model families, so a curve fitted across a mixture of
them partly measures the mixture. Every turn is still replayed and billed.`;

async function run(args: Args): Promise<void> {
  // a list, like every other command, so pooling two corpora needs no shell brace expansion
  const roots = args.list('root') ?? [DEFAULT_ROOT];

  const sessions = await loadSessions(roots);
  if (sessions.length === 0) {
    throw new Error(`No Claude Code transcripts found under ${roots.join(', ')}.`);
  }

  const local = calibrateLocally(sessions);
  let counter: TokenCounter = local.counter;
  let flush = (): void => {};
  let mode = 'offline (legacy BPE + calibration)';

  if (args.has('exact')) {
    const key = resolveApiKey();
    if (!key) {
      console.error('--exact needs ANTHROPIC_API_KEY; falling back to the offline counter.\n');
    } else {
      const api = new ApiCounter(key);
      counter = api;
      flush = () => api.flush();
      mode = 'exact (count_tokens API)';
    }
  }

  try {
    const report = await analyze(sessions, counter, CAVEMAN, {
      model: args.value('model'),
      placement: placementFrom(args),
    });

    console.log(
      renderAnalysis({ ...report, tokenMode: mode, holdout: local }, { audit: !args.has('brief') }),
    );
  } finally {
    flush();
  }
}

export const analyzeCommand: Command = {
  name: 'analyze',
  summary: 'the tool-effect replay on its own, with the full audit breakdown',
  usage: USAGE,
  spec: SPEC,
  run,
};
