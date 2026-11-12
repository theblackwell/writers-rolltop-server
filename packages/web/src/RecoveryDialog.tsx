import { useEffect, useId, useRef, useState } from "react";
import type { RecoveryChoice, SyncClient } from "./sync/client.ts";
import type { RecoveryItem } from "./sync/local.ts";
import { plainText } from "./sync/model.ts";

const CHOICE_TEXT: Record<RecoveryChoice, { label: string; help: string }> = {
  mine: { label: "Keep this device's text", help: "Saves this device's text over the saved text." },
  saved: { label: "Keep the saved text", help: "Uses the saved text. This device's text is removed from this device." },
  both: { label: "Keep both", help: "First puts the saved text in a new scene next to this one, then saves this device's text over this scene. If the new scene cannot be made, this scene is left as it is." },
  copy: { label: "Save this text as a new scene", help: "The scene is no longer in the library. This text becomes a new scene." },
};

/** Shown when a scene's text was saved somewhere else, or could not be saved. A modal dialog: focus moves in and stays in. */
export function RecoveryDialog({ client, item, others, onClose }: { client: SyncClient; item: RecoveryItem; others: readonly RecoveryItem[]; onClose: (resolved: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState<RecoveryChoice | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    titleRef.current?.focus();
    return () => { if (d.open) d.close(); };
  }, []);

  const saved = client.savedTextFor(item);
  const choices = client.choicesFor(item);
  const heading = item.source === "conflict"
    ? `Another copy of "${item.sceneTitle}" was saved on another device`
    : item.source === "unsent" ? `Text you typed in "${item.sceneTitle}" was not saved`
    : `This text of "${item.sceneTitle}" could not be saved`;
  const explain = item.source === "conflict"
    ? "Both copies are kept. Look at them side by side and choose what to do."
    : (item.reason ?? "The server could not save this text.") + " Your text is kept on this device until you choose.";

  async function choose(choice: RecoveryChoice) {
    setBusy(choice);
    setMessage(undefined);
    const out = await client.resolveItem(item, choice);
    setBusy(undefined);
    if (out.ok) onClose(true); else setMessage(out.message);
  }

  return (
    <dialog ref={ref} className="recovery" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(false); }}>
      <h2 id={titleId} ref={titleRef} tabIndex={-1} className="recovery__title">{heading}</h2>
      <p>{explain}</p>
      <div className="recovery__versions">
        <div>
          <h3>This device's text</h3>
          <div className="recovery__text" role="region" aria-label="This device's text" tabIndex={0}>{plainText(item.mine) || "(empty)"}</div>
        </div>
        <div>
          <h3>Saved text</h3>
          <div className="recovery__text" role="region" aria-label="Saved text" tabIndex={0}>
            {saved ? plainText(saved) || "(empty)" : "The scene is no longer in the library."}
          </div>
        </div>
      </div>
      {others.length > 0 && (
        <div className="recovery__others">
          <h3>Also kept on this device for this scene</h3>
          <p className="hint">These are shown one after another. Decide about the pair above first.</p>
          {others.map((o, i) => (
            <div key={o.conflictId}>
              <p>{o.reason ?? "A text that was not saved."}</p>
              <div className="recovery__text" role="region" aria-label={`Other text kept on this device ${i + 1}`} tabIndex={0}>{plainText(o.mine) || "(empty)"}</div>
            </div>
          ))}
        </div>
      )}
      {message && <p role="alert" className="error">{message}</p>}
      <ul className="recovery__choices">
        {choices.map((c) => (
          <li key={c}>
            <button type="button" className="btn btn--primary" disabled={busy !== undefined} aria-describedby={`${titleId}-${c}`} onClick={() => void choose(c)}>
              {busy === c ? "Working…" : CHOICE_TEXT[c].label}
            </button>
            <span id={`${titleId}-${c}`} className="hint">{CHOICE_TEXT[c].help}</span>
          </li>
        ))}
        <li>
          <button type="button" className="btn btn--wood" disabled={busy !== undefined} aria-describedby={`${titleId}-later`} onClick={() => onClose(false)}>Decide later</button>
          <span id={`${titleId}-later`} className="hint">Both texts stay on this device. The scene cannot be edited until you decide.</span>
        </li>
      </ul>
    </dialog>
  );
}
