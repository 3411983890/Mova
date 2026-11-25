import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await import('./build.mjs');
const source = new URL('../edge-extension/', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const output = new URL('../dist-edge/', import.meta.url);
await mkdir(output, { recursive: true });
await cp(dist, output, { recursive: true });
await cp(source, output, { recursive: true });

const header = `
  <header class="edge-top" aria-label="Mova">
    <div id="edge-avatar"></div>
    <span id="edge-page-status" role="status"></span>
    <button id="edge-page-menu-toggle" type="button" popovertarget="edge-page-menu" aria-label="网页控制与连接" title="网页控制与连接"><i class="ph ph-globe" aria-hidden="true"></i></button>
    <button type="button" popovertarget="edge-chat-menu" aria-label="聊天菜单" title="聊天菜单"><i class="ph ph-dots-three" aria-hidden="true"></i></button>
  </header>
  <div id="edge-page-menu" popover aria-label="网页控制与连接">
    <button id="edge-page" type="button" aria-pressed="false">允许网页控制</button>
    <button id="edge-auto-access" type="button">启用网页自动访问</button>
    <button id="edge-repair" type="button">重新输入配对码</button>
  </div>
  <div id="edge-chat-menu" popover aria-label="ChatMova 聊天记录">
    <button id="edge-new-chat" type="button">＋ 新建聊天</button>
    <div id="edge-chats"></div>
  </div>
  <dialog id="edge-access-dialog" aria-labelledby="edge-access-title" aria-describedby="edge-access-description">
    <h2 id="edge-access-title">允许自动网页控制</h2>
    <p id="edge-access-description">首次使用需要在 Edge 确认网站访问权限。Mova 可以控制当前未分组网页和 Agent 分组中的网页。</p>
    <div class="edge-pair-actions">
      <button id="edge-access-cancel" type="button">暂不允许</button>
      <button id="edge-access-confirm" type="button" autofocus>继续授权</button>
    </div>
  </dialog>
  <dialog id="edge-pair-dialog">
    <form id="edge-pair-form">
      <h2>连接 Mova</h2>
      <p>在 Mova 桌面端顶部点击「连接 Edge」，粘贴复制的配对码。</p>
      <input id="edge-code" aria-label="配对码" placeholder="配对码" required autocomplete="off" spellcheck="false">
      <p id="edge-pair-status" role="status"></p>
      <div class="edge-pair-actions">
        <button id="edge-pair-cancel" type="button">取消</button>
        <button type="submit">连接</button>
      </div>
    </form>
  </dialog>`;

const html = (await readFile(new URL('index.html', dist), 'utf8'))
  .replace('</head>', '  <link rel="stylesheet" href="./panel.css">\n</head>')
  .replace('<main class="main-panel">', '<main class="main-panel">' + header)
  .replace('<script src="./app.js" defer>', '<script type="module" src="./bridge.js">');
await writeFile(new URL('index.html', output), html);
console.log('Load the unpacked Edge extension from dist-edge/');
