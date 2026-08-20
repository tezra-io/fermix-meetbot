// Minimal types for the two internal playwright-core entry points the
// browser install uses. Both are real subpaths in playwright-core's `exports`
// map (`./lib/coreBundle`, `./lib/utilsBundle`) but ship without declarations.
// We type only the surface `install-browser.ts` touches.

declare module 'playwright-core/lib/coreBundle' {
  export const libCli: {
    decorateProgram(program: { parseAsync(argv: readonly string[]): Promise<unknown> }): void;
  };
  // Entry the out-of-process browser downloader forks into (over IPC).
  export const registry: {
    runOopDownloadBrowserMain(): void;
  };
}

declare module 'playwright-core/lib/utilsBundle' {
  export const program: {
    parseAsync(argv: readonly string[]): Promise<unknown>;
  };
}
