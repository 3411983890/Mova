# Third-party materials

## OpenPencil and CanvasKit

The design integration uses `@open-pencil/core` and `@open-pencil/vue` 0.16.0 (MIT), from https://github.com/open-pencil/open-pencil. It runs the actual OpenPencil editor and Skia canvas with a Mova settings and workspace shell. The build includes the OpenPencil MIT license at `vendor/open-pencil/LICENSE-OpenPencil.txt` and the CanvasKit license at `vendor/open-pencil/LICENSE-CanvasKit.txt`. Inter font assets are distributed with the SDK; Inter is licensed under SIL Open Font License 1.1 (https://github.com/rsms/inter).

## generative-loaders

Source: https://github.com/kasturikhanke/generative-loaders (version 0.1.1)

MIT License

Copyright (c) 2026 Kasturi Khanke and Generative Loaders contributors

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

## NX_emotion-ball

Source: https://github.com/jackyrx/NX_emotion-ball

Original scripts copied without modification into `vendor/emotion-ball/js/` on 2026-11-09. The prototype creates one original `blob` instance using idle expression `02`, enlarged eyes for small-scale readability, and lite rendering.

Upstream community and commercial license texts are preserved at `vendor/emotion-ball/LICENSE` and `vendor/emotion-ball/LICENSE-COMMERCIAL.md`. The upstream project distinguishes noncommercial learning/research use from commercial product integration. Review the included commercial terms before a commercial release.

## Kobra Conversation

Source: https://kobra.systems/components/conversation and https://kobra.systems/r/conversation.json

`bot-conversation.jsx` adapts the conversation / bubble / content structure to this prototype's existing CSS, without installing the Tailwind-based registry component or its complete feature set. Kobra lists Conversation among its free components; its pricing page describes the free tier as personal use only. Consult https://kobra.systems/terms and https://kobra.systems/pricing for applicable terms before distribution or commercial use.

## Keyline Icons

Source: https://keylineicons.com/ and https://www.npmjs.com/package/@keyline-icons/react

Version: 2.6.0. Rounded stroke and fill icons are used in the interface and embedded composer.

MIT License — Copyright (c) 2026 Keyline Icons

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

## Phosphor Icons

Source: https://github.com/phosphor-icons/web

Version: 2.1.2. The previously bundled icon fonts remain in the source assets but are no longer loaded by the interface. License: MIT, reproduced at `assets/icons/LICENSE`.

## LeiBox Deep Agent Composer

Source: https://leibox.pantoria.cn/docs/animations/deep-agent-composer

The published `DeepAgentComposerEngine.js` is used for the input, attachment controls, model and permission menus, and reasoning slider. Mova adds a draft integration and styles the component through its shadow root. The LeiBox license notice is preserved at `vendor/leibox/LICENSE.md`.

## LeiBox Elastic Panel Resize

Source: https://leibox.pantoria.cn/docs/animations/elastic-panel-resize

`sidebar-resize.js` adapts the reference's spring integration, exponential edge resistance, and speed-dependent grip shape to Mova's existing layout. The LeiBox license notice is preserved at `vendor/leibox/LICENSE.md`.

## react-markdown

Source: https://github.com/remarkjs/react-markdown (version 10.1.0)

MIT License — Copyright (c) Espen Hovlandsdal

The renderer is used with `skipHtml` and an explicit link allowlist to display assistant Markdown without executing raw HTML.

## remark-gfm

Source: https://github.com/remarkjs/remark-gfm (version 4.0.1)

MIT License — Copyright (c) Titus Wormer

Both packages are distributed under the MIT License; the full permission and warranty text is the same as reproduced for generative-loaders above.

## Supplied reference artwork

`assets/plugin-reference.png`, `assets/status-reference.png`, and `assets/welcome-reference.png` are exact crops from the screenshot supplied by the user. They preserve the requested existing interface marks for this local design prototype; they are not claimed as original Mova branding.
