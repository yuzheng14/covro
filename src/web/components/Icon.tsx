import type { CSSProperties } from 'react';
import { Puzzle } from 'lucide-react';

const paths = {
  github:
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 19 4.77 5.07 5.07 0 0 0 18.91 1S17.73.65 15 2.48a13.38 13.38 0 0 0-7 0C5.27.65 4.09 1 4.09 1A5.07 5.07 0 0 0 4 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 8 18.13V22',
  compress: 'M4 3h16M4 21h16M12 4v5m-3-3 3 3 3-3M12 20v-5m-3 3 3-3 3 3M5 12h14',
  loader: 'M12 3a9 9 0 1 1-9 9',
  shieldPending: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z',
  question:
    'M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  info: 'M12 8h.01M11 11h1v6m-1 0h2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M10 12h4',
  unarchive: 'M3 3h18v5H3ZM5 8v13h14V8M12 17v-6m-3 3 3-3 3 3',
  plus: 'M12 5v14M5 12h14',
  fork: 'M6 3v12a4 4 0 0 0 4 4h8M6 7h8a4 4 0 0 0 4-4M15 16l3 3-3 3M15 4l3-3 3 3',
  send: 'm5 12 14-7-7 14-1-7-6-0Z M11 13l8-8',
  stop: 'M6 6h12v12H6z',
  chevron: 'm9 5 7 7-7 7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  folder: 'M3 7V5h6l2 2h10v13H3Z',
  chat: 'M4 4h16v12H9l-5 4Z',
  terminal: 'm4 6 6 6-6 6M13 18h7',
  down: 'm6 9 6 6 6-6',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
  search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM8 12l3 3 5-6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 9h12v12H9ZM5 15H3V3h12v2',
  alert: 'M12 3 2 21h20ZM12 9v5M12 17v1',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
} as const;

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths | 'skill';
  size?: number;
  style?: CSSProperties;
}) {
  if (name === 'skill')
    return <Puzzle size={size} strokeWidth={1.7} aria-hidden="true" style={style} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
