# Shiga Ride

A phone web app for a Shiga Kogen snowboard trip (17–20 Jan 2027).

- **Map**: your GPS position on OpenStreetMap, runs coloured by difficulty (green / red / black as on Japanese trail maps), terrain park and off-piste styled separately, filter chips, and a legend.
- **Routing**: pick a lift, food spot or ski area and get the quickest way there using runs you've left switched on. Lifts you mark as on hold are skipped.
- **Lift waits**: estimates based on lift type, time of day and weekday vs weekend. Shiga Kogen doesn't publish queue times. Tap a lift to report the real queue, which overrides the estimate for 45 minutes on your phone.
- **Runs**: import a day's GPX export from Slopes to get runs, top speed, vertical, and time riding vs on lifts vs queuing. This data stays on the phone.
- **Eat**: cafés and restaurants from OpenStreetMap, nearest first.
- **Snow**: Open-Meteo forecast for the summit and Ichinose: overnight snow, wind-hold risk, and a 14-day outlook with the trip days highlighted.

## How it's built

A static site with no build step: plain ES modules plus [Leaflet](https://leafletjs.com/) in `vendor/`.

- `scripts/fetch-osm.mjs` pulls runs, lifts and food spots from the Overpass API into `data/shiga.json`.
- `.github/workflows/deploy.yml` runs that script, then publishes to GitHub Pages on every push to `main`, weekly, and on demand (Actions → Build and deploy → Run workflow).
- If `data/shiga.json` is missing, the app fetches the same data live from Overpass and caches it.
- `sw.js` caches the app and the map tiles you've viewed, so the app keeps working with patchy signal on the mountain.

## Data and credits

Map data © OpenStreetMap contributors (ODbL). Weather from Open-Meteo (CC BY 4.0). Run difficulty and coverage depend on what's mapped in OpenStreetMap; runs with no mapped difficulty appear dashed.
