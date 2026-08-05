#!/usr/bin/env node
/**
 * Build the pre-baked WordPress snapshot that @algorismus/elementor-ultra-playground hydrates.
 *
 * A snapshot is just a fully-provisioned Playground site dir (WordPress + Elementor + companion
 * plugin + permalinks + WP_ENVIRONMENT_TYPE baked into wp-config + a minted app password), tarred.
 * Booting it with `--wordpress-install-mode install-from-existing-files` skips the ~4 min of
 * download-WordPress + install-Elementor + run-blueprint that a cold provision pays.
 *
 * Pipeline:
 *   1. Provision a fresh site (reuses dev/playground/setup-playground.mjs).
 *   2. Copy the companion plugin source INTO the site dir — during provisioning it is a live mount,
 *      so only an empty mount point persists; the files must be materialised for a standalone boot.
 *   3. Tar+gzip the site dir, checksum it, and write a manifest carrying the versions and the
 *      (throwaway, local-only) baked credentials so the runtime can print them without any PHP.
 *
 *   node build/make-snapshot.mjs [--reprovision]
 *
 * Outputs: snapshot/site.tar.gz, snapshot/manifest.json
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const MCP_REPO = resolve(PKG, '..', 'elementor-ultra-mcp');
const PG_DIR = join(MCP_REPO, 'dev', 'playground');
const SITE = join(PG_DIR, '.wordpress');
const CREDS = join(PG_DIR, '.out', 'credentials.json');
const PLUGIN_SRC = join(MCP_REPO, 'plugin', 'elementor-ultra-mcp');
const OUT = join(PKG, 'snapshot');
const ASSETS = join(PKG, 'assets');
const TARBALL = join(OUT, 'site.tar.gz');
const MANIFEST = join(OUT, 'manifest.json');
const PORT = 8899;

// Bump when the snapshot contents change so a cached hydration on a user's machine is invalidated.
// The GitHub release that hosts site.tar.gz is tagged with this.
const SNAPSHOT_VERSION = 1;
const RELEASE_TAG = `playground-snapshot-v${SNAPSHOT_VERSION}`;
const DOWNLOAD_URL = `https://github.com/Algorismus-io/elementor-ultra-mcp/releases/download/${RELEASE_TAG}/site.tar.gz`;

const log = (m) => process.stdout.write(`\x1b[35m[make-snapshot]\x1b[0m ${m}\n`);
const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${c}`))));
  });

const reprovision = process.argv.includes('--reprovision');

// ── 1. provision (unless a fresh site is already present) ───────────────────────────────────────
if (reprovision || !existsSync(CREDS) || !existsSync(join(SITE, 'wp-config.php'))) {
  log('provisioning a fresh site via setup-playground.mjs …');
  rmSync(SITE, { recursive: true, force: true });
  rmSync(join(PG_DIR, '.out'), { recursive: true, force: true });
  // Boot the setup server, poll for credentials, then stop it. The server stays up otherwise.
  const child = spawn('node', ['setup-playground.mjs'], {
    cwd: PG_DIR,
    env: { ...process.env, ULTRA_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  const start = Date.now();
  while (!existsSync(CREDS)) {
    if (Date.now() - start > 600000) { try { process.kill(-child.pid); } catch {} throw new Error('provisioning timed out (10 min)'); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { process.kill(-child.pid); } catch {}
  await new Promise((r) => setTimeout(r, 1500)); // let the server release the port + flush SQLite
  log('provisioned.');
} else {
  log('reusing existing provisioned site (pass --reprovision to rebuild it).');
}

const creds = JSON.parse(readFileSync(CREDS, 'utf8'));

// ── 2. materialise the companion plugin inside the site dir ──────────────────────────────────────
const pluginDest = join(SITE, 'wp-content', 'plugins', 'elementor-ultra-mcp');
log('copying companion plugin into the snapshot …');
rmSync(pluginDest, { recursive: true, force: true });
cpSync(PLUGIN_SRC, pluginDest, {
  recursive: true,
  filter: (src) => !/\/(node_modules|vendor|\.git|tests?)(\/|$)/.test(src) && !/\.phpunit\.result\.cache$/.test(src),
});
if (!existsSync(join(pluginDest, 'elementor-ultra-mcp.php'))) {
  throw new Error('companion plugin main file missing after copy — check PLUGIN_SRC');
}

// ── 3. tar + gzip + checksum + manifest ──────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
rmSync(TARBALL, { force: true });
log('creating tarball (this bundles WordPress core + Elementor + plugin + SQLite DB) …');
// -C into the site dir and tar "." so the archive extracts as the site root, not a nested .wordpress/.
await run('tar', ['-czf', TARBALL, '-C', SITE, '.']);

const sha256 = await new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(TARBALL).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const bytes = readFileSync(TARBALL).length;

const manifest = {
  name: '@algorismus/elementor-ultra-playground snapshot',
  snapshot_version: SNAPSHOT_VERSION,
  built_from: 'dev/playground/setup-playground.mjs',
  wordpress: 'bundled (Playground latest at build time)',
  elementor: creds.elementor,
  php: '8.2',
  default_port: PORT,
  download_url: DOWNLOAD_URL,
  release_tag: RELEASE_TAG,
  tarball: { file: 'site.tar.gz', bytes, sha256 },
  // Throwaway LOCAL-DEV credentials, valid only for a site booted from this snapshot on this machine.
  // The plaintext matches the hash baked into the snapshot's SQLite DB (same WordPress version at
  // build and boot), so the runtime prints working creds with zero PHP on startup.
  credentials: { WP_USER: creds.WP_USER, WP_APP_PASSWORD: creds.WP_APP_PASSWORD },
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

// ── 4. sync the self-provision fallback assets into the package ──────────────────────────────────
// If the snapshot download ever fails (offline / GitHub down), the runtime provisions from scratch
// using these — so they must ship inside the npm tarball and stay in lock-step with the dev copies.
log('syncing fallback provision assets …');
mkdirSync(ASSETS, { recursive: true });
cpSync(join(PG_DIR, 'blueprint.json'), join(ASSETS, 'blueprint.json'));
cpSync(join(PG_DIR, 'provision.php'), join(ASSETS, 'provision.php'));
const assetPlugin = join(ASSETS, 'plugin');
rmSync(assetPlugin, { recursive: true, force: true });
cpSync(PLUGIN_SRC, assetPlugin, {
  recursive: true,
  filter: (src) => !/\/(node_modules|vendor|\.git|tests?)(\/|$)/.test(src) && !/\.phpunit\.result\.cache$/.test(src),
});

log(`done.`);
log(`  tarball : ${TARBALL} (${(bytes / 1048576).toFixed(1)} MB)`);
log(`  sha256  : ${sha256}`);
log(`  upload  : gh release create ${RELEASE_TAG} ${TARBALL} -R Algorismus-io/elementor-ultra-mcp`);
log(`  elementor ${creds.elementor}, user ${creds.WP_USER}, app-pw ${creds.WP_APP_PASSWORD}`);
