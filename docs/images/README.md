# README images

Captured on 2026-11-13 from Aseprite 1.3.18.6 on Linux, using the native Codex
assistant panel from this repository.

- [aseprite-assistant.png](aseprite-assistant.png) — 1710 × 1372. The editor with
  the isometric city open and a completed assistant response about adding a marina.
- [assistant-panel.png](assistant-panel.png) — 632 × 546. A close-up of that same
  panel, showing the selected model and effort, instruction field, response, and
  history controls.
- [city-example.png](city-example.png) — 1344 × 704. A flattened PNG preview of
  the same 672 × 352 document at 2× scale, with transparency preserved.

The screenshots contain the actual native UI and completed response from the
session. They show an idle panel after the edit; the working spinner appears
during a request. Model availability and the number of undo steps can vary.
The Roman city artwork comes from the local Aseprite session; its editable source
document is not bundled with this repository.

To refresh these images, open a representative sprite and the latest panel, finish
an editing request, and capture the editor and panel. Keep the response text and
controls readable. Crop out desktop content and absolute file paths, and preserve
pixel edges when resizing. Export the artwork preview through `aseprite_preview`
at an integer scale. Check every image visually before replacing it, and update
this note if the subject or UI changes.
