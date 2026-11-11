// PLACEHOLDER DATA (M1-8). No manuscript or library API exists yet, so every list in the shell comes from this file.
// The book switcher, sections, document tabs, Quick Notes and Book Bible links are NOT connected to the server.
// M1-9 and later replace this file with real data. Nothing here is saved.

export const PLACEHOLDER_BOOKS = ["The Ember Crown", "Ashes of Vael"] as const;
export const PLACEHOLDER_QUICK_NOTES = [
  "Establish the city's tension",
  "Show Elara's commitment",
  "Foreshadow the council's response",
] as const;
export const PLACEHOLDER_BIBLE = ["Characters", "Settings", "Lore & History", "Magic System", "Organizations"] as const;
export const PLACEHOLDER_FIRST_TAB = "Chapter 3";

// Names used across all editions (PROJECT.md, UI conventions).
export const TOP_BAR = ["Home", "Write", "Notes", "Book Bible", "Tools", "Resources"] as const;
export const SECTIONS = ["Manuscript", "Notes", "Characters", "Worldbuilding", "Scenes", "Revisions"] as const;
