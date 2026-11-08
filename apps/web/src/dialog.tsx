// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useRef } from "react";
export function Dialog({
  title,
  children,
  close,
  sheet = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  // A sheet slides up from the bottom edge on phone-width windows, as on iPhone.
  sheet?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={sheet ? "sheet" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={close} aria-label="Close dialog">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
