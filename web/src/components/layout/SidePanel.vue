<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import Badge from "primevue/badge";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import { useValidationStore } from "../../stores/validation";
import { useRunStore } from "../../stores/run";
import { useTabsStore } from "../../stores/tabs";
import { useVersionStore } from "../../stores/version";

const validationStore = useValidationStore();
const runStore = useRunStore();
const tabsStore = useTabsStore();
const versionStore = useVersionStore();

const errorCount = computed(() => validationStore.errors.length);

function validate() {
  const vid = versionStore.currentVersionId;
  if (vid) validationStore.validate(vid);
}

function validateDeep() {
  const vid = versionStore.currentVersionId;
  if (vid) validationStore.validateDeep(vid);
}

function startRun() {
  const vid = versionStore.currentVersionId;
  if (vid) runStore.startRun(vid);
}

function openErrorFile(file: string, line: number | null) {
  // `jumpTo` opens the file itself, so there is nothing to do first. The file
  // type no longer needs working out here either — the store infers it.
  if (line != null) tabsStore.jumpTo(file, line, 1);
  else tabsStore.openFile(file);
}

const statusColor = computed(() => {
  switch (runStore.activeRun?.status) {
    case "pending": return "#f59e0b";
    case "running": return "#3b82f6";
    case "success": return "#22c55e";
    case "failed": return "#ef4444";
    default: return "transparent";
  }
});

// Auto-scroll log pane when new lines arrive
const logViewRef = ref<HTMLPreElement | null>(null);
watch(
  () => runStore.logs.length,
  async () => {
    await nextTick();
    if (logViewRef.value) {
      logViewRef.value.scrollTop = logViewRef.value.scrollHeight;
    }
  }
);

const logText = computed(() => runStore.logs.join("\n"));
</script>

<template>
  <div class="side-panel">
    <Tabs value="validation" class="side-tabs">
      <TabList>
        <Tab value="validation">
          Validation
          <Badge v-if="errorCount > 0" :value="String(errorCount)" severity="danger" class="err-badge" />
        </Tab>
        <Tab value="run">Run</Tab>
      </TabList>
      <TabPanels>
        <!-- ── Validation tab ── -->
        <TabPanel value="validation" class="tab-content">
          <div class="panel-actions">
            <Button
              label="Validate"
              icon="pi pi-check-circle"
              size="small"
              :loading="validationStore.isValidating"
              @click="validate"
            />
            <Button
              label="Deep Validate"
              icon="pi pi-verified"
              size="small"
              severity="secondary"
              :loading="validationStore.isDeepValidating"
              @click="validateDeep"
            />
          </div>
          <div v-if="validationStore.errors.length === 0 && !validationStore.isValidating && !validationStore.isDeepValidating" class="empty-state">
            No errors found.
          </div>
          <DataTable
            v-else
            :value="validationStore.errors"
            size="small"
            scrollable
            scrollHeight="flex"
            class="error-table"
          >
            <Column field="file" header="File" class="col-file">
              <template #body="{ data }">
                <span class="error-file" @click="openErrorFile(data.file, data.line)" :title="data.file">
                  {{ data.file.split("/").pop() }}
                </span>
              </template>
            </Column>
            <Column field="line" header="Line" style="width: 4rem" />
            <Column field="message" header="Message" class="col-message" />
          </DataTable>
        </TabPanel>

        <!-- ── Run tab ── -->
        <TabPanel value="run" class="tab-content">
          <div class="panel-actions run-actions">
            <Button
              label="Run"
              icon="pi pi-play"
              size="small"
              :disabled="runStore.activeRun?.status === 'running'"
              @click="startRun"
            />
            <span v-if="runStore.activeRun" class="run-status" :style="{ color: statusColor }">
              ● {{ runStore.activeRun.status }}
            </span>
          </div>
          <pre ref="logViewRef" class="log-view">{{ logText }}</pre>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.side-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--p-content-border-color, #e0e0e0);
}

.side-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

:deep(.p-tabpanels) {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

:deep(.p-tabpanel) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.tab-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.err-badge {
  margin-left: 0.4rem;
  font-size: 0.65rem;
}

.panel-actions {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color, #e0e0e0);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.run-actions {
  gap: 0.75rem;
}

.run-status {
  font-size: 0.8rem;
  font-weight: 500;
}

.empty-state {
  padding: 1rem;
  font-size: 0.875rem;
  color: var(--p-text-muted-color, #888);
  text-align: center;
}

.error-table {
  flex: 1;
  overflow: auto;
  font-size: 0.8rem;
}

.error-file {
  cursor: pointer;
  text-decoration: underline dotted;
  color: var(--p-primary-color, #6366f1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  max-width: 120px;
}

:deep(.col-message) {
  font-family: monospace;
  font-size: 0.75rem;
  word-break: break-word;
}

.log-view {
  flex: 1;
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  font-family: "Cascadia Code", "Fira Code", "Menlo", monospace;
  overflow: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
