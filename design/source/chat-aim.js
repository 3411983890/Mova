/* 对话页「正在完成目标 / 正在执行计划」入口与目标·计划弹窗。
 *
 * 入口只有文字：进行中时文字被光扫过，结束后前方出现对号并划掉。
 * 点击后入口消失，卡片从入口位置形变展开；右上角提供暂停 / 删除 / 关闭。
 */

const PANEL_WIDTH = 320;
const VIEWPORT_EDGE = 12;
const MORPH_MS = 340;
const FADE_MS = 260;

const CHECK_SVG = '<svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true"><path d="m3.2 7.1 2.4 2.4 5-5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STATUS_TEXT = { done: '已完成，', active: '进行中，', pending: '未开始，' };

export function bindChatAim({ onOpen, onTogglePause, onDelete } = {}) {
  const host = document.querySelector('.main-panel');
  const pill = document.getElementById('chat-aim');
  const panel = document.getElementById('aim-panel');
  if (!host || !pill || !panel) return null;

  const inner = panel.firstElementChild;
  const pillText = document.getElementById('chat-aim-text');
  const title = document.getElementById('aim-panel-title');
  const goalSection = document.getElementById('aim-goal-section');
  const goalTitle = document.getElementById('aim-goal-title');
  const goalDetail = document.getElementById('aim-goal-detail');
  const goalState = document.getElementById('aim-goal-state');
  const progress = document.getElementById('aim-progress');
  const progressBar = document.getElementById('aim-progress-bar');
  const progressFill = document.getElementById('aim-progress-fill');
  const progressText = document.getElementById('aim-progress-text');
  const planSection = document.getElementById('aim-plan-section');
  const planMeta = document.getElementById('aim-plan-meta');
  const stepsList = document.getElementById('aim-steps');
  const pauseButton = document.getElementById('aim-pause');
  const deleteButton = document.getElementById('aim-delete');
  const closeButton = panel.querySelector('.aim-panel-close');
  const header = document.getElementById('chat-header');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let aim = null;
  let signature = '';
  let open = false;
  let animating = false;
  let busy = false;
  let morph = null;
  let content = null;
  let pillIn = null;
  let frameRequest = 0;

  const box = element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const hasGoal = value => Boolean(value?.goal);
  const stepsOf = value => (Array.isArray(value?.plan?.steps) ? value.plan.steps : []);
  const doneCount = value => stepsOf(value).filter(step => step.status === 'done').length;
  const goalDone = value => value?.goal?.status === 'done';
  const goalPaused = value => value?.goal?.status === 'paused';
  const planRunning = value => stepsOf(value).some(step => step.status === 'active');

  function labelFor(value) {
    if (hasGoal(value)) {
      if (goalPaused(value)) return '已暂停';
      if (!goalDone(value)) return '正在完成目标';
      if (planRunning(value)) return '正在执行计划';
      return '目标已完成';
    }
    if (stepsOf(value).length) return planRunning(value) ? '正在执行计划' : '计划已完成';
    return '';
  }

  function stateFor(value) {
    const label = labelFor(value);
    if (label.startsWith('正在')) return 'live';
    if (label === '已暂停') return 'paused';
    return label ? 'done' : 'idle';
  }

  function hintFor(value) {
    const goal = hasGoal(value);
    const plan = stepsOf(value).length > 0;
    return goal && plan ? '查看当前目标与计划' : goal ? '查看当前目标' : '查看当前计划';
  }

  function syncPill(value) {
    const label = labelFor(value);
    if (!label) { hidePill(); return; }
    const wasHidden = pill.hidden;
    pill.hidden = false;
    pillText.textContent = label;
    pill.dataset.state = stateFor(value);
    pill.classList.toggle('is-live', stateFor(value) === 'live');
    const hint = hintFor(value);
    pill.setAttribute('aria-label', `${label}，${hint}`);
    pill.title = hint;
    if (wasHidden && !reduced.matches) {
      pill.animate([
        { opacity: 0, transform: 'translateX(4px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 200, easing: 'cubic-bezier(.22, .9, .26, 1)' });
    }
  }

  function hidePill() {
    pill.hidden = true;
    pill.classList.remove('is-live', 'is-open');
    pill.dataset.state = 'idle';
    if (open) hide();
  }

  function createStep(step) {
    const status = STATUS_TEXT[step.status] ? step.status : 'pending';
    const item = document.createElement('li');
    item.className = 'aim-step';
    item.dataset.status = status;
    if (status === 'active') item.setAttribute('aria-current', 'step');

    const mark = document.createElement('span');
    mark.className = 'aim-step-mark';
    mark.setAttribute('aria-hidden', 'true');
    if (status === 'done') {
      mark.classList.add('is-check');
      mark.innerHTML = CHECK_SVG;
    }

    const body = document.createElement('span');
    body.className = 'aim-step-body';
    const prefix = document.createElement('span');
    prefix.className = 'visually-hidden';
    prefix.textContent = STATUS_TEXT[status];
    const label = document.createElement('span');
    label.className = 'aim-step-label';
    label.textContent = step.label || '';
    body.append(prefix, label);
    if (step.meta) {
      const meta = document.createElement('span');
      meta.className = 'aim-step-meta';
      meta.textContent = step.meta;
      body.append(meta);
    }
    item.append(mark, body);
    return item;
  }

  function renderPanel(value) {
    const goal = hasGoal(value);
    const steps = stepsOf(value);
    const plan = steps.length > 0;
    const done = goalDone(value);
    const paused = goalPaused(value);
    title.textContent = goal && plan ? '目标与计划' : goal ? '当前目标' : '当前计划';
    panel.dataset.paused = String(paused);

    goalSection.hidden = !goal;
    if (goal) {
      goalTitle.textContent = value.goal.title || '';
      goalDetail.textContent = value.goal.detail || '';
      goalDetail.hidden = !value.goal.detail;
      goalState.textContent = done ? '已完成' : paused ? '已暂停' : '进行中';
    }

    planSection.hidden = !plan;
    if (plan) {
      planMeta.textContent = `${doneCount(value)} / ${steps.length} 完成`;
      stepsList.replaceChildren(...steps.map(createStep));
    }

    progress.hidden = !(goal && plan);
    if (goal && plan) {
      const percent = Math.round(doneCount(value) / steps.length * 100);
      progressFill.style.width = `${percent}%`;
      progressBar.setAttribute('aria-valuenow', String(percent));
      progressText.textContent = `${doneCount(value)} / ${steps.length} 步`;
    }

    pauseButton.hidden = !goal || done;
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.setAttribute('aria-label', paused ? '继续目标' : '暂停目标');
    deleteButton.setAttribute('aria-label', goal && plan ? '删除目标和计划' : goal ? '删除当前目标' : '删除当前计划');
  }

  function geometry() {
    const hostRect = host.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const rightLimit = Math.min(hostRect.width - VIEWPORT_EDGE, pillRect.right - hostRect.left);
    const width = Math.max(240, Math.min(PANEL_WIDTH, rightLimit - VIEWPORT_EDGE, hostRect.width - VIEWPORT_EDGE * 2));
    const left = Math.max(VIEWPORT_EDGE, rightLimit - width);
    return {
      width,
      top: pillRect.top - hostRect.top,
      left,
      maxHeight: Math.max(180, hostRect.height - (pillRect.top - hostRect.top) - VIEWPORT_EDGE),
      pillRect,
      hostRect,
    };
  }

  /** 把卡片摆到最终位置并返回实际高度（含 1px 边框）。 */
  function settle() {
    const area = geometry();
    panel.style.width = `${area.width}px`;
    panel.style.left = `${area.left}px`;
    panel.style.top = `${area.top}px`;
    panel.style.height = '0px';
    inner.style.width = `${panel.clientWidth}px`;
    inner.style.maxHeight = '';
    inner.style.overflowY = '';
    const natural = inner.offsetHeight;
    const limit = Math.max(160, area.maxHeight - 2);
    const height = Math.min(natural, limit);
    panel.style.height = `${height + 2}px`;
    inner.style.maxHeight = `${height}px`;
    inner.style.overflowY = natural > limit ? 'auto' : '';
    return { area, height: height + 2 };
  }

  function clearInline() {
    for (const property of ['width', 'height', 'left', 'top']) panel.style.removeProperty(property);
    inner.style.removeProperty('width');
    inner.style.removeProperty('max-height');
    inner.style.removeProperty('overflow-y');
  }

  function show() {
    if (open || !aim) return;
    if (!pill.getClientRects().length) return;
    onOpen?.();
    open = true;
    animating = true;
    pillIn?.cancel();
    pillIn = null;
    pill.setAttribute('aria-expanded', 'true');
    pill.classList.add('is-open');
    pill.tabIndex = -1;
    panel.hidden = false;

    const { area, height } = settle();
    const start = {
      left: area.pillRect.left - area.hostRect.left,
      top: area.pillRect.top - area.hostRect.top,
      width: area.pillRect.width,
      height: area.pillRect.height,
    };
    const radius = getComputedStyle(pill).borderRadius || '6px';
    content?.cancel();
    content = null;

    if (!reduced.matches) {
      morph?.cancel();
      const opening = panel.animate([
        {
          left: `${start.left}px`,
          top: `${start.top}px`,
          width: `${start.width}px`,
          height: `${start.height}px`,
          borderRadius: radius,
          backgroundColor: 'rgba(43, 43, 43, 0)',
          borderColor: 'rgba(63, 63, 63, 0)',
          opacity: 0.55,
        },
        {
          left: `${area.left}px`,
          top: `${area.top}px`,
          width: `${area.width}px`,
          height: `${height}px`,
          borderRadius: '16px',
          backgroundColor: '#2b2b2b',
          borderColor: '#3f3f3f',
          opacity: 1,
        },
      ], { duration: MORPH_MS, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });
      morph = opening;
      content = inner.animate([
        { opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'none' },
      ], { duration: 200, delay: 140, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });

      opening.addEventListener('finish', () => {
        opening.cancel();
        morph = null;
        content?.cancel();
        content = null;
        animating = false;
        settle();
        panel.focus({ preventScroll: true });
      }, { once: true });
      return;
    }

    animating = false;
    panel.focus({ preventScroll: true });
  }

  function hide(options = {}) {
    if (!open) return;
    open = false;
    animating = true;
    pill.setAttribute('aria-expanded', 'false');
    pill.tabIndex = 0;

    const current = box(panel);
    const area = geometry();
    const start = {
      left: current.left - area.hostRect.left,
      top: current.top - area.hostRect.top,
      width: current.width,
      height: current.height,
    };
    const target = {
      left: area.pillRect.left - area.hostRect.left,
      top: area.pillRect.top - area.hostRect.top,
      width: area.pillRect.width,
      height: area.pillRect.height,
    };
    const radius = getComputedStyle(pill).borderRadius || '6px';

    if (reduced.matches) {
      morph?.cancel();
      morph = null;
      content?.cancel();
      content = null;
      panel.hidden = true;
      clearInline();
      pill.classList.remove('is-open');
      animating = false;
      if (options.focus) pill.focus({ preventScroll: true });
      return;
    }

    morph?.cancel();
    content?.cancel();
    const closing = panel.animate([
      {
        left: `${start.left}px`,
        top: `${start.top}px`,
        width: `${start.width}px`,
        height: `${start.height}px`,
        borderRadius: '16px',
        backgroundColor: '#2b2b2b',
        borderColor: '#3f3f3f',
        opacity: 1,
      },
      {
        left: `${target.left}px`,
        top: `${target.top}px`,
        width: `${target.width}px`,
        height: `${target.height}px`,
        borderRadius: radius,
        backgroundColor: 'rgba(43, 43, 43, 0)',
        borderColor: 'rgba(63, 63, 63, 0)',
        opacity: 0.55,
      },
    ], { duration: FADE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'both' });
    morph = closing;
    content = inner.animate([
      { opacity: 1, filter: 'blur(0px)' },
      { opacity: 0, filter: 'blur(3px)' },
    ], { duration: 130, easing: 'ease-out', fill: 'both' });

    pill.classList.remove('is-open');
    pillIn?.cancel();
    pillIn = pill.animate([
      { opacity: 0, transform: 'scale(.96)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 160, delay: 110, easing: 'cubic-bezier(.22, .9, .26, 1)', fill: 'both' });

    closing.addEventListener('finish', () => {
      closing.cancel();
      morph = null;
      content?.cancel();
      content = null;
      pillIn?.cancel();
      pillIn = null;
      panel.hidden = true;
      clearInline();
      pill.style.removeProperty('opacity');
      pill.style.removeProperty('transform');
      animating = false;
      if (options.focus) pill.focus({ preventScroll: true });
    }, { once: true });
  }

  function setAim(next) {
    const nextSignature = next ? JSON.stringify(next) : '';
    if (nextSignature === signature) return;
    signature = nextSignature;
    aim = next;
    if (!aim) {
      hidePill();
      if (open) hide();
      return;
    }
    syncPill(aim);
    renderPanel(aim);
    if (open) settle();
  }

  function schedule() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (open && !animating) settle();
    });
  }

  pill.addEventListener('click', () => {
    if (open) hide({ focus: true });
    else show();
  });
  closeButton?.addEventListener('click', () => hide({ focus: true }));

  pauseButton?.addEventListener('click', () => {
    if (busy) return;
    onTogglePause?.();
  });

  deleteButton?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await onDelete?.();
      if (open && result === false) panel.focus({ preventScroll: true });
    } finally {
      busy = false;
    }
  });

  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation();
      hide({ focus: true });
    }
  });

  document.addEventListener('pointerdown', event => {
    if (!open || busy) return;
    if (panel.contains(event.target) || pill.contains(event.target)) return;
    hide();
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !open || busy) return;
    hide({ focus: true });
  });

  window.addEventListener('resize', schedule);
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(host);

  if (header) {
    new MutationObserver(() => { if (header.hidden && open) hide(); })
      .observe(header, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    setAim,
    close: () => hide(),
    open: show,
    get isOpen() { return open; },
  };
}
