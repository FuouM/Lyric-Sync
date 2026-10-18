// packages/lyricsync/web/src/fs-access.d.ts
// Chromium File System Access API members that TypeScript's DOM lib does not declare.
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker(options?: { suggestedName?: string; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle>;
}

interface FileSystemHandle {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}
