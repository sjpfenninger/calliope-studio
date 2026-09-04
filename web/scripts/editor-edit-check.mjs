/**
 * The structured editors, actually edited.
 *
 *   pixi run calliope-studio --no-browser --port 8791 example-model
 *   pnpm run editor-edit-check http://127.0.0.1:8791
 *
 * `save-check` opens every section and presses Save without touching anything,
 * which is the property that protects a user's file — and is also why the two
 * worst bugs in these editors survived it for months. Both need an edit, and
 * both are invisible to vue-tsc, to a unit test and to a no-op save:
 *
 * - **Typing a name remounted the row being typed in.** The accordion rows were
 *   keyed on `entry.name`, which is the one field the form lets you change, so
 *   every keystroke gave the row a new key: Vue unmounted it, focus went to the
 *   document, and the row collapsed. Naming a technology `solar_x` was seven
 *   clicks. On the map's detail pane the same lookup-by-name meant the form
 *   simply vanished on the first keystroke, taking the half-typed name with it.
 * - **Cmd+S dropped the value in the focused field.** Almost every field here
 *   commits on `change`, which a keystroke never fires, so the save wrote the
 *   value from *before* the one on screen and then marked the tab clean over
 *   it. The box still showed the new number; the file did not have it.
 *
 * Both failures look like the app working. Nothing throws, nothing is logged,
 * and the screen shows what the user typed — which is why the assertions here
 * are about focus, `data-state` and the bytes on disk rather than about
 * anything a screenshot would settle.
 *
 * The latitude half deliberately presses Cmd+S **without blurring first**: a
 * click anywhere else commits the field and makes the check pass on the broken
 * code. `reload-from-disk` is not used to confirm the value stuck, despite
 * being the obvious button, because `EditorToolbar` only renders it on a 409;
 * the file read is the stronger evidence anyway.
 *
 * A node has no DOM element — MapLibre draws to a canvas — so its position
 * comes from `window.__cgMap.project()`, the seam `ModelMap` exposes for this.
 * Everything else selects on `data-testid`.
 *
 * Both files it writes are put back on the way out, so `save-check`, which
 * asserts a faithful round trip on the same two, still sees what it expects.
 */
import { parse } from "yaml";

import {
  api,
  baseFrom,
  MOD,
  openWorkspace,
  results,
  until,
} from "./harness.mjs";

const BASE = baseFrom(process.argv);

const TECHS_FILE = "model_config/techs.yaml";
const NODES_FILE = "model_config/locations.yaml";

/** The technology this check invents, one keystroke at a time, and then deletes. */
const NEW_TECH = "solar_x";
/** Whose latitude is edited: the node the example model puts first. */
const NODE = "region1";
const NEW_LATITUDE = "51.5";

const { check, guard } = results("editor-edit");

const { browser, page, testId, consoleErrors, calls, enter, openEntry, files, mapReady, ws } =
  await openWorkspace(BASE);

const restore = await files.guard(TECHS_FILE, NODES_FILE);

/** The active tab's unsaved-changes dot. */
const dirtyDots = () =>
  page.locator('[data-testid^="tab-"][data-active] [data-testid="tab-dirty"]').count();

/** Whichever element has focus, named the way the app names it. */
const focused = () =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

/** One entry row, by the name it is currently showing. */
const row = (name) => page.locator(`[data-testid="entry-row"][data-name="${name}"]`);

/** Saves, and waits for the write rather than for a guessed second. */
const save = () => calls.settle(() => testId("save").click(), { timeout: 30000 });

/** Where a longitude/latitude pair currently sits on screen. */
async function screenPoint(lngLat) {
  const box = await page.locator(".maplibregl-canvas").first().boundingBox();
  const point = await page.evaluate(
    (pair) => {
      const projected = window.__cgMap.project(pair);
      return { x: projected.x, y: projected.y };
    },
    [lngLat[0], lngLat[1]],
  );
  return { x: box.x + point.x, y: box.y + point.y };
}

/** Where each node is, according to the server, right now. */
async function nodeCoordinates() {
  const geo = await (await api(`${BASE}/api/versions/${ws}/geo/`)).json();
  return Object.fromEntries(
    geo.nodes.features.map((feature) => [
      String(feature.id),
      feature.geometry.coordinates,
    ]),
  );
}

await guard(browser, consoleErrors, async () => {
  try {
    console.log(`Editing in the structured editors at ${BASE}`);
    await enter();

    // -----------------------------------------------------------------------
    // Techs: add an entry, name it a character at a time, save it, delete it.
    // -----------------------------------------------------------------------

    const techsBefore = await files.read(TECHS_FILE);
    const techKeysBefore = Object.keys(parse(techsBefore).techs).join(",");

    await openEntry("techs");
    await testId("techs-editor").waitFor({ timeout: 20000 });

    const rowsBefore = await testId("entry-row").count();
    await testId("add-tech").click();
    await until(async () => (await testId("entry-row").count()) === rowsBefore + 1);

    const added = testId("entry-row").nth(rowsBefore);
    check(
      "a new technology arrives expanded",
      (await added.getAttribute("data-state")) === "open",
      await added.getAttribute("data-state"),
    );
    // Focus arrives a frame after the row does: Reka's collapsible content is
    // `hidden` while it measures itself, and a hidden input refuses focus.
    check(
      "with the cursor in its name field",
      await until(async () => (await focused()) === "entry-name", { timeout: 2000 }),
    );

    // One key at a time, which is the gesture the remount bug was invisible to:
    // `fill()` sets the value in one go and would pass on the broken code.
    let lostFocus = 0;
    for (const character of NEW_TECH) {
      await page.keyboard.press(character);
      if ((await focused()) !== "entry-name") lostFocus += 1;
    }

    check(
      "typing a name never takes the focus out of the field",
      lostFocus === 0,
      `${lostFocus} of ${NEW_TECH.length} keystrokes lost it`,
    );
    check(
      "and the whole name arrives",
      (await row(NEW_TECH).locator('[data-testid="entry-name"]').inputValue()) === NEW_TECH,
    );
    check(
      "and the row is still open",
      (await row(NEW_TECH).getAttribute("data-state")) === "open",
      await row(NEW_TECH).getAttribute("data-state"),
    );
    check("with exactly one row bearing that name", (await row(NEW_TECH).count()) === 1);

    // Source and back. The raw buffer reads the *file*, so it cannot show the
    // unsaved name; what it shows instead is that the form holds it, and the
    // form is still there, edit and all, when Form is pressed again — which is
    // the property the tab store claims for a dirty pane behind `v-show`.
    // Two switches exist while the source is up — the hidden form's toolbar
    // keeps its own, since a dirty pane is `v-show`n — so the visible one.
    const mode = (name) => page.locator(`[data-testid="mode-${name}"]:visible`).first();
    await mode("source").click();
    await testId("locked-banner").waitFor({ timeout: 20000 });
    check(
      "the Source view of a dirty form is held read-only by that form",
      (await testId("locked-banner").innerText()).includes("unsaved changes"),
    );
    // Monaco builds its view only once a model is attached, and the model is
    // the section fetched fresh — so the lines follow the banner, not precede it.
    check(
      "and the source itself is on screen",
      await until(async () => (await page.locator(".view-lines").count()) > 0),
    );
    await mode("form").click();
    await row(NEW_TECH).waitFor({ timeout: 20000 });
    check(
      "flipping back to Form finds the edit where it was left",
      (await row(NEW_TECH).locator('[data-testid="entry-name"]').inputValue()) === NEW_TECH,
    );
    check("with the tab still unsaved", (await dirtyDots()) === 1);

    // `base_tech` is the app's own Select, not a native one, so it is opened
    // and an option is picked rather than `selectOption`ed.
    await row(NEW_TECH).locator('[data-testid="entry-base-tech"]').click();
    await page.getByRole("option", { name: "supply", exact: true }).click();
    await save();

    const techsAdded = parse(await files.read(TECHS_FILE)).techs;
    check(
      "the new technology reaches the file",
      techsAdded[NEW_TECH]?.base_tech === "supply",
      JSON.stringify(techsAdded[NEW_TECH]),
    );
    check("and the tab is clean again", (await dirtyDots()) === 0);

    // An entry owns its parameters, so taking one out asks first.
    await row(NEW_TECH).locator('[data-testid="entry-remove"]').click();
    await testId("confirm-dialog").waitFor({ timeout: 8000 });
    check(
      "removing a technology asks first, naming the act",
      (await testId("confirm-accept").innerText()).trim() === "Remove",
    );
    await testId("confirm-accept").click();
    await until(async () => (await row(NEW_TECH).count()) === 0);
    await save();

    const techsRemoved = parse(await files.read(TECHS_FILE)).techs;
    check("removing it takes it out of the file", techsRemoved[NEW_TECH] === undefined);
    check(
      "and leaves every other technology exactly where it was",
      Object.keys(techsRemoved).join(",") === techKeysBefore,
      Object.keys(techsRemoved).join(","),
    );

    // -----------------------------------------------------------------------
    // Nodes: Cmd+S from inside the field, then a rename that must not unmount.
    // -----------------------------------------------------------------------

    await openEntry("nodes");
    await testId("editor-map").waitFor({ timeout: 20000 });
    await mapReady();
    await calls.idle();

    const coordinates = await nodeCoordinates();
    const point = await screenPoint(coordinates[NODE]);
    await page.mouse.click(point.x, point.y);
    await testId("node-latitude").waitFor({ timeout: 20000 });
    check(
      "clicking a node opens its form",
      (await testId("node-name").inputValue()) === NODE,
    );

    await testId("node-latitude").click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type(NEW_LATITUDE);
    check(
      "the latitude field still has focus when Cmd+S is pressed",
      (await focused()) === "node-latitude",
    );
    // No blur, no click elsewhere: committing the field by hand first is what
    // made this pass on the code that dropped it.
    await calls.settle(() => page.keyboard.press(`${MOD}+s`), { timeout: 30000 });

    const savedNode = parse(await files.read(NODES_FILE)).nodes[NODE];
    check(
      "Cmd+S writes the value the focused field is showing",
      savedNode.latitude === Number(NEW_LATITUDE),
      String(savedNode.latitude),
    );
    check("and the tab goes clean", (await dirtyDots()) === 0);
    check(
      "and the field still reads what was typed",
      (await testId("node-latitude").inputValue()) === NEW_LATITUDE,
    );

    // Renaming the node the map has selected. Two characters, because the bug
    // struck on the first: the lookup by name failed and the pane fell through
    // to its placeholder, so the second keystroke had nowhere to land.
    await testId("node-name").click();
    await page.keyboard.press("End");
    await page.keyboard.press("_");
    await page.keyboard.press("b");

    check(
      "renaming from the map keeps the form on screen",
      (await testId("node-name").count()) === 1,
    );
    check(
      "and holds both typed characters",
      (await testId("node-name").inputValue()) === `${NODE}_b`,
      await testId("node-name").inputValue(),
    );
    check("and never loses focus", (await focused()) === "node-name");
    check(
      "and does not revert the latitude beside it",
      (await testId("node-latitude").inputValue()) === NEW_LATITUDE,
    );
    check(
      "and the detail pane is not showing its placeholder",
      !(await testId("map-detail").innerText()).includes("Click a node"),
    );

    // The rename is deliberately never saved: it would break the model for
    // every check after this one, and what it pins is the form, not the write.
  } finally {
    // Whatever happened above, both files go back as they were found: the
    // checks after this one assert against the model they expect, and
    // `save-check` asserts a faithful round trip on these very two.
    await restore();
  }
});
