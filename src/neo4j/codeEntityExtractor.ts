/**
 * GitWhisper — Code Entity & Configuration Key Extractor
 * Reliably extracts functions, classes, and configuration keys from source files
 * to support fine-grained Neo4j code symbol mapping.
 */

export interface ExtractedCodeEntity {
  name: string;
  kind: 'function' | 'class' | 'config_key';
  startLine: number;
  endLine: number;
  filePath: string;
}

/**
 * Extracts functions, classes, and top-level definitions from file content.
 * Supports Python, TypeScript, JavaScript, and key-value configuration formats.
 */
export function extractCodeEntities(filePath: string, content: string): ExtractedCodeEntity[] {
  const entities: ExtractedCodeEntity[] = [];
  if (!content || !content.trim()) {
    return entities;
  }

  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const lines = content.split(/\r?\n/);

  // 1. Python source files (.py)
  if (normalizedPath.endsWith('.py')) {
    const fnRegex = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/;
    const classRegex = /^class\s+([a-zA-Z0-9_]+)\s*(?:\(|$|:)/;

    let currentEntity: { name: string; kind: 'function' | 'class'; startLine: number; indent: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // Check for top-level or method definitions
      const fnMatch = line.match(fnRegex);
      const classMatch = line.match(classRegex);

      if (fnMatch || classMatch) {
        if (currentEntity) {
          entities.push({
            name: currentEntity.name,
            kind: currentEntity.kind,
            startLine: currentEntity.startLine,
            endLine: lineNum - 1,
            filePath,
          });
        }
        const name = fnMatch ? fnMatch[1] : classMatch![1];
        const kind = fnMatch ? 'function' : 'class';
        const indent = line.length - line.trimStart().length;
        currentEntity = { name, kind, startLine: lineNum, indent };
      }
    }

    if (currentEntity) {
      entities.push({
        name: currentEntity.name,
        kind: currentEntity.kind,
        startLine: currentEntity.startLine,
        endLine: lines.length,
        filePath,
      });
    }
    return entities;
  }

  // 2. TypeScript / JavaScript (.ts, .tsx, .js, .jsx)
  if (/\.[tj]sx?$/.test(normalizedPath)) {
    const fnRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*[\(<]/;
    const classRegex = /^(?:export\s+)?class\s+([a-zA-Z0-9_]+)/;
    const constFnRegex = /^(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const fnMatch = line.match(fnRegex);
      const classMatch = line.match(classRegex);
      const constMatch = line.match(constFnRegex);

      if (fnMatch || classMatch || constMatch) {
        const name = fnMatch ? fnMatch[1] : (classMatch ? classMatch[1] : constMatch![1]);
        const kind = classMatch ? 'class' : 'function';

        let endLine = lineNum;
        let openBraces = 0;
        let foundOpen = false;
        for (let j = i; j < lines.length; j++) {
          const l = lines[j];
          for (const ch of l) {
            if (ch === '{') {
              openBraces++;
              foundOpen = true;
            } else if (ch === '}') {
              openBraces--;
            }
          }
          if (foundOpen && openBraces <= 0) {
            endLine = j + 1;
            break;
          }
        }
        if (!foundOpen) endLine = lineNum;

        entities.push({
          name,
          kind,
          startLine: lineNum,
          endLine: Math.max(lineNum, endLine),
          filePath,
        });
      }
    }
    return entities;
  }

  // 3. Configuration files (.json, .yaml, .yml, .ini, .env)
  if (/\.(?:json|ya?ml|ini|env)$/.test(normalizedPath)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      // JSON / YAML key: "key": value or key: value
      const keyMatch = line.match(/^(?:["']?([a-zA-Z0-9_.-]+)["']?\s*:|=)/);
      if (keyMatch) {
        entities.push({
          name: keyMatch[1],
          kind: 'config_key',
          startLine: lineNum,
          endLine: lineNum,
          filePath,
        });
      }
    }
    return entities;
  }

  return entities;
}

/**
 * Finds which code entity contains the given line range.
 */
export function findEnclosingEntity(
  entities: ExtractedCodeEntity[],
  startLine: number,
  endLine?: number
): ExtractedCodeEntity | undefined {
  const targetEnd = endLine ?? startLine;
  return entities.find(e => e.startLine <= targetEnd && e.endLine >= startLine);
}
