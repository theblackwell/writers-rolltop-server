// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
type Saved = {
  id: string;
  version: string;
  format: string;
  createdAt: string;
  filename: string;
  size: number;
};
type Catalog = { book: Item; nextVersion: string; exports: Saved[] };
export function BibleExports({
  bookId,
  onSaved,
}: {
  bookId: string;
  onSaved: (book: Item) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog>(),
    [version, setVersion] = useState(""),
    [format, setFormat] = useState("docx"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let live = true;
    setBusy(true);
    api<Catalog>("/books/" + bookId + "/bible-exports")
      .then((c) => {
        if (live) {
          setCatalog(c);
          setVersion(c.nextVersion);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [bookId]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setCatalog(await api("/books/" + bookId + "/bible-exports"));
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!catalog) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ export: Saved; book: Item }>(
        "/books/" + bookId + "/bible-exports",
        "POST",
        {
          id: requestId,
          version,
          format,
          expectedUpdatedAt: catalog.book.updatedAt,
        },
      );
      setCatalog({
        ...catalog,
        book: result.book,
        exports: [
          result.export,
          ...catalog.exports.filter((x) => x.id !== result.export.id),
        ],
      });
      onSaved(result.book);
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Export Story Bible">
      <p>
        Export saved story records as Word or PDF. Each version is kept with
        this book and included in recovery backups.
      </p>
      <p>
        Premise, structure, characters, world, glossary, timeline, research,
        names, questions, continuity notes and chapter summaries. Shared fields
        use this book’s overrides.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Preparing bible…</p>}
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy || !catalog}>
          <label>
            Version
            <input
              required
              maxLength={32}
              value={version}
              onChange={(e) => {
                setVersion(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <label>
            Format
            <select
              value={format}
              onChange={(e) => {
                setFormat(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            >
              <option value="docx">Word (.docx)</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
          <button>Save Export</button>
        </fieldset>
      </form>
      <button disabled={busy} onClick={() => void refresh()}>
        Check Saved Versions
      </button>
      <h3>Saved Versions</h3>
      {catalog && !catalog.exports.length && <p>No bible exports saved yet.</p>}
      <ul className="search-results">
        {catalog?.exports.map((x) => (
          <li key={x.id}>
            <strong>
              Version {x.version} · {x.format.toUpperCase()}
            </strong>
            <p>
              {new Date(x.createdAt).toLocaleString()} ·{" "}
              {x.size.toLocaleString()} bytes
            </p>
            <a
              href={"/api/books/" + bookId + "/bible-exports/" + x.id}
              download={x.filename}
            >
              Download {x.format === "docx" ? "Word" : "PDF"} version{" "}
              {x.version}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
