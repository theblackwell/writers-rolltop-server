import type { ReactNode } from "react";
import { BulletListIcon, CompressIcon, ExpandIcon, NumberListIcon, RedoIcon, UndoIcon } from "./icons.tsx";
import type { ToolbarState } from "./editor/rolltop-editor.ts";

export type ToolName = "undo" | "redo" | "bold" | "italic" | "underline" | "bullet" | "ordered";

interface Props {
  /** False for the sample page: the buttons can be reached but do nothing. */
  live: boolean;
  state?: ToolbarState | undefined;
  run?: ((t: ToolName) => void) | undefined;
  expanded: boolean;
  onExpand: () => void;
}

/** The formatting toolbar. A press does not take focus from the text (mouse and touch), so the selection stays put. */
export function Toolbar({ live, state, run, expanded, onExpand }: Props) {
  const btn = (name: ToolName, label: string, child: ReactNode, pressed?: boolean, disabled?: boolean) => (
    <button type="button" className="tool" aria-label={label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      aria-disabled={!live || disabled ? "true" : undefined}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.preventDefault(); if (live && !disabled) run?.(name); }}>
      {child}
    </button>
  );
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" aria-describedby="editor-note">
      {btn("undo", "Undo", <UndoIcon />, undefined, live && state ? !state.canUndo : false)}
      {btn("redo", "Redo", <RedoIcon />, undefined, live && state ? !state.canRedo : false)}
      <span className="toolbar__gap" aria-hidden="true" />
      {btn("bold", "Bold", <b>B</b>, live ? state?.bold ?? false : undefined)}
      {btn("italic", "Italic", <i>I</i>, live ? state?.italic ?? false : undefined)}
      {btn("underline", "Underline", <u>U</u>, live ? state?.underline ?? false : undefined)}
      <span className="toolbar__gap" aria-hidden="true" />
      {btn("bullet", "Bulleted list", <BulletListIcon />, live ? state?.bullet ?? false : undefined)}
      {btn("ordered", "Numbered list", <NumberListIcon />, live ? state?.ordered ?? false : undefined)}
      <button type="button" className="tool tool--end" aria-pressed={expanded}
        aria-label={expanded ? "Restore panels" : "Expand editor"} onClick={onExpand}>
        {expanded ? <CompressIcon /> : <ExpandIcon />}
      </button>
    </div>
  );
}
