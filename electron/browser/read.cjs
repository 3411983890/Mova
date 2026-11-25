'use strict';
// Article/page text extraction. Runs in an isolated world so page scripts cannot
// monkey-patch the DOM helpers we rely on, and returns Markdown-ish text instead
// of the full accessibility tree.

const EXTRACT = String.raw`(() => {
  const BAD = 'script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,form,button,input,select,textarea,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
  const clone = document.cloneNode(true);
  clone.querySelectorAll(BAD).forEach(element => element.remove());

  const candidates = [...clone.querySelectorAll('article,main,[role="main"],.content,.post,.article,#content,#main')];
  if (!candidates.length && clone.body) candidates.push(clone.body);

  const linkWeight = element => [...element.querySelectorAll('a')]
    .reduce((total, link) => total + (link.textContent || '').trim().length, 0);
  const score = element => (element.textContent || '').trim().length - linkWeight(element) * 2;
  const best = candidates.sort((a, b) => score(b) - score(a))[0] || clone.body;
  if (!best) return { title: document.title, text: '' };

  const render = node => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + node.textContent.trim() + '\n';
    if (tag === 'li') return '\n- ' + node.textContent.trim();
    if (tag === 'pre') return '\n\n' + node.textContent.trim() + '\n\n';
    if (tag === 'br') return '\n';
    const inner = [...node.childNodes].map(render).join('');
    if (['p', 'div', 'section', 'article', 'main', 'blockquote', 'tr', 'table'].includes(tag)) return '\n' + inner + '\n';
    return inner;
  };

  let text = render(best).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 200 && document.body) {
    text = document.body.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }
  const meta = name => document.querySelector('meta[name="' + name + '"],meta[property="' + name + '"]')?.content || '';
  const links = [...best.querySelectorAll('a[href]')].slice(0, 80).map(link => ({
    text: (link.textContent || '').trim().slice(0, 120),
    href: link.href,
  })).filter(link => link.text && /^https?:/i.test(link.href));
  return {
    title: document.title,
    description: meta('description') || meta('og:description'),
    author: meta('author') || meta('article:author'),
    published: meta('article:published_time') || meta('date'),
    text,
    links,
  };
})()`;

async function isolatedContext(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const frameId = frameTree?.frame?.id;
  if (!frameId) throw Object.assign(new Error('no main frame'), { code: 'read-failed' });
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'mova-read',
    grantUniveralAccess: false,
  });
  return executionContextId;
}

async function readPage(cdp, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? Math.min(options.maxChars, 40000) : 20000;
  const contextId = await isolatedContext(cdp);
  const result = await cdp.send('Runtime.evaluate', {
    contextId,
    expression: EXTRACT,
    returnByValue: true,
    awaitPromise: true,
  }, 15000);
  if (result.exceptionDetails) {
    throw Object.assign(new Error(result.exceptionDetails.text || 'read failed'), { code: 'read-failed' });
  }
  const value = result.result?.value;
  if (!value || typeof value.text !== 'string') {
    throw Object.assign(new Error('empty extraction'), { code: 'read-failed' });
  }
  let text = value.text;
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n…（正文已截断，原长 ${value.text.length} 字符）`;
    truncated = true;
  }
  return {
    url: cdp.guest.getURL(),
    title: value.title || cdp.guest.getTitle(),
    description: value.description || '',
    author: value.author || '',
    published: value.published || '',
    text,
    truncated,
    chars: text.length,
    ...(options.includeLinks === true ? { links: (value.links || []).slice(0, 50) } : {}),
  };
}

module.exports = { readPage, EXTRACT };
