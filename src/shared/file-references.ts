/** File selections are composer identities, never Apps UserInput.mention attachments. */
export interface FileReference {
  cwd: string;
  path: string;
  start: number;
  end: number;
}
export interface FileSearchQuery {
  projectId: string | null;
  threadId?: string;
  draftId?: string;
  query: string;
}
export interface FileSearchResult {
  cwd: string;
  paths: string[];
  limited: boolean;
}
/** Matches the native TUI's insert_selected_path quoting, including its quote exception. */
export function nativeFilePath(path: string) {
  return /\s/u.test(path) && !path.includes('"') ? `"${path}"` : path;
}
export const fileToken = (path: string) => `@${nativeFilePath(path)}`;

export function literalMessage(text: string, files?: FileReference[]) {
  const escaped = /^(\s*)\/\//u.exec(text);
  return escaped
    ? {
        text: text.replace(/^(\s*)\/\//u, '$1/'),
        files: files?.map((file) => ({ ...file, start: file.start - 1, end: file.end - 1 })),
      }
    : { text, files };
}
