import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    {
      path: "/projects",
      component: () => import("../views/ProjectListView.vue"),
    },
    {
      path: "/projects/:id",
      component: () => import("../views/ProjectView.vue"),
    },
    {
      path: "/projects/:id/versions/:versionId",
      component: () => import("../views/EditorView.vue"),
    },
    {
      path: "/runs/:id",
      component: () => import("../views/RunView.vue"),
    },
    // Without a run id, shows whatever the server was opened on — which is how
    // `calligraph results.nc` lands straight on the charts.
    {
      path: "/results",
      component: () => import("../views/ResultsView.vue"),
    },
    {
      path: "/results/:runId",
      component: () => import("../views/ResultsView.vue"),
    },
  ],
});

export { router };
