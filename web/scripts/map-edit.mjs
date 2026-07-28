/**
 * The map, as an editing surface.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   npm run map-edit -- http://127.0.0.1:8791
 *
 * The first thing it asserts is the one that was broken: that the canvas has a
 * non-zero size at all. The nodes map rendered at 0px high for as long as it
 * existed — `height: 100%` inside a block parent whose own height was its
 * content's — and nothing noticed, because a zero-height map throws nothing,
 * logs nothing, and looks exactly like a map with nothing on it.
 *
 * After that: drag a node and watch the coordinates reach the file, click a link
 * and watch its form appear, and draw a new link with two clicks.
 *
 * A node has no DOM element — MapLibre draws to a canvas — so `data-testid`
 * cannot reach one. Positions come from `window.__cgMap.project()`, the seam
 * `ModelMap` exposes for exactly this. Everything else selects on `data-testid`.
 *
 * The file it edits is put back as it was on the way out, so the checks that run
 * after this one see the model they expect.
 */
import { parse } from "yaml";

import { api, health, open, requireMode, results } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8000";

const NODES_FILE = "model_config/locations.yaml";

/** Which node to drag, and which two to link. Far apart, so clicks cannot mix. */
const DRAGGED = "region1";
const LINK_FROM = "region2";
const LINK_TO = "region1_2";

/** Whose latitude is taken away, to see the map grey itself out. */
const UNPLACED = "region1_3";

const { check, finish } = results();

const payload = requireMode(await health(BASE), "workspace", BASE);
const ws = payload.workspace_id;

const readFile = async (path) =>
  (await (await api(`${BASE}/api/versions/${ws}/files/${path}`)).json()).content;

const writeFile = (path, content) =>
  api(`${BASE}/api/versions/${ws}/files/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

const comments = (text) =>
  text
    .split("\n")
    .map((line) => line.split("#")[1]?.trim())
    .filter(Boolean);

/**
 * Where each node is, according to the server, right now.
 *
 * Re-read per section rather than once: the nodes half of this check drags a node
 * and saves it, so coordinates captured at the start would point at where the
 * model *used* to be — and a click 50px off a 14px-wide link line hits nothing.
 */
async function nodeCoordinates() {
  const geo = await (await api(`${BASE}/api/versions/${ws}/geo/`)).json();
  return Object.fromEntries(
    geo.nodes.features.map((feature) => [
      String(feature.id),
      feature.geometry.coordinates,
    ]),
  );
}

let coordinates = await nodeCoordinates();

const { browser, page, testId, consoleErrors } = await open();

/** Where a longitude/latitude pair currently sits on screen. */
async function screenPoint(lngLat) {
  const canvas = page.locator(".maplibregl-canvas").first();
  const box = await canvas.boundingBox();
  const point = await page.evaluate(
    (pair) => {
      const map = window.__cgMap;
      const projected = map.project(pair);
      return { x: projected.x, y: projected.y };
    },
    [lngLat[0], lngLat[1]],
  );
  return { x: box.x + point.x, y: box.y + point.y };
}

/**
 * Waits until the server's own answer about the geography has settled.
 *
 * `/geo/` reports `source: resolved | stale | structural` and keeps serving the
 * last answer that made sense while a rebuild runs in a subprocess, so for a
 * while after a file is edited the map is still showing — and greying itself out
 * over — the *previous* model. There is no sleep that is both long enough on a
 * cold cache and short enough to be worth having, so this asks.
 */
async function waitForResolvedGeo(timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const geo = await (await api(`${BASE}/api/versions/${ws}/geo/`)).json();
    if (geo.source === "resolved" && !geo.resolve_error) return geo;
    await page.waitForTimeout(500);
  }
  throw new Error("the model never resolved");
}

async function openSection(name) {
  await page
    .getByRole("treeitem", { name: new RegExp(`^${name}$`, "i") })
    .first()
    .click();
  await testId("editor-map").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2000);
}

const before = await readFile(NODES_FILE);

try {
  console.log(`Editing on the map at ${BASE}`);
  await page.goto(`${BASE}${payload.landing}`, { waitUntil: "networkidle" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---------------------------------------------------------------------------
  // Nodes: the map is there, has a size, and a node can be dragged.
  // ---------------------------------------------------------------------------

  await openSection("nodes");

  const canvasBox = await page.locator(".maplibregl-canvas").first().boundingBox();
  check(
    "the nodes map is the default view",
    (await testId("editor-map").count()) === 1,
  );
  // The regression this check exists for.
  check(
    "the map canvas has a real size",
    canvasBox && canvasBox.width > 200 && canvasBox.height > 100,
    canvasBox ? `${Math.round(canvasBox.width)}×${Math.round(canvasBox.height)}` : "no canvas",
  );
  check(
    "a fully placed model is not greyed out",
    (await testId("map-overlay").count()) === 0,
  );

  const start = await screenPoint(coordinates[DRAGGED]);
  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y - 30, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);

  const latitude = Number(await testId("node-latitude").inputValue());
  const longitude = Number(await testId("node-longitude").inputValue());

  check(
    "dragging a node opens its form below the map",
    (await testId("node-name").inputValue()) === DRAGGED,
  );
  check(
    "dragging moves it north and east",
    latitude > coordinates[DRAGGED][1] && longitude > coordinates[DRAGGED][0],
    `${coordinates[DRAGGED][1]},${coordinates[DRAGGED][0]} → ${latitude},${longitude}`,
  );
  check(
    "the coordinates stay readable",
    String(latitude).split(".")[1]?.length <= 5 &&
      String(longitude).split(".")[1]?.length <= 5,
    `${latitude}, ${longitude}`,
  );
  check(
    "the drag marks the tab dirty",
    (await page.locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]').count()) === 1,
  );

  // The links are rebuilt from the same positions rather than kept in step by
  // hand, so a node's lines follow it. Read off the map's own source, since a
  // line on a canvas is not something a selector can reach.
  const endpoints = await page.evaluate((tech) => {
    const { data } = window.__cgMap.getSource("links").serialize();
    const feature = data.features.find((candidate) => candidate.id === tech);
    return feature ? feature.geometry.coordinates : null;
  }, "region1_to_region2");
  check(
    "the links attached to it followed",
    endpoints &&
      endpoints.some(([lng, lat]) => lng === longitude && lat === latitude),
    JSON.stringify(endpoints),
  );

  await testId("save").click();
  await page.waitForTimeout(2000);

  const after = await readFile(NODES_FILE);
  const saved = parse(after).nodes[DRAGGED];

  check("the new position reaches the file", saved.latitude === latitude, String(saved.latitude));
  check("so does the new longitude", saved.longitude === longitude, String(saved.longitude));
  const lost = comments(before).filter((comment) => !comments(after).includes(comment));
  check("every comment in the file survives", lost.length === 0, lost.slice(0, 3).join(" | "));
  check(
    "the line count is unchanged",
    before.split("\n").length === after.split("\n").length,
    `${before.split("\n").length} → ${after.split("\n").length}`,
  );
  check(
    "nothing else in the section changed",
    Object.keys(parse(after).nodes).join(",") === Object.keys(parse(before).nodes).join(","),
  );
  check(
    "the drag is over, so the map pans again",
    (await testId("editor-map").count()) === 1,
  );

  // ---------------------------------------------------------------------------
  // A node without coordinates greys the map out, and offers the way through.
  // ---------------------------------------------------------------------------

  /**
   * Edits the nodes section, reopens the model, and waits for the settled answer.
   *
   * `expect` is the testid the overlay should end up showing. Waited for rather
   * than slept on: the resolve runs in a subprocess, `/geo/` serves the previous
   * answer while it reruns, and how long Calliope takes to read a model is not a
   * number this script can know. A fixed four seconds was right often enough to
   * look reliable and wrong often enough to fail on a cold cache.
   */
  async function reopenNodes(mutate, expect) {
    const url = `${BASE}/api/versions/${ws}/yaml-section/${NODES_FILE}?section=nodes`;
    const section = (await (await api(url)).json()).data;
    mutate(section);
    await api(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: section }),
    });
    // Reloaded rather than re-clicked: the sections are cached client-side, and
    // the point is what a user opening this model would see.
    await page.reload({ waitUntil: "networkidle" });
    await testId("model-tree").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await openSection("nodes");
    await testId(expect).waitFor({ timeout: 30000 });
  }

  // A node with no coordinates at all: a valid model, and the state the greyed-out
  // map exists for.
  await reopenNodes((section) => {
    delete section[UNPLACED].latitude;
    delete section[UNPLACED].longitude;
  }, "map-missing-coords");

  check(
    "one node without coordinates greys the whole map out",
    (await testId("map-missing-coords").count()) === 1,
    await testId("map-overlay").textContent(),
  );
  check(
    "and names the node that is missing them",
    (await testId("map-overlay").textContent())?.includes(UNPLACED),
    await testId("map-overlay").textContent(),
  );

  await testId("map-show-list").click();
  await page.waitForTimeout(750);
  check("the overlay's button reaches the list", (await testId("editor-map").count()) === 0);

  // Half a coordinate pair is something Calliope rejects outright, and the map says
  // so in its own words rather than guessing. Worth pinning: the alternative is a
  // map that silently shows the last thing that worked.
  await writeFile(NODES_FILE, before);
  await reopenNodes((section) => {
    delete section[UNPLACED].latitude;
  }, "map-error");

  check(
    "an invalid coordinate pair surfaces Calliope's own complaint",
    (await testId("map-error").count()) === 1 &&
      (await testId("map-overlay").textContent())?.includes("latitude"),
    await testId("map-overlay").textContent(),
  );
  check(
    "and still offers the way to the list",
    (await testId("map-show-list").count()) === 1,
  );

  await writeFile(NODES_FILE, before);

  // Before the reload, not after: the map is greyed out for as long as the model
  // is unresolved, and the scrim deliberately does not set `pointer-events:
  // none` — so every link click below would land on it and do nothing at all.
  await waitForResolvedGeo();

  await page.reload({ waitUntil: "networkidle" });
  await testId("model-tree").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---------------------------------------------------------------------------
  // Links: click a line to edit it, click two nodes to draw one.
  // ---------------------------------------------------------------------------

  await openSection("links");
  coordinates = await nodeCoordinates();

  check(
    "the links map is the default view too",
    (await testId("editor-map").count()) === 1,
  );

  // Halfway along `region1_to_region2`, which is the one link in this model with
  // its own colour and parameters.
  const [fromLng, fromLat] = coordinates[LINK_FROM];
  const [toLng, toLat] = coordinates["region1"];
  const middle = await screenPoint([(fromLng + toLng) / 2, (fromLat + toLat) / 2]);
  await page.mouse.click(middle.x, middle.y);
  await page.waitForTimeout(600);

  check(
    "clicking a line opens that link's form",
    (await testId("link-name").inputValue()) === "region1_to_region2",
    await testId("link-name").inputValue(),
  );
  check(
    "with its endpoints",
    (await testId("link-from").inputValue()) === "region1" &&
      (await testId("link-to").inputValue()) === "region2",
  );

  // Two clicks draw a link, from the template the picker names.
  await testId("new-link-template").selectOption("free_transmission");
  await page.waitForTimeout(200);

  const first = await screenPoint(coordinates[LINK_FROM]);
  await page.mouse.click(first.x, first.y);
  await page.waitForTimeout(500);
  check("the first click starts a link", (await testId("pending-link").count()) === 1);

  const second = await screenPoint(coordinates[LINK_TO]);
  await page.mouse.click(second.x, second.y);
  await page.waitForTimeout(600);

  check("the second click finishes it", (await testId("pending-link").count()) === 0);
  check(
    "the new link is named after its endpoints",
    (await testId("link-name").inputValue()) === `${LINK_FROM}_to_${LINK_TO}`,
    await testId("link-name").inputValue(),
  );
  check(
    "it uses the chosen template",
    (await testId("link-template").inputValue()) === "free_transmission",
  );
  check(
    "and its endpoints are the two nodes clicked",
    (await testId("link-from").inputValue()) === LINK_FROM &&
      (await testId("link-to").inputValue()) === LINK_TO,
  );
  check(
    "drawing a link marks the tab dirty",
    (await page.locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]').count()) === 1,
  );

  // The new link is deliberately never saved: the point was the flow, not another
  // round of the marshalling `save-check` already covers.
} finally {
  // Whatever happened above, the model goes back as it was found: the checks
  // that run after this one expect it, and so does the next attempt at this
  // one — a half-finished run used to leave a node where it dragged it.
  await writeFile(NODES_FILE, before);
}

check("no console errors throughout", consoleErrors.length === 0);

await finish(browser, consoleErrors);
