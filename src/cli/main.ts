import { parseArgs, type Command } from './args.js';
import { analyzeCommand } from './analyze.js';
import { anatomyCommand } from './anatomy.js';
import { breakevenCommand } from './breakeven.js';
import { complianceCommand } from './compliance.js';
import { corporaCommand } from './corpora.js';
import { curvesCommand } from './curves.js';
import { trialCommand } from './trial.js';
import { cliVersion } from '../version.js';

const COMMANDS: Command[] = [
  analyzeCommand,
  anatomyCommand,
  complianceCommand,
  corporaCommand,
  breakevenCommand,
  trialCommand,
  curvesCommand,
];

function topLevelUsage(): string {
  const lines = [
    `jayn-caveman ${cliVersion()} — the measurement code behind "Caveman really does compress model prose"`,
    '',
    'Usage: jayn-caveman <command> [options]',
    '',
  ];
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }
  lines.push('');
  lines.push('Run `jayn-caveman <command> --help` for that command.');
  lines.push('REPRODUCING.md maps each command to the figure it regenerates.');
  return lines.join('\n');
}

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export async function main(argv: readonly string[]): Promise<void> {
  const first = argv[0];
  if (first === undefined || wantsHelp(argv.slice(0, 1))) {
    console.log(topLevelUsage());
    return;
  }

  const command = COMMANDS.find((entry) => entry.name === first);
  if (!command) {
    throw new Error(`unknown command "${first}"\n\n${topLevelUsage()}`);
  }

  const rest = argv.slice(1);
  if (wantsHelp(rest)) {
    console.log(command.usage);
    return;
  }
  return command.run(parseArgs(rest, command.spec));
}
