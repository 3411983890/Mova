/**
 * `agy models` 的解析工具（**备用**路径）。
 *
 * 主路径已经换成 ACP：`initialize` + `session/new` 的 `models.availableModels` 才是权威清单
 * （以 t3code 的 provider-acp 为准，实测稳定返回 18 个模型）。而 `agy models` 实测经常返回空，
 * 曾经把「添加账号」卡了 25 秒，所以它不再参与登录判定，只作为排查/未来降级时的工具保留。
 *
 * 仍然被主路径使用的是 `effortsFromLabel`：把 `Gemini 4 Argon (Medium)` 里的档位解析出来。
 */

/** 标签末尾括注里的档位 → 思考档位 id。整串比对，避免 `XHigh` 同时命中 `high`。 */
const EFFORT_TABLE = Object.freeze({
  minimal: 'minimal',
  low: 'low',
  mid: 'medium',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
});

/** 从标签里推断思考档位：`Gemini 3.8 Flash (High)` → ['high']；`(Argon)` → []。 */
export function effortsFromLabel(label) {
  const match = /\(([^)]+)\)\s*$/.exec(String(label ?? ''));
  if (!match) return [];
  const level = EFFORT_TABLE[match[1].trim().toLowerCase()];
  return level ? [level] : [];
}

/** 去掉标签末尾的 `(High)` 这类括注，剩下的就是显示名。 */
export function nameFromLabel(label) {
  return String(label ?? '').replace(/\s*\((?:x?high|medium|mid|low|minimal)\)\s*$/i, '').trim();
}

/** id 尾部的档位后缀：`gemini-4-argon-high` → high。标签里没写档位时的兜底。 */
const EFFORT_SUFFIX = /[-_](minimal|low|mid|medium|high|xhigh)$/i;

/**
 * 把 ACP 报的一条模型解析成「家族 + 档位」。
 *
 * 为什么要拆：agy 把同一个模型的每个思考档位当成**独立模型**列出来
 * （`gemini-4-argon-low/medium/high`，显示名 `Gemini 4 Argon (High)`）。
 * 直接落库就是 18 行同名不同括注的菜单；用户要的是「7 个模型 + 各自可选档位」。
 *
 * 判定顺序：标签括注 → id 后缀 → 没有档位（单档模型，如 `gpt-oss-120b-medium` 也会命中后缀）。
 * 家族 id 一律取「去掉档位后缀的 id」，因为 `set_model` 要用真实 id 才能生效。
 */
export function classifyModelLabel(id, label) {
  const rawId = typeof id === 'string' ? id.trim() : '';
  const rawLabel = typeof label === 'string' ? label.trim() : '';
  const byLabel = effortsFromLabel(rawLabel);
  let effort = byLabel[0] ?? '';
  let familyId = rawId;
  if (effort) {
    // 标签给了档位：家族 id 从标签名反推（`Gemini 4 Argon` → gemini-4-argon），推不出再切 id 后缀。
    const familyName = nameFromLabel(rawLabel);
    const slug = familyName.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    familyId = slug && rawId.toLowerCase().startsWith(slug) ? slug : rawId.replace(EFFORT_SUFFIX, '');
  } else {
    const suffix = EFFORT_SUFFIX.exec(rawId);
    if (suffix) {
      effort = EFFORT_TABLE[suffix[1].toLowerCase()] ?? '';
      familyId = rawId.replace(EFFORT_SUFFIX, '');
    }
  }
  if (!familyId) familyId = rawId;
  const familyLabel = nameFromLabel(rawLabel) || familyId;
  return { familyId, familyLabel, effort, variantId: rawId };
}

/**
 * 把 ACP 的模型清单合并成目录条目。
 *
 * 输出形状：一个家族一条，`variants` 记录「档位 → 真实 id」，
 * `efforts` 只列这个模型真正支持的档位（渲染层据此出二级菜单）。
 * 没有档位的条目（`Orchestrator (Argon)`）原样保留、`efforts` 为空。
 */
export function groupModels(models, { vision = true, contextWindow = 1_000_000, maxTokens = 65_536 } = {}) {
  const list = Array.isArray(models) ? models : [];
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const byFamily = new Map();
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id) continue;
    const label = typeof entry?.label === 'string' ? entry.label : (typeof entry?.name === 'string' ? entry.name : id);
    const incoming = entry?.variants && typeof entry.variants === 'object' && !Array.isArray(entry.variants)
      ? entry.variants
      : null;
    // 已经合并过的条目（目录读回来再保存一次）：id 就是家族 id，档位表原样带下来。
    const parts = incoming
      ? { familyId: id, familyLabel: nameFromLabel(label) || label || id, effort: '', variantId: id }
      : classifyModelLabel(id, label);
    const { familyId, familyLabel, effort, variantId } = parts;
    const key = familyId || id;
    let family = byFamily.get(key);
    if (!family) {
      family = {
        id: key,
        name: familyLabel,
        vision: entry?.vision ?? vision,
        efforts: [],
        variants: {},
        contextWindow: entry?.contextWindow ?? contextWindow,
        maxTokens: entry?.maxTokens ?? maxTokens,
      };
      byFamily.set(key, family);
    }
    if (incoming) {
      for (const [level, variantIdValue] of Object.entries(incoming)) {
        const levelKey = String(level).toLowerCase();
        if (order.includes(levelKey) && typeof variantIdValue === 'string' && variantIdValue && !family.variants[levelKey]) {
          family.variants[levelKey] = variantIdValue;
        }
      }
    } else if (effort && !family.variants[effort]) {
      family.variants[effort] = variantId;
    }
    // 同一个家族里出现不同名字时，保留第一次见到的那个（通常是家族名，不带括注）。
    if (!family.name && familyLabel) family.name = familyLabel;
  }
  return [...byFamily.values()].map(family => ({
    ...family,
    efforts: order.filter(level => family.variants[level]),
  }));
}

/**
 * 从目录条目 + 思考档位算出要发给 CLI 的真实模型 id。
 *
 * 三条规则，按优先级：
 * 1. 精确命中 `variants[effort]` → 用它；
 * 2. 该模型没有这个档位 → 取**档位距离最近**的那一个（`max` 落到 `high` 比回传家族 id 安全，
 *    因为 agy 的 `session/set_model` 只认它自己枚举出来的 id）；
 * 3. 完全没有 variants（用户自建条目 / 老目录）→ 回传条目 id 本身。
 */
export function resolveVariantId(model, effort) {
  const variants = model?.variants && typeof model.variants === 'object' ? model.variants : {};
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const available = levels.filter(level => typeof variants[level] === 'string' && variants[level]);
  const wanted = typeof effort === 'string' ? effort : '';
  if (wanted && available.includes(wanted)) return variants[wanted];
  if (available.length) {
    const target = levels.indexOf(wanted);
    const pick = target < 0
      ? available[available.length - 1]
      : available.reduce((best, level) => (
        Math.abs(levels.indexOf(level) - target) < Math.abs(levels.indexOf(best) - target) ? level : best
      ), available[0]);
    return variants[pick];
  }
  return typeof model?.id === 'string' ? model.id : '';
}

/**
 * 解析 `agy models` 的输出。
 *
 * 真实输出是「id<TAB>标签」两列；但终端宽度变化时可能变成多空格分隔，
 * 所以两种分隔都认。认不出的行（提示语、空行、`Fetching…`）直接跳过。
 *
 * @returns {Array<{ id: string, name: string, efforts: string[] }>}
 */
export function parseModelsOutput(text) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 首列必须是形如模型 id 的串：字母数字开头，只含 [\w.:/@+-]
    const match = /^([A-Za-z0-9][\w.:/@+-]*)\t+(.+)$/.exec(line)
      ?? /^([A-Za-z0-9][\w.:/@+-]*)\s{2,}(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = match[2].trim();
    // `label` 是 CLI 原样打印的那一行（`Gemini 4 Argon (High)`）：同一个家族会有
    // medium/high/low 三条，用原始标签当显示名才不会在模型菜单里变成三个重名项。
    models.push({ id, label, name: nameFromLabel(label) || id, efforts: effortsFromLabel(label) });
  }
  return models;
}

/**
 * 跑一次 `agy models`。
 *
 * 刻意**不**改 HOME/USERPROFILE：这里要读的是用户自己那份 CLI 登录态，
 * 换成私有 profile 只会看到一个没登录的空结果（旧实现就是这么错的）。
 *
 * @returns {Promise<{ ok: boolean, models: Array, detail: string }>}
 */
export async function listCliModels({ exec, command, timeoutMs = 25_000 } = {}) {
  if (typeof exec !== 'function' || typeof command !== 'string' || !command) {
    return { ok: false, models: [], detail: 'no_exec' };
  }
  let result;
  try {
    result = await exec(command, ['models'], { timeoutMs });
  } catch (error) {
    return { ok: false, models: [], detail: `exec_failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }
  const models = parseModelsOutput(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
  if (models.length > 0) return { ok: true, models, detail: '' };
  const code = result?.code ?? 0;
  return {
    ok: false,
    models: [],
    detail: code !== 0
      ? `cli_exit_${code}: ${String(result?.stderr ?? '').trim().slice(0, 160)}`
      : 'no_models: CLI 没有返回任何模型（多半是还没在这台机器上登录 Google 账号）',
  };
}
