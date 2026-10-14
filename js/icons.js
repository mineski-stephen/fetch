/* Mineski icon set: inline SVG, 24 × 24 viewBox, stroke = currentColor, 2 px round
   strokes, no fills (except the three dots). The union of Fetch's and Polaris's
   icons, so every tool draws the same way.

   Use:  <span class="i" data-icon="search" aria-hidden="true"></span>
         then fillIcons() from ui.js, or ic("search") to build one in JS.

   Adding an icon: draw it on a 24 grid, 2 px stroke, round caps and joins,
   about 2.5 px of padding, corner radius 2 to 2.5 on rectangles. Never mix in an
   icon font or another icon library. */

const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  // navigation & structure
  arrowLeft: svg('<path d="M19 12H5m0 0 6.5 6.5M5 12l6.5-6.5"/>'),
  arrowRight: svg('<path d="M5 12h14m0 0-6.5-6.5M19 12l-6.5 6.5"/>'),
  caret: svg('<path d="m6 9 6 6 6-6"/>'),
  external: svg('<path d="M14 3.5h6.5V10M20.5 3.5 11 13"/><path d="M18 14v4.5a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 3 18.5v-10A2.5 2.5 0 0 1 5.5 6H10"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  inbox: svg('<path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/><path d="M5.5 5h13l2.5 8.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.5z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>'),
  refresh: svg('<path d="M20.5 12a8.5 8.5 0 0 1-14.9 5.6M3.5 12A8.5 8.5 0 0 1 18.4 6.4"/><path d="M18.5 2.5v4h-4M5.5 21.5v-4h4"/>'),
  sortDown: svg('<path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5"/><path d="M14 6h7M14 12h5M14 18h3"/>'),
  sortUp: svg('<path d="M7 20V4m0 0L3.5 7.5M7 4l3.5 3.5"/><path d="M14 6h3M14 12h5M14 18h7"/>'),
  steps: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>'),

  // actions
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  pencil: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4.5 1.5L5 15z"/>'),
  trash: svg('<path d="M3.5 6.5h17M9 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5v2M6 6.5l1 13a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l1-13M10 11v6M14 11v6"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.5"/><path d="M15.5 8.5V5.5A2.5 2.5 0 0 0 13 3H5.5A2.5 2.5 0 0 0 3 5.5V13a2.5 2.5 0 0 0 2.5 2.5h3"/>'),
  upload: svg('<path d="M12 15V3m0 0-4.5 4.5M12 3l4.5 4.5"/><path d="M20 15v3.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5V15"/>'),
  download: svg('<path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M20 15v3.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5V15"/>'),
  save: svg('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/><path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  open: svg('<path d="M14 3.5h6.5V10M20.5 3.5 11 13"/><path d="M18 14v4.5a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 3 18.5v-10A2.5 2.5 0 0 1 5.5 6H10"/>'),
  send: svg('<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>'),
  sparkles: svg('<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9z"/><path d="M19 3v4M21 5h-4M5 17v3M6.5 18.5h-3"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  logout: svg('<path d="M14.5 4H18a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 18 20h-3.5"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12h10"/>'),

  // status
  alert: svg('<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>'),
  doneCircle: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>'),
  undoneCircle: svg('<circle cx="12" cy="12" r="9"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  bulb: svg('<path d="M9 18h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7v.5h6v-.5c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z"/>'),

  // things
  file: svg('<path d="M14 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 2.5V8h5.5"/>'),
  markdown: svg('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6.5 15V9l2.5 3 2.5-3v6M15.5 9v6m0 0-2-2m2 2 2-2"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  chat: svg('<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.4-5.1A8.5 8.5 0 1 1 21 11.5z"/>'),
  coin: svg('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2a3 3 0 0 0-2.8-1.7c-1.7 0-3 1-3 2.3 0 3.2 6 1.7 6 4.6 0 1.3-1.3 2.3-3 2.3a3 3 0 0 1-2.8-1.7M12 6v1.5m0 9V18"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6M17.5 14.2a6.5 6.5 0 0 1 4 5.8"/>'),
  planet: svg('<circle cx="12" cy="12" r="5.5"/><path d="M6.8 13.9c-3 1.9-4.5 3.7-3.9 4.6.9 1.5 6.2-.6 11.8-4.7S22.9 6.4 22 4.9c-.6-.9-2.8-.6-5.6.7"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M3 15h18M9.5 9.5V20"/>'),

  // appearance
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  moon: svg('<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>'),
  monitor: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>'),
};
