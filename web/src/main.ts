import "./monacoSetup";
import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { router } from "./router";
import { migrateLegacyStorageKeys } from "./lib/storageKeys";
import "./style.css";

// Before any store is instantiated, so that each one reads its own key rather
// than the one the previous project name wrote.
migrateLegacyStorageKeys();

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount("#app");
