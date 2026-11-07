// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { api, type Item } from "./api.ts";
export async function upload(path: string, file: File) {
  const r = await fetch("/api" + path, {
    method: "POST",
    credentials: "same-origin",
    body: file,
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error?.message ?? "Upload failed.");
  return v;
}
export function PortableLibraries({
  library,
  onImported,
}: {
  library: Item | null;
  onImported: (v: Item) => Promise<void>;
}) {
  const [preview, setPreview] = useState<any>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [replace, setReplace] = useState(false),
    [title, setTitle] = useState(""),
    [receipt, setReceipt] = useState("");
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <p>
        A portable archive includes the whole library, manuscripts, Trash and
        attachment files. Import preserves record IDs. Upload limit: 256 MiB.
      </p>
      {library && (
        <p>
          <a href={`/api/libraries/${library.id}/archive`} download>
            Download {library.title} archive
          </a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {receipt && <p role="status">{receipt}</p>}
      {!preview ? (
        <label>
          Import portable archive
          <input
            type="file"
            accept=".rolltop,application/zip"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f)
                void run(async () => {
                  setPreview(await upload("/archive-imports", f));
                  setReplace(false);
                  setTitle("");
                });
            }}
          />
        </label>
      ) : (
        <>
          <h3>Import {preview.libraryTitle}</h3>
          <p>
            {preview.words} words · {preview.counts.books} books ·{" "}
            {preview.attachments} attachments
          </p>
          <ul>
            {Object.entries(preview.counts).map(([k, n]) => (
              <li key={k}>
                {k}: {String(n)}
              </li>
            ))}
          </ul>
          {!!preview.warnings.length && (
            <>
              <h4>Warnings</h4>
              <ul>
                {preview.warnings.map((w: any, i: number) => (
                  <li key={i}>{typeof w === "string" ? w : w.message}</li>
                ))}
              </ul>
            </>
          )}
          {preview.conflictingIds && (
            <p role="alert">
              Record IDs already belong to another library. This archive cannot
              be installed here.
            </p>
          )}
          {preview.targetExists && (
            <>
              <p>
                Existing library: {preview.targetTitle ?? preview.libraryTitle}.
                Replacement first saves a durable recovery backup and replaces
                the entire library, including its Trash.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={replace}
                  disabled={busy}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                Replace the existing library
              </label>
              <label>
                Type the archive library title to confirm
                <input
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            </>
          )}
          <button
            disabled={
              busy ||
              preview.conflictingIds ||
              (preview.targetExists &&
                (!replace || title !== preview.libraryTitle))
            }
            onClick={() =>
              void run(async () => {
                const v = await api(
                  `/archive-imports/${preview.id}/commit`,
                  "POST",
                  {
                    mode: replace ? "replace" : "new",
                    ...(replace
                      ? { confirmed: true, confirmTitle: title }
                      : {}),
                  },
                );
                setPreview(undefined);
                setReceipt(
                  v.backup
                    ? `Imported. Recovery backup: ${v.backup}`
                    : "Archive imported.",
                );
                await onImported(v.library);
              })
            }
          >
            Import Library
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/archive-imports/${preview.id}/cancel`, "POST", {});
                setPreview(undefined);
              })
            }
          >
            Cancel Import
          </button>
        </>
      )}
    </section>
  );
}
