// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from "react";
import type { Item } from "./api.ts";
import { children, liveNodes, itemLabel } from "./manuscript.ts";
export type ManagementAction =
  "rename" | "move" | "trash" | "restore" | "up" | "down";
export type Target = {
  item: Item;
  type: "book" | "node";
  action: ManagementAction;
};
export function ItemActions({
  item,
  type = "node",
  nodes = [],
  onAction,
  disabled = false,
}: {
  item: Item;
  type?: "book" | "node";
  nodes?: Item[];
  onAction: (t: Target) => void;
  disabled?: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const peers = children(liveNodes(nodes), item.parentId ?? null);
  const position = peers.findIndex((n) => n.id === item.id);
  function action(action: ManagementAction) {
    menu.current?.removeAttribute("open");
    onAction({ item, type, action });
  }
  return (
    <details className="item-actions" ref={menu}>
      <summary aria-label={`Actions for ${itemLabel(item)}`}>•••</summary>
      <div>
        <button
          aria-label={`Rename ${itemLabel(item)}`}
          disabled={disabled}
          onClick={() => action("rename")}
        >
          Rename…
        </button>
        {type === "node" && (
          <>
            <button
              aria-label={`Move ${itemLabel(item)} up`}
              disabled={disabled || position <= 0}
              onClick={() => action("up")}
            >
              Move Up
            </button>
            <button
              aria-label={`Move ${itemLabel(item)} down`}
              disabled={
                disabled || position < 0 || position === peers.length - 1
              }
              onClick={() => action("down")}
            >
              Move Down
            </button>
            <button
              aria-label={`Move ${itemLabel(item)} to…`}
              disabled={disabled}
              onClick={() => action("move")}
            >
              Move To…
            </button>
          </>
        )}
        <button
          aria-label={`Move ${itemLabel(item)} to Trash`}
          disabled={disabled}
          onClick={() => action("trash")}
        >
          Move to Trash…
        </button>
      </div>
    </details>
  );
}
export function BinderTree({
  nodes,
  selected,
  onSelect,
  onAction,
  disabled = false,
}: {
  nodes: Item[];
  selected: string | undefined;
  onSelect: (item: Item) => void;
  onAction: (t: Target) => void;
  disabled?: boolean;
}) {
  const live = liveNodes(nodes);
  function branch(parent: string | null): React.ReactNode {
    return children(live, parent).map((n) => (
      <div key={n.id} className={`binder-item kind-${n.kind}`}>
        <div className={"binder-row " + (selected === n.id ? "current" : "")}>
          {["scene", "frontMatter", "backMatter"].includes(n.kind ?? "") ? (
            <button
              className="binder-select"
              onClick={() => onSelect(n)}
              disabled={disabled}
            >
              <span aria-hidden="true">▤</span>
              {n.title}
            </button>
          ) : (
            <span className="binder-heading">
              {n.kind === "part" ? "Part · " : ""}
              {n.title}
            </span>
          )}
          <ItemActions
            item={n}
            nodes={live}
            onAction={onAction}
            disabled={disabled}
          />
        </div>
        <div className="binder-children">{branch(n.id)}</div>
      </div>
    ));
  }
  return <div className="tree">{branch(null)}</div>;
}
/** Render inside the shared modal dialog so every operation is keyboard/touch accessible. */
export function ManagementForm({
  target,
  nodes,
  onApply,
  onCancel,
}: {
  target: Target;
  nodes: Item[];
  onApply: (payload: unknown) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(target.item.title);
  const [parent, setParent] = useState(target.item.parentId ?? "");
  const [before, setBefore] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = liveNodes(nodes);
  const kind = target.item.kind;
  const parents = live.filter((n) =>
    kind === "scene"
      ? n.kind === "chapter"
      : kind === "chapter"
        ? n.kind === "part"
        : false,
  );
  const peers = children(live, parent || null).filter(
    (n) => n.id !== target.item.id,
  );
  const label =
    target.action === "rename"
      ? "Rename"
      : target.action === "trash"
        ? "Move to Trash"
        : "Move";
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const payload =
          target.action === "rename"
            ? { title: name }
            : target.action === "move"
              ? { parentId: parent || null, beforeId: before || null }
              : {};
        try {
          const message = await onApply(payload);
          if (message) setError(message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {target.action === "rename" && (
        <label>
          Title
          <input
            autoFocus
            required
            maxLength={500}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      {target.action === "move" && (
        <>
          <label>
            Destination
            <select
              autoFocus
              value={parent}
              required={kind === "scene"}
              onChange={(e) => {
                setParent(e.target.value);
                setBefore("");
              }}
            >
              {kind !== "scene" && <option value="">Book root</option>}
              {parents.map((n) => (
                <option key={n.id} value={n.id}>
                  {itemLabel(n)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Position
            <select value={before} onChange={(e) => setBefore(e.target.value)}>
              <option value="">At the end</option>
              {peers.map((n) => (
                <option key={n.id} value={n.id}>
                  Before {n.title}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {target.action === "trash" && (
        <p>
          Move “{target.item.title}”
          {target.type === "book" || ["part", "chapter"].includes(kind ?? "")
            ? " and its contents"
            : ""}{" "}
          to Trash? Text and saved versions will be kept. You can restore it
          later.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || (target.action === "rename" && !name.trim())}
        >
          {busy ? "Working…" : label}
        </button>
      </div>
    </form>
  );
}
