export async function getPointerViewport(send) {
  const { cssVisualViewport } = await send('Page.getLayoutMetrics');
  const width = cssVisualViewport?.clientWidth;
  const height = cssVisualViewport?.clientHeight;
  if (!(width > 0 && height > 0)) throw new Error('Browser viewport is unavailable.');
  return { width, height, pageX: cssVisualViewport.pageX, pageY: cssVisualViewport.pageY, scale: cssVisualViewport.scale };
}

export function compatiblePointerViewport(captured, current) {
  const near = (left, right, tolerance) => Math.abs((left ?? 0) - (right ?? 0)) <= tolerance;
  // The browser's debugger notice can change the available height by one row.
  return near(captured.width, current.width, 2) && near(captured.height, current.height, 48) &&
    near(captured.pageX, current.pageX, 2) && near(captured.pageY, current.pageY, 2) &&
    near(captured.scale, current.scale, 0.001);
}

export function pointerPoints(input, viewport) {
  if (!['click', 'drag'].includes(input.action)) throw new Error('Expected click or drag.');
  const point = (x, y) => {
    if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value < 1)) {
      throw new Error('Pointer coordinates must be fractions between 0 and 1, excluding 1.');
    }
    return { x: x * viewport.width, y: y * viewport.height };
  };
  const from = point(input.x, input.y);
  return { from, to: input.action === 'drag' ? point(input.endX, input.endY) : from };
}

export async function dispatchPointer(send, input, viewport, verify) {
  const { from, to } = pointerPoints(input, viewport);
  const mouse = (type, point, button, buttons, clickCount) =>
    send('Input.dispatchMouseEvent', { type, ...point, button, buttons, clickCount });
  await verify();
  await mouse('mouseMoved', from, 'none', 0, 0);
  await verify();
  await mouse('mousePressed', from, 'left', 1, 1);
  let point = from;
  try {
    if (input.action === 'drag') {
      for (let step = 1; step <= 12; step += 1) {
        await new Promise(resolve => setTimeout(resolve, 16));
        await verify();
        point = { x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 };
        await mouse('mouseMoved', point, 'left', 1, 0);
      }
    }
  } finally {
    await mouse('mouseReleased', point, 'left', 0, 1);
  }
  return { ok: true, action: input.action, from, to, viewport };
}
