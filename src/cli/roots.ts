import { basename, dirname, resolve } from 'node:path';
import { DEFAULT_ROOT, type LoadTarget } from '../transcript/load.js';
import type { Args } from './args.js';

export type Target = LoadTarget & { roots: string[] };

/**
 * A registered corpus lives at `<registry>/<name>/projects`, so the last path segment is the
 * word "projects" for every one of them and labelling by it makes a pooled run unreadable. Step
 * up to the segment that actually names the corpus. Affects the label only, never a number.
 */
export function labelFor(root: string): string {
  const full = resolve(root);
  const name = basename(full);
  if (name === 'projects') return basename(dirname(full)) || name;
  return name || root;
}

export function targetsFrom(args: Args, positional?: string): Target[] {
  if (positional !== undefined) return [{ label: labelFor(positional), roots: [positional] }];
  const roots = args.list('root');
  if (roots === undefined) return [{ label: 'live', roots: [DEFAULT_ROOT] }];
  return roots.map((root) => ({ label: labelFor(root), roots: [root] }));
}

export const ROOT_HELP =
  '  --root <dir>,<dir>  one transcript directory per contributor group\n' +
  `                      (default: ${DEFAULT_ROOT})`;
