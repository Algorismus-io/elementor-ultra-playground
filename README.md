# @algorismus/elementor-ultra-playground

One command → a local **WordPress + Elementor + the Elementor Ultra companion plugin**, ready for
[`elementor-jsx`](https://www.npmjs.com/package/@algorismus/elementor-jsx) (`exjsx deploy`) and the
[Elementor Ultra MCP server](https://www.npmjs.com/package/@algorismus/elementor-ultra-mcp).

No Docker. No PHP. No MySQL. No git clone. It runs on [WordPress
Playground](https://wordpress.github.io/wordpress-playground/) (PHP-WASM, pure Node) and boots from a
**pre-baked site snapshot**, so you skip the ~4 minutes a cold WordPress + Elementor install costs.

```bash
npx @algorismus/elementor-ultra-playground
```

That's it. First run downloads a ~50 MB snapshot once (cached under your home) and boots in seconds;
later runs boot in a few seconds. When it's up you get:

```
  WordPress   http://127.0.0.1:8899/wp-admin   (admin / password)
  Elementor   4.2.1 (free) + Elementor Ultra companion plugin

  For the MCP server and `exjsx deploy`:
      WP_URL=http://127.0.0.1:8899
      WP_USER=admin
      WP_APP_PASSWORD=…
```

Point `exjsx` or the MCP server at those three values and start authoring.

## Why it's fast

A cold local site downloads WordPress, installs Elementor from wordpress.org, activates the plugin,
flips on the V4 experiments, fixes permalinks, and mints an app password — minutes of work. This
package ships that finished state as a snapshot and hydrates it, so the only cost is a one-time
download and a few seconds of boot.

The app password is **baked into the snapshot** and printed on every boot. It is a throwaway
credential for a **local-only** dev site (`WP_ENVIRONMENT_TYPE=local`) — never reuse it anywhere real.

## Flags

| Flag | Meaning |
|------|---------|
| `--port <n>` | serve on a different port (default `8899`) |
| `--fresh` | wipe the cached site and re-hydrate from the snapshot |
| `--provision` | skip the snapshot; provision a fresh site from bundled assets (needs network for wordpress.org) |
| `--tarball <path>` | hydrate from a local snapshot tarball instead of downloading |
| `--dir <path>` | hydrate into a specific directory instead of the cache |

Environment: `ELEMENTOR_ULTRA_HOME` overrides the cache location; `ULTRA_PORT` sets the port.

## Reset

```bash
npx @algorismus/elementor-ultra-playground --fresh
```

## What's inside the snapshot

WordPress (Playground build) + Elementor 4.2.1 (free) + the Elementor Ultra companion plugin +
pretty permalinks + `WP_ENVIRONMENT_TYPE=local` baked into `wp-config.php` + the V4 atomic /
classes / variables experiments active + a minted local-dev application password.

## Part of Elementor Ultra

- **Framework** — [`@algorismus/elementor-jsx`](https://www.npmjs.com/package/@algorismus/elementor-jsx) — JSX → Elementor V4 compiler + `exjsx` CLI
- **MCP server** — [`@algorismus/elementor-ultra-mcp`](https://www.npmjs.com/package/@algorismus/elementor-ultra-mcp)
- **Installer** — [`@algorismus/create-elementor-ultra`](https://www.npmjs.com/package/@algorismus/create-elementor-ultra)
- **Hub / one-link setup** — https://github.com/Algorismus-io/elementor-ultra

## License

MIT © Algorismus
