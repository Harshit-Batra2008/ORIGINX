/** Directories that do not provide source-file evidence. */
export const DEFAULT_EXCLUDED_DIRECTORY_SEGMENTS = [
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.venv',
  '__pycache__', '.git', '.gitwhisper'
];

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isGitWhisperPath(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().split('/').includes('.gitwhisper');
}

export function isExcludedPath(filePath: string, customSegments?: string[]): boolean {
  const excluded = customSegments?.length ? customSegments : DEFAULT_EXCLUDED_DIRECTORY_SEGMENTS;
  const segments = normalizePath(filePath).toLowerCase().split('/');
  // These hold repository state, including when a custom graph exclusion list is in use.
  return isGitWhisperPath(filePath) || segments.includes('.git') ||
    excluded.some(entry => segments.includes(entry.trim().toLowerCase()));
}

export function isSourceTarget(filePath: string, excludedSegments?: string[]): boolean {
  if (!filePath || !filePath.trim() || /[\x00-\x1f\x7f]/.test(filePath)) return false;
  const normalized = normalizePath(filePath);
  if (/^[a-z]:/i.test(normalized) || isExcludedPath(normalized, excludedSegments)) return false;
  return normalized.split('/').every(part => part && part !== '.' && part !== '..' &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
