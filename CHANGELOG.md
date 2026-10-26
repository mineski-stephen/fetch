# Changelog

Every change and version update of Fetch, newest first. The version is
`APP.version` in `js/config.js`; the top bar shows it beside the name ("v1.0.0").

**Releasing a change:** bump `APP.version` (semver: patch for fixes, minor for
new features or behaviour, major when people must relearn something or old data
or links stop working), add an entry here with the same number and the date,
and say what changed in the team's words. `npm run check:shell` fails if the
two numbers differ.

## 1.1.0 · Oct 26, 2026

- **Check sources shows where every point came from.** Each value and bullet,
  notes included, can now point to up to three passages of the brief, even when
  the summary rewords, combines or deduces them. Needs the extraction service
  1.7.0 (with 1.6.0 you get one passage per value).
- **The source opens on the passage.** Clicking a value zooms the file so the
  passage fills the viewer. Scroll to zoom, drag to move, − / + to step; no
  scroll bars and no Fit button any more. Pages are redrawn sharp at any zoom.
- **Brief files.** A new button opens the whole brief over the dimmed page: every
  file in full, a search box that highlights every match, and every passage the
  summary used marked; click one to see which parts of the summary it became,
  and jump back to them.
- **More room while checking.** The Save / Copy / PDF card is hidden in checking
  mode, so the source gets the whole column.
- **Download attachments.** Click a file's name in the Attachments card of a
  filed brief to download it from Lark, saved under its own name (no new tab).
  A file not uploaded yet opens from memory.
- The loading spinner keeps turning while an image is read, instead of jumping.
- Preview mode (`?preview`) is gone: the local page always runs on real data.

## 1.0.0 · Oct 16, 2026

- Initial release.
