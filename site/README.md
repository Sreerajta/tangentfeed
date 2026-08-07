# tangentfeed site

The landing page and documentation. Static output, hostable anywhere.

```bash
npm run build     # → dist/
npm run serve     # http://localhost:8080
```

`dist/` contains `index.html`, `docs.html`, `style.css`, and `hero.js`, which is
what you deploy. Fonts load from Google Fonts; nothing else is needed at runtime.

`dist/standalone/` holds single-file copies with the CSS and JavaScript inlined.
They open directly from disk with no server, which makes them easy to email or
drop into a slide deck. The live demo works there too, because the standalone
build ships a classic script rather than an ES module.

## Deploying

Any static host works. The site has no server-side component.

- **GitHub Pages** — build, then publish `site/dist`
- **Netlify / Vercel** — build command `npm run build -w site`, publish directory `site/dist`
- **Cloudflare Pages** — same as above
- **Your own server** — copy `dist/` behind nginx or Caddy

Serve over HTTPS so the clipboard buttons work.

## The hero demo

`src/hero.ts` runs two real `SyncEngine` replicas in the page, connected by a
loopback transport that the visitor can switch off. Nothing is mocked: cutting
the wire genuinely queues operations, and reconnecting genuinely merges them.
It is bundled from the workspace source, so it cannot drift from the library.
