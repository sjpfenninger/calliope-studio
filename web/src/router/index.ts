import { createRouter, createWebHistory } from "vue-router";

import { useConfirmStore } from "../stores/confirm";
import { useTabsStore } from "../stores/tabs";

/**
 * Two URL slots, deliberately orthogonal.
 *
 *   path  → which model version, and which sidebar section
 *   ?tab= → which of the open tabs is in front
 *
 * Tabs are a workspace: they have to survive switching section, so they cannot
 * be the routed thing. Only the *active* one is named in the URL, so a file or a
 * run is still deep-linkable, and `AppShell` writes it with `replace` so that
 * opening and closing tabs does not fill the back button.
 *
 * `AppShell` is a single route record for all three sections, which is what lets
 * the tab bar, Monaco's models and live run panes survive navigation between
 * them. That is the whole reason the sections are nested children rather than
 * sibling routes.
 */

declare module "vue-router" {
  interface RouteMeta {
    /** Which sidebar item is current. Present on shell routes only. */
    section?: "model" | "files" | "runs";
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: { name: "projects" } },

    {
      path: "/projects",
      name: "projects",
      component: () => import("../views/ProjectListView.vue"),
    },

    // A project id alone cannot address the shell; this resolves its version.
    {
      path: "/projects/:projectId",
      name: "project",
      component: () => import("../views/OpenProjectView.vue"),
    },

    {
      path: "/projects/:projectId/versions/:versionId",
      component: () => import("../components/shell/AppShell.vue"),
      children: [
        { path: "", redirect: { name: "model" } },
        {
          path: "model",
          name: "model",
          component: () => import("../components/sections/ModelSection.vue"),
          meta: { section: "model" },
        },
        {
          path: "files",
          name: "files",
          component: () => import("../components/sections/FilesSection.vue"),
          meta: { section: "files" },
        },
        {
          path: "runs",
          name: "runs",
          component: () => import("../components/sections/RunsSection.vue"),
          meta: { section: "runs" },
        },
      ],
    },

    // `calliope-studio results.nc` has no model definition to edit: the same shell,
    // with Model and Files unavailable and one run tab already open.
    {
      path: "/viewer",
      component: () => import("../components/shell/AppShell.vue"),
      children: [
        {
          path: "",
          name: "viewer",
          component: () => import("../components/sections/RunsSection.vue"),
          meta: { section: "runs" },
        },
      ],
    },

    // Entry points that have to resolve something before they can land: the CLI
    // sends the browser to /results, and these are what old bookmarks look like.
    {
      path: "/results/:runId?",
      name: "results",
      component: () => import("../views/OpenResultsView.vue"),
    },
    {
      path: "/runs/:runId",
      name: "run",
      component: () => import("../views/OpenResultsView.vue"),
    },

    { path: "/:pathMatch(.*)*", redirect: { name: "projects" } },
  ],
});

/**
 * Leaving the shell tears down Monaco's models, and unsaved edits go with them.
 * Moving *between* sections is not leaving, which is exactly what the shared
 * `AppShell` record expresses.
 */
router.beforeEach(async (to, from) => {
  if (!from.meta.section || to.meta.section) return true;
  const tabs = useTabsStore();
  if (!tabs.hasDirtyTabs) return true;
  // Awaiting a real dialog. This was the app's one `window.confirm` — an
  // OS-drawn surface that takes no token, no radius and no delay, in a codebase
  // that bans the native `title` attribute for precisely that reason, and
  // standing on the one path where misreading it costs a user's unsaved model.
  // `beforeEach` may return a promise, so the navigation simply waits.
  return useConfirmStore().ask({
    title: "Leave with unsaved changes?",
    message:
      "Edits you have not saved will be lost. Files already written to disk are untouched.",
    confirmLabel: "Leave",
    destructive: true,
  });
});
