/**
 * Single source of truth for the CLI version. Imported by cli.ts and any
 * subcommand that needs to print/embed it. Lives in its own module to avoid
 * circular imports between cli.ts and commands/.
 */
export const VERSION = '0.3.0';
