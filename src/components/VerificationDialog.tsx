import { useStore } from "@nanostores/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import {
  $verificationDialog,
  closeVerificationDialog,
} from "../stores/verificationStore";
import { Button } from "./ui/button";

export default function VerificationDialog() {
  const dialog = useStore($verificationDialog);

  if (!dialog) return null;

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => !open && closeVerificationDialog()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle
            className={dialog.type === "error" ? "text-[var(--danger)]" : ""}
          >
            {dialog.title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words mt-2">
            {dialog.message}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end mt-4">
          <Button
            variant="default"
            onClick={closeVerificationDialog}
            type="button"
          >
            OK
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
