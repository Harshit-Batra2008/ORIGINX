/**
 * GitWhisper — Language Provider Adapter
 * Encapsulates VS Code language provider commands with safe fallbacks and testability.
 */

import * as path from 'path';

export interface DocumentSymbolResult {
  name: string;
  kind: string;
  range: {
    startLine: number; // 1-indexed
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  children?: DocumentSymbolResult[];
}

export interface CallHierarchyIncomingCallResult {
  callerName: string;
  callerKind?: string;
  callerFilePath: string;
  callerRange: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  callSiteLines: number[]; // 1-indexed call site lines
}

export interface ReferenceLocationResult {
  filePath: string;
  line: number; // 1-indexed
  character: number; // 1-indexed
  previewSnippet?: string;
}

export interface ILanguageProviderAdapter {
  isAvailable(): boolean;
  getDocumentSymbols(filePath: string): Promise<DocumentSymbolResult[]>;
  getIncomingCalls(filePath: string, line: number, character?: number): Promise<CallHierarchyIncomingCallResult[]>;
  getReferences(filePath: string, line: number, character?: number, includeDeclaration?: boolean): Promise<ReferenceLocationResult[]>;
}

function getVsCode(): any {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
}

/**
 * Standard implementation that delegates to vscode.commands.executeCommand in the VS Code host.
 */
export class VsCodeLanguageProviderAdapter implements ILanguageProviderAdapter {
  isAvailable(): boolean {
    const vsc = getVsCode();
    return (
      typeof vsc !== 'undefined' &&
      typeof vsc.commands !== 'undefined' &&
      typeof vsc.commands.executeCommand === 'function' &&
      typeof vsc.Uri !== 'undefined'
    );
  }

  async getDocumentSymbols(filePath: string): Promise<DocumentSymbolResult[]> {
    if (!this.isAvailable()) return [];
    const vsc = getVsCode();
    try {
      const uri = vsc.Uri.file(filePath);
      const rawSymbols = await vsc.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
      if (!Array.isArray(rawSymbols)) return [];
      return this.mapDocumentSymbols(rawSymbols);
    } catch {
      return [];
    }
  }

  async getIncomingCalls(filePath: string, line: number, character = 1): Promise<CallHierarchyIncomingCallResult[]> {
    if (!this.isAvailable()) return [];
    const vsc = getVsCode();
    try {
      const uri = vsc.Uri.file(filePath);
      const position = new vsc.Position(Math.max(0, line - 1), Math.max(0, character - 1));
      const items: any[] = await vsc.commands.executeCommand('vscode.prepareCallHierarchy', uri, position);
      if (!Array.isArray(items) || items.length === 0) return [];

      const results: CallHierarchyIncomingCallResult[] = [];
      for (const item of items) {
        const incoming: any[] = await vsc.commands.executeCommand('vscode.provideIncomingCalls', item);
        if (Array.isArray(incoming)) {
          for (const call of incoming) {
            const caller = call.from;
            const ranges = call.fromRanges || [];
            const callLines = ranges.map((r: any) => (r.start ? r.start.line + 1 : 1));
            results.push({
              callerName: caller.name || 'anonymous',
              callerKind: caller.kind !== undefined ? String(caller.kind) : undefined,
              callerFilePath: caller.uri ? caller.uri.fsPath : filePath,
              callerRange: {
                startLine: caller.range ? caller.range.start.line + 1 : 1,
                startCharacter: caller.range ? caller.range.start.character + 1 : 1,
                endLine: caller.range ? caller.range.end.line + 1 : 1,
                endCharacter: caller.range ? caller.range.end.character + 1 : 1,
              },
              callSiteLines: callLines.length > 0 ? callLines : [caller.range?.start?.line ? caller.range.start.line + 1 : 1]
            });
          }
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  async getReferences(filePath: string, line: number, character = 1, includeDeclaration = false): Promise<ReferenceLocationResult[]> {
    if (!this.isAvailable()) return [];
    const vsc = getVsCode();
    try {
      const uri = vsc.Uri.file(filePath);
      const position = new vsc.Position(Math.max(0, line - 1), Math.max(0, character - 1));
      const locations: any[] = await vsc.commands.executeCommand('vscode.executeReferenceProvider', uri, position);
      if (!Array.isArray(locations)) return [];

      return locations.map(loc => {
        const locPath = loc.uri ? loc.uri.fsPath : filePath;
        const lineNum = loc.range?.start ? loc.range.start.line + 1 : 1;
        const colNum = loc.range?.start ? loc.range.start.character + 1 : 1;
        return {
          filePath: locPath,
          line: lineNum,
          character: colNum
        };
      });
    } catch {
      return [];
    }
  }

  private mapDocumentSymbols(symbols: any[]): DocumentSymbolResult[] {
    return symbols.map(sym => {
      const startLine = sym.range?.start ? sym.range.start.line + 1 : (sym.location?.range?.start?.line ? sym.location.range.start.line + 1 : 1);
      const startChar = sym.range?.start ? sym.range.start.character + 1 : 1;
      const endLine = sym.range?.end ? sym.range.end.line + 1 : startLine;
      const endChar = sym.range?.end ? sym.range.end.character + 1 : 1;

      return {
        name: sym.name || 'unnamed',
        kind: String(sym.kind ?? 'symbol'),
        range: {
          startLine,
          startCharacter: startChar,
          endLine,
          endCharacter: endChar
        },
        children: Array.isArray(sym.children) ? this.mapDocumentSymbols(sym.children) : undefined
      };
    });
  }
}
