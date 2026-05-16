/**
 * Open the nuna://play discovery URL via the OS default URL handler.
 *
 * Uses the `open` package which delegates to `start` (Windows),
 * `open` (macOS), or `xdg-open` (Linux).
 */

import open from 'open';
import pc from 'picocolors';

/**
 * Launch `nuna://play?discovery=<discoveryUrl>` via the OS URL handler.
 */
export async function openDiscoveryUrl(discoveryUrl: string): Promise<void> {
  const nunaUrl = `nuna://play?discovery=${encodeURIComponent(discoveryUrl)}`;
  console.log(pc.dim(`  [open] launching ${nunaUrl}`));
  try {
    await open(nunaUrl);
  } catch (err) {
    console.error(pc.yellow(`  [open] failed to open URL: ${(err as Error).message}`));
    console.error(pc.yellow(`  [open] manually open: ${nunaUrl}`));
  }
}
