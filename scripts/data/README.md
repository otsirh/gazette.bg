# Geo data (build-time)

Derived, committed data used only by `build-issue-pages.js` to render the
`/map` choropleth. Not fetched at build time — baked in so the build has no
network dependency.

- **`bg-settlements.json`** — `settlement name → province code` (or a list of
  codes when the name exists in several provinces, towns first). Built from the
  official **ЕКАТТЕ** classifier of settlements (via the public
  [`ABPAM/ekatte`](https://github.com/ABPAM/ekatte) mirror). Build-time only;
  never shipped to the browser.
- **`bg-provinces.json`** — the 28 provinces as projected, simplified SVG paths
  (`{ w, h, provinces: [{ code, name, d, cx, cy }] }`), keyed by NUTS3 code.
  Projected (equirectangular with a cos-latitude correction) and simplified
  (Ramer–Douglas–Peucker) from province polygons in
  [`dimitara/bulgaria-interactive-map`](https://github.com/dimitara/bulgaria-interactive-map).
  These paths are embedded in the `/map` page.

To regenerate (e.g. after an ЕКАТТЕ update), re-run the one-off generator that
produced these from the two upstream datasets.
