import { useState } from "react";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label = "Copy",
  what,
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied?: () => void;
  /** What is being copied, for screen readers. */
  what?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const shown =
    state === "copied"
      ? "Copied"
      : state === "failed"
        ? "Select and copy"
        : label;
  return (
    <button
      type="button"
      className="button button-soft"
      aria-label={what ? `${shown} ${what}` : undefined}
      onClick={async () => {
        const copied = await copyText(text);
        setState(copied ? "copied" : "failed");
        if (copied) onCopied?.();
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {shown}
    </button>
  );
}
