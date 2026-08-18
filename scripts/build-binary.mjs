/**
 * Builds the release artifact: one self-contained executable per target.
 *
 * Two steps, both hermetic apart from the toolchain already in node_modules:
 *
 *   1. esbuild bundles src/main.ts and everything it imports — including
 *      playwright-core — into a single CommonJS file.
 *   2. Node's Single Executable Application support injects that bundle into a
 *      copy of the running `node` binary (postject writes the blob into the
 *      NODE_SEA_BLOB section).
 *
 * SEA cannot cross-compile: the artifact is always for the host that built it,
 * which is why release.yml runs one matrix leg per target rather than one job
 * with four outputs.
 *
 * Chromium is NOT bundled. The operator's machine fetches the Chromium build
 * pinned by this repo's playwright version (`npx playwright install chromium`)
 * — a browser is ~150 MB and pinning it to a downloaded artifact would make
 * every fermix release carry it.
 *
 * This is the owner/release gate, deliberately outside `npm run build` and
 * `npm test` so the default loop stays fast and hermetic.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'build');
const BUNDLE = join(BUILD_DIR, 'meetbot.cjs');
const BLOB = join(BUILD_DIR, 'meetbot.blob');
const SEA_CONFIG = join(BUILD_DIR, 'sea-config.json');

/**
 * Modules playwright-core reaches for on code paths this sidecar never takes,
 * and which therefore must not be dragged into the bundle:
 *
 *   chromium-bidi  the WebDriver-BiDi transport. We drive Chromium over CDP
 *                  (`chromium.launchPersistentContext`), and the BiDi module is
 *                  loaded from a lazy `__esm` initializer that only that
 *                  transport runs.
 *   fsevents       chokidar's optional macOS native watcher, already wrapped in
 *                  a try/catch upstream that falls through to polling.
 *
 * Each is replaced by a module that throws with its own name. A stub that
 * threw silently, or resolved to an empty object, would turn "this build can't
 * do that" into a mystery further downstream.
 */
const UNBUNDLED = [
  {
    pattern: /^chromium-bidi(\/|$)/,
    why: 'this build drives Chromium over CDP, not WebDriver-BiDi',
  },
  { pattern: /^fsevents$/, why: 'the native macOS watcher is not bundled; chokidar polls instead' },
];

/**
 * playwright-core reads two of its own JSON files at runtime, through requires
 * built from `__dirname`:
 *
 *     packageJSON = require(join(packageRoot, "package.json"))
 *     registry    = new Registry(require(join(packageRoot, "browsers.json")))
 *
 * A bundle has no package root, and inside a SEA `require` of an absolute path
 * resolves against built-in modules only — so both blow up at load. Both files
 * are static, so they are inlined at bundle time.
 *
 * `browsers.json` is the Chromium revision pin. Inlining it is what makes the
 * binary agree with `npx playwright install chromium` about which build to
 * look for in `~/.cache/ms-playwright`; `packageRoot` itself is only consulted
 * for browser lookup when `PLAYWRIGHT_BROWSERS_PATH=0`, which this sidecar
 * never sets.
 *
 * The needles are asserted, not attempted: a playwright bump that moves them
 * fails the release build loudly instead of shipping a binary that dies on its
 * first launch.
 */
const PLAYWRIGHT_INLINES = [
  {
    name: 'package.json',
    needle: /packageJSON = require\([A-Za-z0-9_.]+\.join\(packageRoot, "package\.json"\)\)/g,
    replace: (json) => `packageJSON = ${json}`,
  },
  {
    name: 'browsers.json',
    needle: /new Registry\(require\([A-Za-z0-9_.]+\.join\(packageRoot, "browsers\.json"\)\)\)/g,
    replace: (json) => `new Registry(${json})`,
  },
];

function playwrightInlinePlugin(replacements) {
  const hits = new Map(PLAYWRIGHT_INLINES.map((entry) => [entry.name, 0]));

  return {
    name: 'inline-playwright-json',
    setup(build) {
      build.onLoad({ filter: /playwright-core[/\\]lib[/\\][^/\\]+\.js$/ }, async (args) => {
        let contents = await readFile(args.path, 'utf8');
        for (const entry of PLAYWRIGHT_INLINES) {
          contents = contents.replace(entry.needle, () => {
            hits.set(entry.name, hits.get(entry.name) + 1);
            return entry.replace(replacements[entry.name]);
          });
        }
        return { contents, loader: 'js' };
      });

      build.onEnd(() => {
        for (const [name, count] of hits) {
          if (count === 0) {
            throw new Error(
              `inline-playwright-json found no "${name}" require to replace. ` +
                'playwright-core changed shape; update PLAYWRIGHT_INLINES before releasing.',
            );
          }
          console.log(`  inlined playwright ${name} (${String(count)} site(s))`);
        }
      });
    },
  };
}

const unbundledPlugin = {
  name: 'unbundled-optional-modules',
  setup(build) {
    build.onResolve({ filter: /^(chromium-bidi|fsevents)/ }, (args) => {
      const match = UNBUNDLED.find((entry) => entry.pattern.test(args.path));
      return match === undefined ? null : { path: args.path, namespace: 'unbundled' };
    });
    build.onLoad({ filter: /.*/, namespace: 'unbundled' }, (args) => {
      const match = UNBUNDLED.find((entry) => entry.pattern.test(args.path));
      const message = `"${args.path}" is not bundled into fermix-meetbot: ${match.why}`;
      return { contents: `throw new Error(${JSON.stringify(message)});`, loader: 'js' };
    });
  },
};

/** Matches `FermixCore.Meetings.SidecarInstaller.target/0`. */
function hostTarget() {
  const os = { darwin: 'macos', linux: 'linux' }[platform()];
  const cpu = { arm64: 'aarch64', x64: 'x86_64' }[arch()];
  if (os === undefined || cpu === undefined) {
    throw new Error(
      `unsupported host ${platform()}/${arch()}; fermix pins macos|linux x aarch64|x86_64`,
    );
  }
  return `${os}-${cpu}`;
}

function playwrightJson() {
  const root = join(ROOT, 'node_modules', 'playwright-core');
  const read = (name) => readFileSync(join(root, name), 'utf8');
  return { 'package.json': read('package.json'), 'browsers.json': read('browsers.json') };
}

async function bundle() {
  console.log('bundling src/main.ts');
  await build({
    entryPoints: [join(ROOT, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: BUNDLE,
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    plugins: [playwrightInlinePlugin(playwrightJson()), unbundledPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}

function sea(target) {
  const output = join(BUILD_DIR, `fermix-meetbot-${target}`);
  writeFileSync(
    SEA_CONFIG,
    JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true }, null, 2),
  );

  console.log('generating the SEA blob');
  execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });

  console.log(`copying the node runtime to ${output}`);
  copyFileSync(process.execPath, output);
  chmodSync(output, 0o755);

  if (platform() === 'darwin') {
    // An existing signature covers the section table; strip it, inject, then
    // ad-hoc re-sign. Release signing happens afterwards in release.yml.
    execFileSync('codesign', ['--remove-signature', output], { stdio: 'inherit' });
  }

  console.log('injecting the blob');
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
      output,
      'NODE_SEA_BLOB',
      BLOB,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      ...(platform() === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ],
    { stdio: 'inherit' },
  );

  if (platform() === 'darwin') {
    execFileSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
  }

  return output;
}

async function main() {
  const host = hostTarget();
  const target = process.argv[2] ?? host;
  // SEA copies the *running* node binary, so the artifact is always for this
  // host. An argument is a declaration of intent, checked against reality —
  // otherwise a matrix leg on the wrong runner would upload a correctly named
  // artifact for the wrong architecture, and the daemon would download a
  // binary that cannot execute.
  if (target !== host) {
    throw new Error(
      `refusing to label a ${host} build as "${target}": Node SEA cannot cross-compile. ` +
        'Run this on a matching runner.',
    );
  }

  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  await bundle();
  const output = sea(target);
  console.log(`\nfermix-meetbot ${target}: ${output}`);
  console.log('the operator machine still needs: npx playwright install chromium');
}

await main();
