// SPDX-License-Identifier: AGPL-3.0-only
import React, { useState } from "react";
import { api } from "./api.ts";
import type { Item } from "./api.ts";
export function BookDetails({
  book,
  onSaved,
  onCancel,
}: {
  book: Item;
  onSaved: (book: Item) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(
          new FormData(event.currentTarget).entries(),
        );
        const input = {
          ...values,
          targetWordCount:
            values.targetWordCount === ""
              ? null
              : Number(values.targetWordCount),
        };
        setBusy(true);
        setError("");
        try {
          onSaved(await api(`/books/${book.id}/details`, "PUT", input));
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Book details could not be saved.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <label>
          Title
          <input
            name="title"
            required
            maxLength={500}
            defaultValue={book.title}
          />
        </label>
        <label>
          Subtitle
          <input
            name="subtitle"
            maxLength={20000}
            defaultValue={book.subtitle}
          />
        </label>
        <label>
          Author
          <input
            name="authorName"
            maxLength={20000}
            defaultValue={book.authorName}
          />
        </label>
        <label>
          Description
          <textarea
            name="description"
            maxLength={20000}
            defaultValue={book.description}
          />
        </label>
        <label>
          Language
          <input
            name="language"
            placeholder="en-US"
            defaultValue={book.language}
          />
        </label>
        <label>
          Word goal
          <input
            name="targetWordCount"
            type="number"
            min="1"
            max="9007199254740991"
            step="1"
            defaultValue={book.targetWordCount}
          />
        </label>
        <label>
          Target date
          <input name="targetDate" type="date" defaultValue={book.targetDate} />
        </label>
        <p>Leave a goal blank to remove it.</p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">{busy ? "Saving…" : "Save"}</button>
        </div>
      </fieldset>
    </form>
  );
}
