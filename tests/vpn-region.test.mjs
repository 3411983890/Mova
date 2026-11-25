/**
 * 负责：`electron/vpn/region.mjs` 的判定规则回归锁。
 * 不负责：测速与切线（`health.mjs`）、YAML 生成（`runtime-config.mjs`）。
 * 被谁调用：`node --test`。
 *
 * 为什么这是安全相关的：地区判定错一次，就可能把「日本」当成「美国」而触发跨地区切换，
 * 这正是用户最怕的账号风控场景。所以这里用的名字全部取自**真实订阅**，
 * 而不是编造的样例。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REGION_UNKNOWN, REGION_UNKNOWN_LABEL, codeFromFlagEmoji, codeFromRegionWords,
  commonRegionCode, normalizeCode, regionLabel, regionOfNode, sameRegion,
} from '../electron/vpn/region.mjs';

/** 真实订阅里出现过的节点名（逐一实测过）。 */
const REAL_NODES = [
  ['🇯🇵[GPT][IPv6]日本hy15', 'JP'],
  ['🇷🇺[YouTube无广告][IPv6]俄罗斯2', 'RU'],
  ['🇭🇰[IPv6]香港hy3', 'HK'],
  ['🇯🇵[GPT]日本cc1', 'JP'],
  ['🇺🇸[GPT]美国cc2', 'US'],
  ['🇯🇵[GPT]日本cc31', 'JP'],
  ['🇹🇼[家宽][Gemini]台湾hy5', 'TW'],
  ['🇺🇸[Gemini][直连] 美国2', 'US'],
  ['🇺🇸[AI][GPT][直连] 美国 ai2', 'US'],
];

test('真实订阅的 9 个节点名都解析出正确地区码', () => {
  for (const [name, expected] of REAL_NODES) {
    const region = regionOfNode({ name });
    assert.equal(region.code, expected, `${name} 应解析为 ${expected}，实际 ${region.code}`);
    assert.ok(region.label && region.label !== REGION_UNKNOWN_LABEL, `${name} 应给出中文标签`);
  }
});

test('国旗 emoji 按码点解码，新增国旗天然支持（不需要逐条登记）', () => {
  assert.equal(codeFromFlagEmoji('🇯🇵日本'), 'JP');
  assert.equal(codeFromFlagEmoji('🇹🇼台湾'), 'TW');
  assert.equal(codeFromFlagEmoji('🇰🇷韩国'), 'KR');
  // 没有国旗时返回空串，不能瞎猜。
  assert.equal(codeFromFlagEmoji('日本节点'), '');
  assert.equal(codeFromFlagEmoji(''), '');
  assert.equal(codeFromFlagEmoji(null), '');
});

test('长词优先：白俄罗斯不被认成俄罗斯，印度尼西亚不被认成印度', () => {
  assert.equal(codeFromRegionWords('白俄罗斯 Minsk'), 'BY');
  assert.equal(codeFromRegionWords('俄罗斯 Moscow'), 'RU');
  assert.equal(codeFromRegionWords('印度尼西亚 Jakarta'), 'ID');
  assert.equal(codeFromRegionWords('印度 Mumbai'), 'IN');
});

test('两位代码只认「独立词」或「代码+数字」，不会把英文单词骗成国家', () => {
  // 独立出现（大写）→ 认
  assert.equal(codeFromRegionWords('US-02'), 'US');
  assert.equal(codeFromRegionWords('node US'), 'US');
  assert.equal(codeFromRegionWords('jp1'), 'JP');
  // 出现在单词内部 → 不认（这是最容易误判的地方）
  assert.equal(codeFromRegionWords('business node'), '');
  assert.equal(codeFromRegionWords('no.3'), '');
  assert.equal(codeFromRegionWords('italy'), 'IT', '完整国名仍然要认');
  // **小写的独立两位词不算**：`us` / `no` / `my` / `it` 在英文里都是常见单词，
  // 认了就会把普通节点名当成国家。模块的口径是「小写只在其后紧跟数字时才认」，
  // 因此 `node us` 落到 ZZ —— 这是有意的保守，宁可未知也不误判。
  assert.equal(codeFromRegionWords('node us'), '', '小写 us 不认（英文单词歧义）');
  assert.equal(codeFromRegionWords('node my'), '', '小写 my 不认');
});

test('解析不出就是 ZZ，绝不按概率猜', () => {
  const region = regionOfNode({ name: 'Node-7 高速中转' });
  assert.equal(region.code, REGION_UNKNOWN);
  assert.equal(region.label, REGION_UNKNOWN_LABEL);
  // server 不参与判定：只按名字。
  assert.equal(regionOfNode({ name: 'Node-7', server: 'jp.example.com' }).code, REGION_UNKNOWN);
  assert.equal(regionOfNode({}).code, REGION_UNKNOWN);
  assert.equal(regionOfNode().code, REGION_UNKNOWN);
});

test('sameRegion 保守：ZZ 与任何值（包括另一个 ZZ）都不算同地区', () => {
  assert.equal(sameRegion('JP', 'JP'), true);
  assert.equal(sameRegion({ code: 'jp' }, { code: 'JP' }), true, '大小写不敏感');
  assert.equal(sameRegion('JP', 'US'), false);
  assert.equal(sameRegion(REGION_UNKNOWN, REGION_UNKNOWN), false, '两个未知不能当成同地区');
  assert.equal(sameRegion(REGION_UNKNOWN, 'JP'), false);
  assert.equal(sameRegion('', 'JP'), false);
  assert.equal(sameRegion(null, null), false);
});

test('normalizeCode / regionLabel / commonRegionCode 的边界', () => {
  assert.equal(normalizeCode('jP'), 'JP');
  assert.equal(normalizeCode({ code: 'tw' }), 'TW');
  assert.equal(normalizeCode('JPN'), '', '三位代码不是 ISO-3166 两位码');
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');

  assert.equal(regionLabel('JP'), '日本');
  assert.equal(regionLabel('TW'), '台湾');
  assert.equal(regionLabel(REGION_UNKNOWN), REGION_UNKNOWN_LABEL);
  // 白名单外但合法的国旗码：如实回码，不编造国家名。
  assert.equal(regionLabel('ZZ'), REGION_UNKNOWN_LABEL);

  assert.equal(commonRegionCode([{ code: 'JP' }, { code: 'JP' }]), 'JP');
  assert.equal(commonRegionCode([{ code: 'JP' }, { code: 'US' }]), 'mixed');
  assert.equal(commonRegionCode([{ code: REGION_UNKNOWN }, { code: REGION_UNKNOWN }]), 'mixed');
  assert.equal(commonRegionCode([]), 'mixed');
});
