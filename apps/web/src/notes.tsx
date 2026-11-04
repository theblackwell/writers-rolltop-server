// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
type Note = {
  id: string;
  text: string;
  nodeId?: string;
  updatedAt: string;
  deletedAt?: string;
};
export function QuickNotes({ book, nodes }: { book: Item; nodes: Item[] }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);
  const [text, setText] = useState("");
  const [pin, setPin] = useState("");
  const path = `/books/${book.id}/notes`;
  useEffect(() => {
    api<Note[]>(path)
      .then((n) => {
        setNotes(n);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [path]);
  async function save(input: object, note?: Note) {
    setBusy(true);
    setError("");
    try {
      const updated = await api<Note>(
        path + (note ? `/${note.id}` : ""),
        note ? "PUT" : "POST",
        { ...input, ...(note ? { expectedUpdatedAt: note.updatedAt } : {}) },
      );
      setNotes((items) =>
        note
          ? items.map((n) => (n.id === note.id ? updated : n))
          : [...items, updated],
      );
      setEditing(null);
      setText("");
      setPin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The note could not save.");
    } finally {
      setBusy(false);
    }
  }
  const pinName = (n: Note) =>
    n.nodeId
      ? (nodes.find((x) => x.id === n.nodeId)?.title ??
        "Missing manuscript item")
      : "Whole book";
  return (
    <section>
      <p>
        Plain-text notes for {book.title}. Notes stay pinned when a manuscript
        item moves to Trash.
      </p>
      {error && <p role="alert">{error}</p>}
      {!loaded && <p>Loading notes…</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({ text, nodeId: pin || null }, editing ?? undefined);
        }}
      >
        <fieldset disabled={busy || !loaded}>
          <label>
            {editing ? "Edit note" : "New note"}
            <textarea
              required
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label>
            Pin to
            <select value={pin} onChange={(e) => setPin(e.target.value)}>
              <option value="">Whole book</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                  {n.deletedAt ? " (in Trash)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">
            {busy ? "Saving…" : editing ? "Save Note" : "Add Note"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setText("");
                setPin("");
              }}
            >
              Cancel Edit
            </button>
          )}
        </fieldset>
      </form>
      <ul className="search-results">
        {notes
          .filter((n) => !n.deletedAt)
          .map((n) => (
            <li key={n.id}>
              <strong>{pinName(n)}</strong>
              <p style={{ whiteSpace: "pre-wrap" }}>{n.text}</p>
              <button
                disabled={busy || !!editing}
                onClick={() => {
                  setEditing(n);
                  setText(n.text);
                  setPin(n.nodeId ?? "");
                }}
              >
                Edit / Re-pin
              </button>
              <button
                disabled={busy || !!editing}
                onClick={() => void save({ deleted: true }, n)}
              >
                Move to Trash
              </button>
            </li>
          ))}
      </ul>
      {loaded && !notes.some((n) => !n.deletedAt) && <p>No notes yet.</p>}
      <details>
        <summary>Notes in Trash</summary>
        <ul className="search-results">
          {notes
            .filter((n) => n.deletedAt)
            .map((n) => (
              <li key={n.id}>
                <strong>{pinName(n)}</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{n.text}</p>
                <button
                  disabled={busy || !!editing}
                  onClick={() => void save({ deleted: false }, n)}
                >
                  Restore Note
                </button>
              </li>
            ))}
        </ul>
      </details>
    </section>
  );
}
