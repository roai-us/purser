import type { ReactNode } from "react";

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return (
    <p className="note note-error" role="alert">
      {message}
    </p>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return <p className="note note-info">{children}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="loading" role="status">
      {label}…
    </p>
  );
}
