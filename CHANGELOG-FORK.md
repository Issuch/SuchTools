# Fork changelog

Changes on top of the original VibeTools. Host script version in brackets
(`VT_SCRIPT_VERSION` in `jsx/hostscript.jsx`).

## [3.9.12]
- Undo groups no longer create a warm-up bin, so no greyed "Create VT_undo..." /
  "Rename item..." lines appear in the History panel.
- Placeholders and helper sequences are deleted directly (one step) instead of
  Create bin + Move + Delete bin; no hidden undo that left greyed steps.
- A failed insert closes its undo group, so the next Ctrl+Z cannot take back
  unrelated edits.
- Placeholder polling runs one lookup at a time.

## [3.9.10 - 3.9.11]
- Dragging a saved MOGRT leaves one *Overwrite* in the History panel (the
  placeholder drop is undone, each step verified).
- Media is imported into the project root and reused when already present; the
  `VibeAssets` bin is no longer created on panel start.

## [3.9.9]
- One Ctrl+Z undoes a native drag and it no longer comes back (undo direction is
  taken from the real index movement).

## [3.9.6 - 3.9.8]
- Double-click no longer rescales media on top of Premiere's Default Media
  Scaling; double-click and drag give the same size.
- Delete without confirmation; files held open by previews are released first,
  locked files and old leftovers are cleaned on the next start.
- Sidebar: drag to reorder icons and the group separator, right-click menu
  (Icons only / Show names, Reset icon order), adjustable icon spacing, reopens
  on the last used category; the collapse arrow was removed.
- Panel files are cache-busted so Premiere never serves a stale copy.

## [3.9.5]
- Presets for video, image and audio clips (bound to their media file), video
  part of linked clips, Time Remapping excluded from presets.
- Inserting a video from the library picks the video part (scale-to-fit no
  longer skipped).

## [3.9.0 - 3.9.4]
- Native MOGRT save/insert without clipboard or helper sequences; playhead kept
  in place on double-click and drag.
- Fixed double-click inserting the previous media.
- Per-clip presets with apply options (keep text, Motion, Opacity, add missing
  effects).
- Fixed `EvalScript error` on load (ES3 reserved word), log rotation, FFmpeg run
  without a shell.
