'use client';

export type IconName =
  | 'mic'
  | 'mic_off'
  | 'videocam'
  | 'videocam_off'
  | 'present'
  | 'chat'
  | 'record'
  | 'stop'
  | 'call_end'
  | 'copy'
  | 'check'
  | 'close'
  | 'script'
  | 'bookmark'
  | 'edit'
  | 'settings'
  | 'board'
  | 'levels'
  | 'folder'
  | 'people'
  | 'arrow_drop_up'
  | 'arrow_drop_down';

// Paths adapted from Google Material Icons (24x24, fill=currentColor), Apache
// License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). The videocam path
// is also inlined in app/page.tsx, and Material's send icon in
// components/ChatPanel.tsx.
const PATHS: Record<IconName, React.ReactNode> = {
  arrow_drop_up: <path d="m7 14 5-5 5 5z" />,
  arrow_drop_down: <path d="m7 10 5 5 5-5z" />,
  mic: (

    <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 11h-2z" />
  ),
  mic_off: (
    <>
      <path d="M15 11V5a3 3 0 0 0-5.94-.6L15 10.34V11zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 3 3 3 3 0 0 0 1.07-.2l1.7 1.7A4.97 4.97 0 0 1 12 16a5 5 0 0 1-5-5H5a7 7 0 0 0 6 6.92V22h2v-3.08a6.95 6.95 0 0 0 2.6-1L19.73 21 21 19.73 4.27 3z" />
    </>
  ),
  videocam: (
    <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
  ),
  videocam_off: (
    <path d="M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 .73-.32L19.73 21 21 19.73 3.27 2z" />
  ),
  present: (
    <path d="M20 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h6v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H4V5h16v12zM13 10v3h-2v-3H8l4-4 4 4h-3z" />
  ),
  chat: (
    <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 11H7v-2h11v2zm0-3H7V8h11v2z" />
  ),
  record: <circle cx="12" cy="12" r="8" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  script: (
    <path d="M4 3h13a2 2 0 0 1 2 2v13a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V3zm3 4v2h9V7H7zm0 4v2h9v-2H7zm0 4v2h6v-2H7z" />
  ),
  settings: (
    <path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
  ),
  board: (
    <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
  ),
  levels: <path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z" />,
  bookmark: <path d="M6 2h12a1 1 0 0 1 1 1v18l-7-4-7 4V3a1 1 0 0 1 1-1z" />,
  edit: (
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
  ),
  call_end: (
    <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08A.99.99 0 0 1 0 12.38c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85a1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
  ),
  copy: (
    <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
  ),
  check: <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />,
  folder: <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />,
  people: (
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  ),
  close: (
    <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  ),
};

export function Icon({
  name,
  size = 24,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
