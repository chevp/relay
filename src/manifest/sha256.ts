/**
 * SHA-256 file hashing via node:crypto streams.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
