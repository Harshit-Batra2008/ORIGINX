import { GitExecOptions, runGit } from './gitService';
import { isSourceTarget, normalizePath } from './sourcePaths';

export interface WorkingTreeEntry {
  stagedFlag: string;
  unstagedFlag: string;
  filePath: string;
  oldPath?: string;
}

/** With -z Git writes rename destinations first, then the original path as a second field. */
export async function listWorkingTreeEntries(repoRoot: string, options?: GitExecOptions): Promise<WorkingTreeEntry[]> {
  const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot, options);
  if (result.exitCode !== 0) return [];
  const fields = result.stdout.split('\0');
  const entries: WorkingTreeEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4 || field[2] !== ' ') continue;
    const [stagedFlag, unstagedFlag] = field;
    const filePath = normalizePath(field.slice(3));
    const moved = /[RC]/.test(stagedFlag + unstagedFlag);
    const oldPath = moved ? normalizePath(fields[++i] || '') : undefined;
    if (isSourceTarget(filePath)) {
      entries.push({ stagedFlag, unstagedFlag, filePath, oldPath: oldPath && isSourceTarget(oldPath) ? oldPath : undefined });
    }
  }
  return entries;
}
