# OpenPencil interface adaptation

Upstream: https://github.com/open-pencil/open-pencil

The buildless HTML layout in `canvas.html`, `canvas-openpencil.css`, and `canvas.js` adapts the supplied OpenPencil reference image and the following upstream UI structure:

- `src/components/PagesPanel.vue`: Pages header, add action, page list.
- `src/components/LayersPanel.vue`: Pages/Layers vertical split; app menu and File/Assets controls omitted.
- `src/components/DesignPanel.vue`: selected-object header, frame, position, layout, appearance and fill sections.
- `src/components/PropertiesPanel.vue`: design content retained; Design/Code/AI tabs and zoom omitted.
- `src/views/EditorView.vue`: editor left/center/right arrangement; collaboration/share row and rulers omitted.

This is an HTML interface port for the Mova prototype, not a compiled Vue component or an integration of OpenPencil's document/rendering engine. The toolbar follows the five leftmost tools in the supplied reference, excluding hand, comment and reaction. The pen button reports that its editing engine is not connected. Layout flow, direction, padding and anchor choices are saved as prototype settings; they do not perform OpenPencil/Yoga auto-layout. Existing Mova artwork is rendered by HTML/SVG.

## Upstream license

MIT License

Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
