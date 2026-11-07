// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api, type Item } from "./api.ts";
import type { Entry } from "./entries.tsx";
import { upload } from "./portable.tsx";
type Asset = {
  sha256: string;
  originalName?: string;
  byteLength: number;
  mediaType: string;
};
export function AttachmentField({
  bookId,
  libraryId,
  value,
  busy = false,
  allowClear = true,
  onSave,
  onCancel,
}: {
  bookId?: string;
  libraryId?: string;
  value: unknown;
  busy?: boolean;
  allowClear?: boolean;
  onSave: (v: any) => void;
  onCancel: () => void;
}) {
  const [lib, setLib] = useState(libraryId ?? ""),
    [files, setFiles] = useState<Asset[]>([]),
    [choice, setChoice] = useState(typeof value === "string" ? value : ""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const id = libraryId ?? (await api(`/books/${bookId}`)).book.libraryId;
        const rows = await api(`/libraries/${id}/attachments`);
        if (alive) {
          setLib(id);
          setFiles(rows);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [libraryId, bookId]);
  return (
    <section>
      <h4>Choose attachment</h4>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy || loading}>
        <label>
          Upload attachment
          <input
            type="file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setLoading(true);
              setError("");
              try {
                const a = await upload(
                  `/libraries/${lib}/attachments?name=${encodeURIComponent(f.name)}&mediaType=${encodeURIComponent(f.type || "application/octet-stream")}`,
                  f,
                );
                setFiles(await api(`/libraries/${lib}/attachments`));
                setChoice(a.sha256);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setLoading(false);
              }
            }}
          />
        </label>
        <label>
          Attachment
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a file</option>
            {choice && !files.some((a) => a.sha256 === choice) && (
              <option value={choice}>Unavailable: {choice}</option>
            )}
            {files.map((a) => (
              <option key={a.sha256} value={a.sha256}>
                {a.originalName ?? a.sha256} ({a.byteLength} bytes)
              </option>
            ))}
          </select>
        </label>
        {choice && files.some((a) => a.sha256 === choice) && (
          <p>
            <a href={`/api/libraries/${lib}/attachments/${choice}`} download>
              Download selected attachment
            </a>
          </p>
        )}
        <button
          disabled={!choice || !files.some((a) => a.sha256 === choice)}
          onClick={() => onSave(choice)}
        >
          Save Attachment
        </button>
        {allowClear && (
          <button onClick={() => onSave(null)}>Clear Attachment</button>
        )}
        <button onClick={onCancel}>Cancel Attachment</button>
      </fieldset>
    </section>
  );
}
export function LibraryAttachments({
  library,
  book,
  onBookSaved,
}: {
  library: Item;
  book: Item | null;
  onBookSaved: (v: Item) => void;
}) {
  const [open, setOpen] = useState(true),
    [error, setError] = useState("");
  return (
    <section>
      <p>
        Files stay in this library when links are removed. Portable archives and
        recovery backups include their bytes.
      </p>
      {error && <p role="alert">{error}</p>}
      {open ? (
        <AttachmentField
          libraryId={library.id}
          value={book?.coverAttachment}
          allowClear={!!book}
          onCancel={() => setOpen(false)}
          onSave={async (sha) => {
            try {
              if (book)
                onBookSaved(
                  await api(`/books/${book.id}/cover`, "PUT", {
                    sha256: sha,
                    expectedUpdatedAt: book.updatedAt,
                  }),
                );
              setOpen(false);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      ) : (
        <button onClick={() => setOpen(true)}>Browse or Upload Files</button>
      )}
      {book && (
        <p>
          Save Attachment sets the cover for {book.title}. Clear Attachment
          removes its cover.
        </p>
      )}
    </section>
  );
}
export function EntryAttachments({
  bookId,
  entry,
  onSaved,
}: {
  bookId: string;
  entry: Entry;
  onSaved: (v: Entry) => void;
}) {
  const [open, setOpen] = useState(false),
    [ack, setAck] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(sha: string, remove = false) {
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api(`/books/${bookId}/entries/${entry.id}/attachments`, "PUT", {
          sha256: sha,
          remove,
          expectedUpdatedAt: entry.updatedAt,
          ...(entry.scope?.kind !== "book" ? { editSharedCanon: ack } : {}),
        }),
      );
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h4>Entry attachments</h4>
      {error && <p role="alert">{error}</p>}
      {entry.scope?.kind !== "book" && (
        <label>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          Change attachments on shared canon for all books
        </label>
      )}
      <ul>
        {(entry.attachments ?? []).map((h) => (
          <li key={h}>
            {h}
            <button
              disabled={busy || (entry.scope?.kind !== "book" && !ack)}
              onClick={() => void save(h, true)}
            >
              Remove Attachment Link
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <AttachmentField
          bookId={bookId}
          value={undefined}
          busy={busy || (entry.scope?.kind !== "book" && !ack)}
          allowClear={false}
          onCancel={() => setOpen(false)}
          onSave={(sha) => void save(sha)}
        />
      ) : (
        <button onClick={() => setOpen(true)}>
          Add or Download Attachment…
        </button>
      )}
    </section>
  );
}
