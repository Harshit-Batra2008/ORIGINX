import * as fs from 'fs';
import * as path from 'path';

type StorageError = new (message: string, code: string) => Error;

/** Resolve each existing link before following it, even if the final path is missing. */
function resolveExistingPath(repoRoot: string, relativePath: string): string | undefined {
  if (typeof relativePath !== 'string' || !relativePath.trim() || /^(?:[a-z]:|[\\/])/i.test(relativePath) ||
      relativePath.includes('\0') || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected a repository-relative path.');
  }
  const root = fs.realpathSync(repoRoot);
  let current = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (entry.isSymbolicLink()) {
      current = fs.realpathSync(current);
      const relative = path.relative(root, current);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('The linked path points outside this repository.');
      }
    }
  }
  return current;
}

export function resolveRepositoryFile(repoRoot: string, relativeFilePath: string): string | undefined {
  const file = resolveExistingPath(repoRoot, relativeFilePath);
  if (file && !fs.statSync(file).isFile()) throw new Error('Expected a regular file in this repository.');
  return file;
}

export function memoryDirectory(repoRoot: string, kind: 'decisions' | 'checkpoints', ErrorType: StorageError): string {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw new ErrorType('repoRoot must be a non-empty string', 'INVALID_REPO_ROOT');
  }
  const dir = path.resolve(repoRoot, '.gitwhisper', kind);
  if (fs.existsSync(repoRoot)) {
    try {
      const resolved = resolveExistingPath(repoRoot, '.gitwhisper/' + kind);
      if (resolved && !fs.statSync(resolved).isDirectory()) throw new Error('Expected a directory.');
    } catch {
      throw new ErrorType('The memory directory must resolve inside this repository.', 'PATH_TRAVERSAL');
    }
  }
  return dir;
}

/** The caller supplies a schema-validated record ID. Reject linked or special files on every access. */
export function memoryRecordPath(dir: string, id: string, ErrorType: StorageError): string {
  const file = path.join(dir, id + '.md');
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw new ErrorType('A memory record cannot be a symbolic link.', 'UNSAFE_SYMLINK');
  if (entry && !entry.isFile()) throw new ErrorType('A memory record must be a regular file.', 'INVALID_TARGET');
  return file;
}
