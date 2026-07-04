/**
 * ContentProvider — abstraction over game content storage.
 *
 * LocalContentProvider:  reads from the filesystem (current behaviour).
 * FirebaseContentProvider / S3ContentProvider / etc.: reads from remote storage.
 *
 * Only content operations live here — HTTP serving strategy is the server's concern.
 */

export interface DirEntry {
  name: string;
  /** Absolute path to this entry. */
  path: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
}

/** Call to stop watching. */
export type Unwatch = () => void;

export interface ContentProvider {
  /** True when content lives on the local filesystem (fastify-static can serve it directly). */
  readonly isLocal: boolean;

  exists(absPath: string): Promise<boolean>;
  readFile(absPath: string): Promise<Buffer>;
  readText(absPath: string): Promise<string>;
  list(absPath: string): Promise<DirEntry[]>;
  stat(absPath: string): Promise<FileStat>;

  /**
   * Watch a directory for changes. Calls onChange (debounced) on add/change/unlink.
   * Returns an unwatch function. Optional — only local providers implement this.
   */
  watch?(absPath: string, onChange: () => void): Unwatch;
}
