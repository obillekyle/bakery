# Host mounts

A host mount gives a hostname one subtree of the app as its whole site:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  hostMounts: [{ host: 'kit.*', path: '/kit' }],
})
```

`kit.example.com/forms` is now the page `/kit/forms`, and `kit.example.com/`
is `/kit`. Every other host serves the app as before, `/kit/forms` included.

It is not a `hosts` entry with a `root`. That gives a hostname a directory of
its own as the serve root: its own pages, and also its own stylesheets,
scripts and API, all read from that directory ([Multi-host](multi-host.md)).
A host mount keeps one app. The subtree's pages load `/ui/Button.vue`,
`/style.css` and `/api/...` from the app's root, as they do on any host, and
only the pages move.

## Which hostnames

| `host` | Matches |
| --- | --- |
| `'kit.example.com'` | That name only |
| `'kit.*'` | The first label `kit` under any domain: `kit.localhost`, `kit.example.com`, `kit.bpc.edu.ph` |
| `'*.docs.example.com'` | Any subdomain of `docs.example.com`, at any depth |
| `hostname => boolean` | Whatever the function returns, asked per request with the hostname lowercased and without its port |

A `*` stands for one or more whole labels, so `kit.*` matches neither
`kits.example.com` nor `a.kit.example.com`, and a `*` inside a label (`k*t`)
is refused. Matching ignores case and the port. The hostname is the one
`hosts` matches on: the `Host` header, or with `trustProxy` the first
`X-Forwarded-Host` ([how the hostname is decided](multi-host.md#how-the-hostname-is-decided)).
The first entry whose `host` matches serves the request.

Patterns are for an app whose domain is not known at boot. A domain read from
a database setting cannot be written as `kit.<domain>`, and `kit.*` names the
`kit` label of whatever the domain turns out to be:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  hostMounts: [
    { host: 'kit.*', path: '/kit' },
    // A function decides anything a pattern cannot.
    { host: hostname => hostname.endsWith('.preview.example.com'), path: '/preview' },
  ],
})
```

A pattern is routing, not authorization: `kit.*` also matches
`kit.someone-else.example` pointed at the server. `onRequest` still runs
first on a mounted host and sees the request as it was sent, so an app
refuses there whatever names it does not serve.

## Which requests move

On a mounted host a request is resolved under the mount when it is a page
request for a path that can be a page. Every other request is served as on any
other host.

A page request is:

- a navigation: a browser loading the URL in a tab or a frame, which it marks
  `Sec-Fetch-Mode: navigate`. A client that sends no Fetch Metadata is
  navigating when its `Accept` names `text/html`;
- any method but GET and HEAD: a form post, or a Vue page's server action,
  which posts to the page's own URL.

A path can be a page unless:

- its last segment has an extension, which names a file: `/style.css`,
  `/files/handbook.pdf`;
- it is under `/_` (the framework's and the plugins' routes, the consoles at
  `/_dashboard` and `/_db` among them), `/api/` or `/.well-known/`;
- a plugin serves its prefix through `mountRoutes`, or it starts with a key
  of `proxy`.

| On `kit.example.com` | Served as |
| --- | --- |
| A navigation to `/` | `/kit` |
| A navigation to `/forms/date` | `/kit/forms/date` |
| A POST to `/forms?__vue_action=save` | `/kit/forms?__vue_action=save` |
| An import of `/kit/useDemo` | `/kit/useDemo` |
| `<link rel="stylesheet" href="/style.css">` | `/style.css` |
| A navigation to `/files/handbook.pdf` | `/files/handbook.pdf` |
| `fetch('/api/kit/search')` | `/api/kit/search` |
| A navigation to `/_dashboard` | `/_dashboard` |

The line is drawn at the request kind because a path cannot tell a page from
a module. `import { demo } from './useDemo'` in `src/kit/Demo.vue` reaches the
browser as `/kit/useDemo`, with no extension, and moved into the subtree it
would be `/kit/kit/useDemo`. A module import, a stylesheet, an image and a
`fetch` are never navigations, so whatever a page loads by its root path
reaches the same file from the mounted host as from any other.

A missing page is looked up from the path the request was resolved as, so on
the mounted host the subtree's own `error-404` page is found before the app's.

Since one URL can answer differently by request kind there, every response for
a path that can be a page carries `Vary: Sec-Fetch-Mode, Accept`, and a cache
does not hand a page to a module import of the same URL.

## Writing pages for a mounted host

On the mounted host, links between the subtree's pages leave the mount out:
`/forms` is the forms page there, and `/kit/forms` is read as
`/kit/kit/forms`. Everything else a page names keeps its root path. A relative
URL resolves against the address the browser shows, which has no `/kit` on
that host, so a page names its own files by their root paths: `/kit/logo.svg`,
not `logo.svg`.

A `defineLayout()` page gets this for free. Its `nav.base` is `''` on the
mounted host and `/kit` on any other, so links built from `nav.base`, and
`nav.navigate()`, are right on both ([Vue plugin](../plugins/vue.md#on-a-host-mount)).

## Limits

- `hostMounts` is process-wide. It cannot be set inside a `hosts` entry. A
  hostname can have both, and then its `hosts` entry decides the config, the
  root the mount's path is read under included.
- A mount's path cannot be `/` or sit under `/_`, `/api/` or `/.well-known/`.
  An entry that cannot mean anything stops the boot and names itself:
  `hostMounts[0].path must be a path starting with '/': got "kit"`.
- A catch-all above the mount (`src/[...slug].vue`) still answers a path the
  subtree has no page for, and on the mounted host its `defineLayout()` base
  has no spelling without the mount. A subtree served this way wants a
  catch-all of its own.
- `curl` sends `Accept: */*` and no Fetch Metadata, so it is not a page
  request and gets the app's root. `curl -H 'Accept: text/html'` asks the way a
  browser does.
