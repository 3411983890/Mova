const out = [];
for (const el of document.querySelectorAll('*')) {
  const root = el.shadowRoot;
  if (!root) continue;
  const surface = root.querySelector('[data-message-composer-surface]');
  if (!surface) continue;
  out.push({
    host: el.tagName.toLowerCase(),
    inlineBefore: surface.getAttribute('style')?.slice(0, 120) ?? null,
    radiusBefore: getComputedStyle(surface).borderRadius,
  });
  surface.style.borderRadius = '24px';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.push({
    inlineAfter: surface.getAttribute('style')?.slice(0, 120) ?? null,
    radiusAfter: getComputedStyle(surface).borderRadius,
    matchesImportant: [...root.styleSheets].flatMap(s => [...s.cssRules]).filter(r => r.cssText?.includes('composer-surface')).map(r => r.cssText.slice(0, 200)),
  });
  surface.style.borderRadius = '';
}
return out;
