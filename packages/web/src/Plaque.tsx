import { QuillIcon } from "./icons.tsx";

/** The brass plaque: product name and tagline. */
export function Plaque() {
  return (
    <div className="plaque">
      <span className="plaque__quill"><QuillIcon /></span>
      <div>
        <h1 className="plaque__title">Writers Rolltop</h1>
        <p className="plaque__tagline">A Workspace for Novelists</p>
      </div>
    </div>
  );
}
