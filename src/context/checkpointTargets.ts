import { GitExecOptions } from '../git/gitService';
import { isSourceTarget, normalizePath } from '../git/sourcePaths';
import { listWorkingTreeEntries } from '../git/workingTreeStatus';

export async function collectCheckpointTargets(
  repoRoot: string,
  activeRelativeFile?: string | null,
  options?: GitExecOptions
): Promise<string[]> {
  const targets = new Set<string>();
  if (activeRelativeFile && isSourceTarget(activeRelativeFile)) targets.add(normalizePath(activeRelativeFile));
  for (const entry of await listWorkingTreeEntries(repoRoot, options)) targets.add(entry.filePath);
  return [...targets];
}
