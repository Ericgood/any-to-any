# anytoany.dev

Static site for https://anytoany.dev — plain HTML and CSS, no JavaScript, no build step. Served by Cloudflare Workers static assets.

```
site/
├── wrangler.jsonc        # Worker name, assets folder, custom domain
└── public/               # everything that gets served
    ├── index.html        # home
    ├── claude-code-cross-session-messaging.html
    ├── 404.html, robots.txt, sitemap.xml, llms.txt, _headers
    └── style.css, favicon.svg, demo.gif, og.png
```

## Preview locally

```bash
cd site
npx wrangler dev --local --port 8799
```

## Deploy

```bash
cd site
npx wrangler deploy
```

The first deploy attaches the custom domain `anytoany.dev` (the zone must be in the same Cloudflare account) and creates its DNS record.

## Editing rules

- Facts come from the README and the latest ADRs in `docs/decisions.md`. When delivery behavior, supported agents or the security model change, update this site in the same change.
- Keep the FAQ text in the visible HTML and in the `FAQPage` JSON-LD identical.
- Bump `lastmod` in `sitemap.xml` and the "updated" dates when a page changes.
- Spec: [docs/specs/website.md](../docs/specs/website.md).
