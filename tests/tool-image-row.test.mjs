/**
 * 工具截图行的纯函数层断言（不需要 React / DOM / 真实图片文件）。
 *
 * 守的是三件事：
 * 1. 只有 `status === 'done'` 且带 `image` 的工具事件才产出缩略图行；
 * 2. 同一 `id` 的事件原地更新时，图片行只是一行（不堆叠）；
 * 3. 事件里没有 `image` 时，工具行与改动前逐字节一致（回归）。
 *
 * 被测模块：src/features/chat/trace-image.mjs（决策）+ src/features/chat/chat-reply.ts（合并）。
 * 图片地址用纯字符串，不需要真实文件：后端给的就是 `./chat-images/<sha256>.png`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReplyEvent } from '../src/features/chat/chat-reply.ts';
import {
  attachToolImage, shouldRenderImage, toolImageOf, toolStatusRow,
} from '../src/features/chat/trace-image.mjs';

const SHOT_ID = '9f2c1d7a4b6e8f00.png';
const SHOT = { id: SHOT_ID, name: '画板截图 · 1280×800', src: `./chat-images/${SHOT_ID}` };

/** 一次工具调用的 running 帧：还没有截图。 */
const running = () => ({
  type: 'tool', id: 'mcp-3', name: 'design_screenshot', label: '画板截图',
  status: 'running', detail: '渲染画板',
});

/** 同一个 id 的 done 帧：后端把截图挂在 `image` 上（不是 `{ type: 'image' }`）。 */
const done = (image = SHOT) => ({
  type: 'tool', id: 'mcp-3', name: 'design_screenshot', label: '画板截图',
  status: 'done', detail: '1280×800', image,
});

/** traceSegments 里「普通工具行」那一步的等价复刻：一条事件 → 该行要不要画缩略图。 */
function imageRowsOf(timeline) {
  return timeline
    .filter(event => event.type === 'tool')
    .map(event => toolStatusRow(event))
    .filter(row => shouldRenderImage(row))
    .map(row => row.image);
}

test('running → done(image) → 同 id 再更新：只有 done 那一行产出图片，且始终只有一行', () => {
  const timeline = [];

  // 1) running：还没生成截图，行上没有 image 字段，也就没有缩略图。
  mergeReplyEvent(timeline, running());
  assert.equal(timeline.length, 1);
  assert.equal('image' in timeline[0], false, 'running 帧不带 image');
  assert.equal(toolImageOf(running()), null, 'running 不产出图片行');
  assert.deepEqual(imageRowsOf(timeline), []);

  // 2) done 带上截图：原地覆盖同一行，多出一个 image。
  mergeReplyEvent(timeline, done());
  assert.equal(timeline.length, 1, 'done 原地更新，不新增行');
  assert.deepEqual(timeline[0].image, SHOT, 'image 被 Object.assign 保留下来');
  assert.deepEqual(toolImageOf(timeline[0]), SHOT, '归一后 id/name/src 与后端事件一致');
  assert.deepEqual(imageRowsOf(timeline), [SHOT]);

  // 3) 同一 id 的后续帧（迟到的进度帧 + 又一次 done）：图片行仍然只有一行。
  mergeReplyEvent(timeline, { ...running(), detail: '第 2/3 步：导出' });
  mergeReplyEvent(timeline, done());
  mergeReplyEvent(timeline, done());
  assert.equal(timeline.length, 1, '同一 id 始终只有一行时间线事件');
  assert.equal(imageRowsOf(timeline).length, 1, '图片行不能重复堆叠');
  assert.deepEqual(imageRowsOf(timeline), [SHOT]);
});

test('error / denied 即使带着 image 也不画缩略图（没有可展示的结果）', () => {
  for (const status of ['error', 'denied']) {
    const event = { type: 'tool', id: 'mcp-4', name: 'browser_screenshot', label: '网页截图', status, detail: '失败', image: SHOT };
    assert.equal(toolImageOf(event), null, `${status} 不产出图片行`);
    const row = toolStatusRow(event);
    assert.equal(shouldRenderImage(row), false);
    assert.equal('image' in row, false);
  }
});

test('坏数据整块丢弃：缺 id、缺 src、显式没有 image、独立 image 事件都不画图', () => {
  const base = { type: 'tool', id: 'mcp-6', name: 'desktop_screenshot', label: '桌面截图', status: 'done' };
  // 落盘失败时后端根本不带 image；缺 id 的 image 也不能变成一张裂图。
  assert.equal(toolImageOf(base), null);
  assert.equal(toolImageOf({ ...base, image: { name: '没有 id' } }), null);
  assert.equal(toolImageOf({ ...base, image: { id: '   ', src: './chat-images/x.png' } }), null);
  assert.equal(toolImageOf({ ...base, image: null }), null);
  // `{ type: 'image' }` 是「用户上传的附件」，绝不能在这里变成工具缩略图。
  assert.equal(toolImageOf({ type: 'image', id: SHOT_ID, name: '附件', image: SHOT }), null);
  // src 缺失时按后端的落盘目录补齐，而不是留空让 <img> 指向当前页面。
  assert.deepEqual(toolImageOf({ ...base, image: { id: SHOT_ID } }), {
    id: SHOT_ID, name: '工具截图', src: `./chat-images/${SHOT_ID}`,
  });
  // 只有 id/src 都在的行才会被渲染层放行。
  assert.equal(shouldRenderImage({ image: { id: SHOT_ID } }), false, '缺 src 的行不画');
  assert.equal(shouldRenderImage({}), false);
  assert.equal(shouldRenderImage(null), false);
});

test('回归：事件里没有 image 时，工具行与改动前完全一致（同一个对象、同样的字段）', () => {
  // 改动前 traceSegments 里那一行的字面量就是这个形状：{ icon, label, meta }。
  assert.deepEqual(
    toolStatusRow({ type: 'tool', id: 'mcp-1', name: 'read_file', label: '读取文件', status: 'done', detail: '42 行' }),
    { icon: 'file', label: '读取文件', meta: '42 行' },
  );
  assert.deepEqual(
    toolStatusRow({ type: 'tool', id: 'mcp-2', name: 'list_files', label: '列出文件', status: 'error', detail: '目录不存在' }),
    { icon: 'folder', label: '列出文件', meta: '目录不存在' },
  );
  // 进行中的工具把 detail 贴到标题后面；跑完之后 detail 归右侧的 meta。
  assert.deepEqual(
    toolStatusRow({ type: 'tool', id: 'mcp-3', name: 'design_screenshot', label: '画板截图', status: 'running', detail: '渲染画板' }),
    { icon: 'bulb', label: '画板截图 · 渲染画板', meta: '执行中' },
  );
  // denied 走专属图标，缺 detail 时有可读兜底。
  assert.deepEqual(
    toolStatusRow({ type: 'tool', id: 'mcp-4', name: 'run_command', label: '运行命令', status: 'denied' }),
    { icon: 'denied', label: '运行命令', meta: '已拒绝' },
  );
  // 没有截图时不产生新的行对象：挂图函数原样返回同一个引用。
  const plainRow = { icon: 'file', label: '读取文件', meta: '42 行' };
  assert.equal(attachToolImage(plainRow, { type: 'tool', status: 'done', detail: '42 行' }), plainRow);
  assert.equal('image' in plainRow, false);
});

test('有截图时只在原行上多一个 image 字段，其它字段不动', () => {
  const plainRow = { icon: 'bulb', label: '画板截图', meta: '1280×800' };
  const withImage = attachToolImage(plainRow, done());
  assert.deepEqual(withImage, { ...plainRow, image: SHOT });
  assert.equal('image' in plainRow, false, '不改动传入的原行');
  assert.equal(shouldRenderImage(withImage), true);
});
