/**
 * The version this sidecar declares in `hello`.
 *
 * A literal rather than a `package.json` read: the release artifact is a
 * single self-contained executable with no package manifest beside it, and a
 * version that resolves differently in the binary than in the checkout is a
 * version nobody can trust. `version.test.ts` pins it to `package.json`.
 */
export const SIDECAR_VERSION = '0.2.0';
