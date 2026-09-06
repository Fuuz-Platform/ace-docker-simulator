# ACE operations console

React + Vite behind nginx, running as `ace-ui` in the same compose stack it monitors.
**http://localhost:8080**

## Adding a service

One entry in the registry, one file in `src/tabs/`:

```js
// src/App.jsx
const TABS = [ …, { id: 'myservice', label: 'My Service', component: MyService } ];
```

The shell knows nothing about any particular service — no switch statements, no per-service state.
Each tab owns its polling and its own failure handling, so one dead container degrades one tab
instead of blanking the console.

If the service is new to the stack, add a proxy location in `docker/nginx.ui.conf`, mirroring the
existing three. Note the comment there about variables in `proxy_pass`.

## Why everything goes through /api/*

The browser only ever talks to one origin. nginx serves the bundle and reverse-proxies
`/api/sim`, `/api/orch`, `/api/hist` to the services; Vite's dev server proxies the *same paths* to
the same places. So there is no CORS anywhere, and no code differs between `npm run dev` and Docker.

## Charts

Hand-rolled SVG in `src/components/Chart.jsx`, not a charting library — the spec they follow (2px
strokes, crosshair on every line chart, legend at two or more series, direct labels, recessive grid,
a table view as relief for low-contrast marks) is easier to satisfy exactly than to coax out of a
library's theming layer.

Colours are the validated data-viz palette. The categorical slots were run through the palette
validator: dark passes all six checks; light passes but WARNs on contrast for aqua and yellow, which
is why every chart ships a table view. Dark is the default — a monitoring console is read in a dark
room more often than not.

Bad-quality samples are drawn as ringed red markers and **never filtered out**. A trend that
silently drops Bad points draws a clean line straight through a comms outage.

## Local development

```bash
cd ui && npm install && npm run dev     # :5173, proxies to localhost services
```

Override targets with `SIM_URL`, `ORCH_URL`, `HIST_URL` if the services are not on their defaults.

## Plant tab — the namespace browser

`Plant > Area > Asset > Tag`, read from the simulator's LIVE address space rather than a stored
model, so what you browse is what a gateway's browse walk would discover — node ids and all. Maps
onto the conventional manufacturing levels: site above (one plant here), then area, work unit, and
the signals hanging off it.

Creating an asset or tag writes into the **running** OPC UA server; a client that re-browses sees it
immediately. Additions persist across restarts in a `sim-data` volume — the built-in plant stays in
code, the file holds only what was added at runtime.

Two limits stated in the UI rather than left as a surprise:

- Collectors that subscribed to a fixed node list — the bridge, and the Fuuz DeviceSubscription with
  its 88 explicit node ids — only pick a new tag up after they re-subscribe.
- Nothing here writes to Fuuz. The tenant is populated by the ACE staging and matching scripts,
  which keep a MatchingRun and a decision-event trail this console deliberately does not bypass.

## Simulator control API

The console can change the plant because the simulator now exposes an HTTP control API beside its
OPC UA server (`:4841`, published for local dev):

| method | path | does |
|---|---|---|
| GET | `/state` | every unit, signal, value and quality, plus current tunables |
| GET | `/params` | tick interval, fault rate, noise, paused |
| POST | `/params` | change any of them — values are clamped, not rejected |
| POST | `/fault` | pin a unit to COMMS / STALE / FLATLINE / DRIFT, or release it |
| GET | `/tree` | the whole hierarchy with values, quality and node ids |
| POST | `/assets` | add an asset (gets the standard signal set) |
| POST | `/tags` | add a custom tag to an asset |

Unauthenticated and reachable only inside the compose network. It is a simulator; adding auth would
imply it is not.
