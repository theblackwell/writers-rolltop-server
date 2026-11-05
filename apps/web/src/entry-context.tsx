// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Entry } from "./entries.tsx";
import { familyRelations } from "../../../packages/studio/src/family-values.ts";
type Match = { entry: Entry; related: boolean; labels: string[] };
type Appearance = {
  referenceId: string;
  nodeId: string;
  sceneTitle: string;
  bookTitle: string;
  anchorId: string;
  passageMissing: boolean;
  excerpt: string;
};
export function EntryContext({
  entry,
  bookId,
  onClose,
  onOpen,
}: {
  entry: Entry;
  bookId: string;
  onClose: () => void;
  onOpen?: (nodeId: string, anchorId: string) => Promise<void>;
}) {
  const [matches, setMatches] = useState<Match[]>([]),
    [appearances, setAppearances] = useState<Appearance[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [bookSpecific, setBookSpecific] = useState(true);
  const family = async () => {
    const result =
      entry.entryType === "character" && !entry.deletedAt
        ? await api(`/books/${bookId}/entries/${entry.id}/family`)
        : { matches: [] };
    setMatches(result.matches);
  };
  useEffect(() => {
    let live = true;
    Promise.all([
      entry.entryType === "character" && !entry.deletedAt
        ? api(`/books/${bookId}/entries/${entry.id}/family`)
        : Promise.resolve({ matches: [] }),
      api(`/books/${bookId}/entries/${entry.id}/appearances`),
    ])
      .then(([f, a]) => {
        if (live) {
          setMatches(f.matches);
          setAppearances(a.appearances);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, entry.id]);
  async function action(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not complete this action.",
      );
    } finally {
      setBusy(false);
    }
  }
  const sectionTitle =
    entry.entryType === "character" ? "Family and Appearances" : "Appearances";
  return (
    <section aria-label={`${sectionTitle} for ${entry.name}`}>
      <h3>
        {entry.name}: {sectionTitle}
      </h3>
      {error && <p role="alert">{error}</p>}
      {!loaded ? (
        <p>Loading…</p>
      ) : (
        <>
          {entry.entryType === "character" && (
            <>
              <h4>Same Family Name</h4>
              {entry.deletedAt ? (
                <p>
                  Restore this character before recording family relationships.
                </p>
              ) : !matches.length ? (
                <p>
                  No other live characters in this book share this family name.
                </p>
              ) : (
                <>
                  <p>
                    Choose how these characters are related, including Not
                    related. A saved relationship answers the prompt.
                  </p>
                  <label>
                    Save family answers for
                    <select
                      value={bookSpecific ? "book" : "shared"}
                      disabled={busy}
                      onChange={(e) =>
                        setBookSpecific(e.target.value === "book")
                      }
                    >
                      <option value="book">This book only</option>
                      <option value="shared">
                        All books that can see both characters
                      </option>
                    </select>
                  </label>
                  <ul className="search-results">
                    {matches.map((match) => (
                      <li key={match.entry.id}>
                        <strong>{match.entry.name}</strong>
                        {match.related ? (
                          <p>Recorded: {match.labels.join(", ")}</p>
                        ) : (
                          <FamilyAnswer
                            entry={entry}
                            match={match}
                            busy={busy}
                            onSave={(relation) =>
                              action(async () => {
                                await api(
                                  `/books/${bookId}/entries/${entry.id}/family`,
                                  "POST",
                                  {
                                    relation,
                                    otherEntryId: match.entry.id,
                                    expectedUpdatedAt: entry.updatedAt,
                                    expectedOtherUpdatedAt:
                                      match.entry.updatedAt,
                                    bookSpecific,
                                    editSharedCanon: !bookSpecific,
                                  },
                                );
                                await family();
                              })
                            }
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <h4>Appears In</h4>
          <p>Linked passages in the open book.</p>
          {!appearances.length && (
            <p>
              No live linked passages yet. Mark a passage in the manuscript and
              link it to this entry using References.
            </p>
          )}
          <ul className="search-results">
            {appearances.map((a) => (
              <li key={a.referenceId}>
                <strong>{a.sceneTitle}</strong>
                <p>
                  {a.bookTitle}
                  {a.passageMissing
                    ? " · Passage no longer present"
                    : " · Linked passage"}
                </p>
                {a.excerpt && <p>{a.excerpt}</p>}
                <button
                  disabled={busy || !onOpen}
                  onClick={() =>
                    void action(async () => {
                      await onOpen?.(a.nodeId, a.anchorId);
                    })
                  }
                >
                  {a.passageMissing
                    ? "Open Scene (passage missing)"
                    : "Show Linked Passage"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button disabled={busy} onClick={onClose}>
        Close Family and Appearances
      </button>
    </section>
  );
}
function FamilyAnswer({
  entry,
  match,
  busy,
  onSave,
}: {
  entry: Entry;
  match: Match;
  busy: boolean;
  onSave: (relation: string) => Promise<void>;
}) {
  const [relation, setRelation] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(relation);
      }}
    >
      <fieldset disabled={busy}>
        <label>
          How does {entry.name} relate to {match.entry.name}?
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {Object.entries(familyRelations).map(([key, value]) => (
              <option key={key} value={key}>
                {value.title}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!relation}>Save Family Answer</button>
      </fieldset>
    </form>
  );
}
