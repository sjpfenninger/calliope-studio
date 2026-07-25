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
  ],
});

export { router };
