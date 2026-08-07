#!/usr/bin/env node
/**
 * @algorismus/elementor-ultra-playground
 *
 * One command → a local WordPress with Elementor + the Elementor Ultra companion plugin, ready for
 * `exjsx deploy` and the MCP server. No Docker, no PHP, no git clone. Runs on WordPress Playground
 * (PHP-WASM in Node).
 *
 *   npx @algorismus/elementor-ultra-playground
 *
 * Fast path: hydrate a pre-baked site snapshot (WordPress + Elementor + plugin already installed),
 * cached under the user's home after the first download — so boot skips the ~4 min cold provision.
 * Fallback: if the snapshot can't be fetched, provision from scratch using bundled assets.
 *
 * Flags:
 *   --port <n>       port to serve on (default: snapshot's baked port, 8899)
 *   --dir <path>     site directory to hydrate into (default: a per-version cache dir)
 *   --fresh          wipe the site dir and re-hydrate from the snapshot
 *   --provision      skip the snapshot; provision a fresh site from bundled assets
 *   --tarball <path> hydrate from a local snapshot tarball instead of downloading
 *   --quiet          less chatter
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const MANIFEST = JSON.parse(readFileSync(join(PKG, 'snapshot', 'manifest.json'), 'utf8'));
const ASSETS = join(PKG, 'assets');

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(val('--port', process.env.ULTRA_PORT || MANIFEST.default_port || 8899));
const FRESH = has('--fresh');
const FORCE_PROVISION = has('--provision');
const LOCAL_TARBALL = val('--tarball', null);
const QUIET = has('--quiet');

const HOME = process.env.ELEMENTOR_ULTRA_HOME ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'elementor-ultra-playground');
const SITE = resolve(val('--dir', join(HOME, `v${MANIFEST.snapshot_version}`, 'site')));
const OUT = join(dirname(SITE), 'out');

const WIN = process.platform === 'win32';
const c = { cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const log = (m) => process.stdout.write(`${c.cyan}[ultra]${c.reset} ${m}\n`);
const warn = (m) => process.stdout.write(`${c.red}[ultra]${c.reset} ${m}\n`);

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: WIN, ...opts });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

function findCli() {
  // The dep's `exports` map only exposes "." and "./package.json" — so resolving "@wp-playground/
  // cli/cli.js" directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the (allowed) package.json
  // instead to learn the package dir, which works in both a nested install and npx's hoisted layout
  // (…/_npx/<hash>/node_modules/@wp-playground/cli, a SIBLING of our package). Then pick the entry.
  const req = createRequire(import.meta.url);
  const candidates = [];
  try {
    const pkgDir = dirname(req.resolve('@wp-playground/cli/package.json'));
    candidates.push(join(pkgDir, 'cli.js')); // low-level server entry we drive
    const bin = req('@wp-playground/cli/package.json').bin;
    const binPath = typeof bin === 'string' ? bin : bin && Object.values(bin)[0];
    if (binPath) candidates.push(join(pkgDir, binPath));
  } catch {}
  candidates.push(
    join(PKG, 'node_modules', '@wp-playground', 'cli', 'cli.js'),
    join(PKG, '..', '..', '@wp-playground', 'cli', 'cli.js'),
  );
  for (const p of candidates) if (p && existsSync(p)) return p;
  throw new Error('could not locate @wp-playground/cli — reinstall the package');
}

async function sha256File(path) {
  const h = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  return new Promise((res, rej) =>
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej));
}

// ── hydrate the site dir ───────────────────────────────────────────────────────────────────────
async function downloadTarball(dest) {
  const url = MANIFEST.download_url;
  log(`downloading site snapshot (${(MANIFEST.tarball.bytes / 1048576).toFixed(0)} MB, one time) …`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`snapshot download failed: HTTP ${resp.status} for ${url}`);
  await new Promise((res, rej) => {
    const f = createWriteStream(dest);
    Readable.fromWeb(resp.body).pipe(f).on('finish', res).on('error', rej);
  });
  const got = await sha256File(dest);
  if (got !== MANIFEST.tarball.sha256) throw new Error(`snapshot checksum mismatch (got ${got})`);
}

async function hydrateFromSnapshot() {
  mkdirSync(SITE, { recursive: true });
  const tarball = LOCAL_TARBALL ? resolve(LOCAL_TARBALL) : join(dirname(SITE), 'site.tar.gz');
  if (LOCAL_TARBALL) {
    if (!existsSync(tarball)) throw new Error(`--tarball not found: ${tarball}`);
    log(`hydrating from local tarball ${tarball}`);
  } else if (!existsSync(tarball) || statSync(tarball).size !== MANIFEST.tarball.bytes) {
    await downloadTarball(tarball);
  } else {
    log('using cached snapshot download.');
  }
  log('extracting snapshot …');
  await run('tar', ['-xzf', tarball, '-C', SITE]);
  if (!existsSync(join(SITE, 'wp-config.php'))) throw new Error('snapshot extract incomplete — no wp-config.php');
}

// ── self-provision fallback (bundled assets; needs network for wordpress.org) ────────────────────
function provisionArgs(cli) {
  mkdirSync(SITE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  return [
    cli, 'server', '--port', String(PORT), '--php', MANIFEST.php || '8.2',
    '--site-url', `http://127.0.0.1:${PORT}`,
    '--mount-dir-before-install', SITE, '/wordpress',
    '--mount-dir-before-install', join(ASSETS, 'plugin'), '/wordpress/wp-content/plugins/elementor-ultra-mcp',
    '--mount-dir-before-install', ASSETS, '/ultra',
    '--mount-dir-before-install', OUT, '/ultra-out',
    '--blueprint', join(ASSETS, 'blueprint.json'),
  ];
}

// ── boot ──────────────────────────────────────────────────────────────────────────────────────
const cli = findCli();
const provisioned = existsSync(join(SITE, 'wp-config.php'));

if (FRESH) { log('--fresh: wiping site dir …'); rmSync(SITE, { recursive: true, force: true }); rmSync(OUT, { recursive: true, force: true }); }

let mode = 'snapshot';
let bootArgs;

if (!provisioned || FRESH) {
  if (FORCE_PROVISION) {
    mode = 'provision';
  } else {
    try {
      await hydrateFromSnapshot();
    } catch (e) {
      warn(`snapshot path failed (${e.message}); provisioning from scratch instead.`);
      rmSync(SITE, { recursive: true, force: true });
      mode = 'provision';
    }
  }
} else {
  log('existing site found — booting it (pass --fresh to reset).');
}

if (mode === 'provision') {
  log('provisioning a fresh site (downloads WordPress + Elementor; ~a few minutes) …');
  bootArgs = provisionArgs(cli);
} else {
  bootArgs = [
    cli, 'server', '--port', String(PORT), '--php', MANIFEST.php || '8.2',
    '--site-url', `http://127.0.0.1:${PORT}`,
    // BEFORE-install mount + "-if-needed" mode: Playground injects its SQLite driver during the
    // pre-install/boot phase and does NOT persist it into the site dir. Mounting after that phase
    // (plain --mount-dir) fails with "Error connecting to the SQLite database"; mounting before it,
    // with the if-needed mode, lets Playground re-inject the driver over the existing files + DB.
    '--mount-dir-before-install', SITE, '/wordpress',
    '--wordpress-install-mode', 'install-from-existing-files-if-needed',
  ];
}

log(`starting WordPress on http://127.0.0.1:${PORT} …`);

// ── supervised child ──────────────────────────────────────────────────────────────────────────
// Playground's request handler can die on an unhandled PHP-WASM fs error (observed: a request for a
// CSS path that doesn't resolve takes the whole server down mid-session). The site dir is a live
// mount, so state survives — respawn instead of leaving the user with a dead port. Opt out with
// --no-supervise. Restarts are capped per rolling window so a boot-loop still fails loudly.
const SUPERVISE = !has('--no-supervise');
let child = null;
let shuttingDown = false;
let restarts = [];
let everReady = false;

function startChild() {
  // --unhandled-rejections=warn: Playground's request handler can throw an unhandled ErrnoError on
  // requests for unresolvable static paths (observed: a CSS URL with a trailing slash) — by default
  // node kills the whole server for it. Warn-mode keeps the process alive (the request errors, the
  // server keeps serving); the supervisor below remains as the backstop for genuine crashes.
  child = spawn('node', ['--unhandled-rejections=warn', ...bootArgs], { stdio: ['ignore', QUIET ? 'ignore' : 'ignore', 'inherit'] });
  child.on('error', (e) => { warn(`failed to start Playground: ${e.message}`); process.exit(1); });
  child.on('close', (code) => {
    if (shuttingDown) return;
    if (!SUPERVISE) { warn(`Playground exited (${code}).`); process.exit(code ?? 1); }
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 120000);
    if (restarts.length >= 5) {
      warn(`Playground crashed ${restarts.length} times in 2 minutes — giving up. Last exit: ${code}.`);
      process.exit(code ?? 1);
    }
    restarts.push(now);
    warn(`Playground crashed (exit ${code}) — restarting in 2s … ${c.dim}(site state persists; known PHP-WASM css-request bug)${c.reset}`);
    setTimeout(() => { if (!shuttingDown) { startChild(); watchRecovery(); } }, 2000);
  });
}

function watchRecovery() {
  if (!everReady) return; // initial readiness printer below handles the first boot
  const t0 = Date.now();
  const t = setInterval(async () => {
    if (await ready()) { clearInterval(t); log(`recovered — site is serving again on http://127.0.0.1:${PORT}.`); }
    else if (Date.now() - t0 > 60000) { clearInterval(t); warn('site did not recover within 60s after a crash-restart.'); }
  }, 1500);
}

startChild();

// readiness: for the provision path, wait for the credentials file the blueprint writes; for the
// snapshot path, poll the REST root (WordPress is up as soon as it answers there).
const CREDS = join(OUT, 'credentials.json');
const started = Date.now();
const budget = mode === 'provision' ? 600000 : 120000;

async function ready() {
  if (mode === 'provision') return existsSync(CREDS);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/wp-json/`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

const timer = setInterval(async () => {
  if (await ready()) {
    clearInterval(timer);
    everReady = true;
    const creds = mode === 'provision'
      ? JSON.parse(readFileSync(CREDS, 'utf8'))
      : { WP_USER: MANIFEST.credentials.WP_USER, WP_APP_PASSWORD: MANIFEST.credentials.WP_APP_PASSWORD, elementor: MANIFEST.elementor };
    const url = `http://127.0.0.1:${PORT}`;
    process.stdout.write(`
  ${c.green}✓${c.reset} Elementor Ultra local site is up ${c.dim}(Docker-free, WordPress Playground)${c.reset}

  WordPress   ${url}/wp-admin   ${c.dim}(admin / password)${c.reset}
  Elementor   ${creds.elementor} (free) + Elementor Ultra companion plugin

  For the MCP server and \`exjsx deploy\`:
      WP_URL=${url}
      WP_USER=${creds.WP_USER}
      WP_APP_PASSWORD=${creds.WP_APP_PASSWORD}

  Verify   curl -u ${creds.WP_USER}:${creds.WP_APP_PASSWORD} ${url}/wp-json/elementor-ultra/v1/site/capabilities
  Stop     Ctrl-C            Reset   npx @algorismus/elementor-ultra-playground --fresh

  ${c.dim}Server running — leave this up while you work.${c.reset}\n`);
  } else if (Date.now() - started > budget) {
    clearInterval(timer);
    warn(`site did not come up within ${Math.round(budget / 1000)}s — check the output above.`);
    warn(`if the port is busy, retry with --port <n>.`);
  }
}, 1500);

process.on('SIGINT', () => { shuttingDown = true; try { child?.kill(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { shuttingDown = true; try { child?.kill(); } catch {} process.exit(0); });
