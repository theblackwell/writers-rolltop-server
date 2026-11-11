import type { ReactNode } from "react";

// Original line icons, drawn for this app. They are decoration: the control that holds one carries the label.
function Svg({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const HomeIcon = () => <Svg><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v10h13V10" /><path d="M10 20v-5.5h4V20" /></Svg>;
export const BookIcon = () => <Svg><path d="M12 6.5C10 5 7 4.6 3.5 5v13c3.5-.4 6.5 0 8.5 1.5 2-1.500 5-1.900 8.500-1.500V5C17 4.600 14 5 12 6.500Z" /><path d="M12 6.500v13" /></Svg>;
export const NoteIcon = () => <Svg><path d="M6 3.500h9l3.500 3.500v13.500H6Z" /><path d="M14.500 3.500V7.500h4" /><path d="M9 12h6M9 15.500h6" /></Svg>;
export const BibleIcon = () => <Svg><path d="M3.500 5h7c.8 0 1.500.7 1.500 1.500V19c0-.8-.7-1.500-1.500-1.500h-7Z" /><path d="M20.500 5h-7c-.8 0-1.500.7-1.500 1.500V19c0-.8.7-1.500 1.500-1.500h7Z" /><path d="M6 9h3.500M6 12h3.500M14.500 9H18M14.500 12H18" /></Svg>;
export const ToolsIcon = () => <Svg><path d="M14.500 6.500a4 4 0 0 0-5.200 5.200L3.500 17.500l3 3 5.800-5.800a4 4 0 0 0 5.200-5.200l-2.800 2.800-2.200-.6-.6-2.200Z" /></Svg>;
export const ShelfIcon = () => <Svg><rect x="4" y="4" width="4.500" height="16" rx=".8" /><rect x="9.500" y="4" width="4.500" height="16" rx=".8" /><path d="m15.800 5.500 3.700-.9 3 14.500-3.700.9Z" /></Svg>;
export const QuillIcon = () => <Svg size={40}><path d="M20.500 3.500C13 4 8.500 9 7.500 16L5 21.500" /><path d="M20.500 3.500c1 7-2.500 12-9.500 12.500" /><path d="M9 14c3-.5 6-3 8-7" /></Svg>;
export const UndoIcon = () => <Svg><path d="M9 7 4.500 11.500 9 16" /><path d="M5 11.500h9a5 5 0 0 1 0 10h-3" transform="translate(0 -3)" /></Svg>;
export const RedoIcon = () => <Svg><path d="m15 7 4.500 4.500L15 16" /><path d="M19 11.500h-9a5 5 0 0 0 0 10h3" transform="translate(0 -3)" /></Svg>;
export const BulletListIcon = () => <Svg><circle cx="5" cy="7" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="5" cy="17" r="1" /><path d="M9.500 7h10M9.500 12h10M9.500 17h10" /></Svg>;
export const NumberListIcon = () => <Svg><path d="M4 5.500 5.500 5v4M4 9h3M4 14.500c.5-1 3-1 3 .5 0 1-3 2-3 3h3" /><path d="M10 7h10M10 12h10M10 17h10" /></Svg>;
export const ExpandIcon = () => <Svg><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const CompressIcon = () => <Svg><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Svg>;
export const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const CloseIcon = () => <Svg size={18}><path d="m6 6 12 12M18 6 6 18" /></Svg>;
export const ChevronRightIcon = () => <Svg size={20}><path d="m9 5 7 7-7 7" /></Svg>;
export const ChevronDownIcon = () => <Svg size={18}><path d="m5 9 7 7 7-7" /></Svg>;
export const PinIcon = () => <Svg><path d="m14 3.500 6.500 6.500-3 .5-3.500 3.500.5 3.500-1.500 1.500-3.500-3.500-5 5M9.500 7.500l-2 .5L6 9.500l8.500 8.500" /></Svg>;
export const PeopleIcon = () => <Svg><circle cx="9" cy="8" r="3" /><path d="M3.500 19c.3-3.300 2.700-5.500 5.500-5.500s5.200 2.200 5.500 5.500" /><path d="M15.500 5.200a3 3 0 0 1 0 5.600M17 13.800c2 .6 3.300 2.400 3.500 5.200" /></Svg>;
export const GlobeIcon = () => <Svg><circle cx="12" cy="12" r="8.500" /><path d="M3.500 12h17M12 3.500c2.500 2.500 3.500 5.300 3.500 8.500s-1 6-3.500 8.500C9.500 18 8.500 15.200 8.500 12s1-6 3.500-8.500Z" /></Svg>;
export const LayersIcon = () => <Svg><path d="m12 4 9 4.500-9 4.500-9-4.500Z" /><path d="m3 12.500 9 4.500 9-4.500" /><path d="m3 16.500 9 4.500 9-4.500" /></Svg>;
export const HistoryIcon = () => <Svg><path d="M4 12a8 8 0 1 0 2.500-5.800L4 8.500" /><path d="M4 4v4.500h4.500" /><path d="M12 8v4.500l3 1.500" /></Svg>;
