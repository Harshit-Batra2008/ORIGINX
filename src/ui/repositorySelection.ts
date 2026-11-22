import * as vscode from 'vscode';

/** Prefer the clicked repository, then the editor, then an explicit workspace folder. */
export async function selectRepositoryPath(resource?: vscode.Uri | vscode.SourceControl): Promise<string | undefined> {
  const clicked = resource && ('scheme' in resource ? resource : resource.rootUri);
  if (clicked?.scheme === 'file') return clicked.fsPath;

  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri?.scheme === 'file') return editorUri.fsPath;

  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  if (folders.length === 1) return folders[0].uri.fsPath;
  if (folders.length > 1) {
    const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the Git repository for this action' });
    if (selected?.uri.scheme === 'file') return selected.uri.fsPath;
  }
  return undefined;
}
