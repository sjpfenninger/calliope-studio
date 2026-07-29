<script setup lang="ts">
/**
 * The one dialog the whole app can ask for, rendered above the router view.
 *
 * Above it rather than inside it because the only caller so far is the
 * navigation guard, which fires while the shell is being left — a dialog inside
 * that tree would unmount as it opened.
 *
 * The geometry follows the delete-run confirmation exactly: `sm:max-w-96`,
 * Cancel then the action, and the destructive variant on the action rather than
 * a differently-shaped button.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DANGER_BUTTON_MD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "@/lib/formClasses";
import { useConfirmStore } from "@/stores/confirm";

const confirm = useConfirmStore();
</script>

<template>
  <Dialog
    :open="confirm.request !== null"
    @update:open="(open) => !open && confirm.answer(false)"
  >
    <DialogContent v-if="confirm.request" class="sm:max-w-96" data-testid="confirm-dialog">
      <DialogHeader>
        <DialogTitle>{{ confirm.request.title }}</DialogTitle>
        <DialogDescription>{{ confirm.request.message }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <button
          type="button"
          data-testid="confirm-cancel"
          :class="SECONDARY_BUTTON_MD"
          @click="confirm.answer(false)"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="confirm-accept"
          :class="confirm.request.destructive ? DANGER_BUTTON_MD : PRIMARY_BUTTON_MD"
          @click="confirm.answer(true)"
        >
          {{ confirm.request.confirmLabel }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
