/**
 * 负责：从节点**名称**推断 ISO-3166 两位地区码与中文标签，并给出保守的「是否同地区」判定。
 * 不负责：测速、切节点（`health.mjs`）、展示（`src/features/vpn/vpn-health-line.jsx`）、
 *   解析节点 URI（`parser.mjs`）、写运行态配置（`runtime-config.mjs` 只把这里的结果抄进 `mova-meta`）。
 * 被谁调用：`contract.mjs`（`inferNodeRegion`）、`runtime-config.mjs`（`mova-meta.pools[].region`）、
 *   `health.mjs`（`pickFallbackNode` 的同地区筛选）、`runtime.mjs`（预检返回的 `region`）、
 *   `tests/vpn-region.test.mjs`。
 *
 * 纯函数模块：不 import electron、不联网、不读环境变量、不依赖当前时间。
 *
 * 为什么**只看名字**、不看 `server`：
 * 订阅里的 server 绝大多数是 IP 或共享 CDN 域名（实测里 anytls 节点是 `*.example-cdn.net`），
 * 按 server 猜国家等于瞎猜——猜错会把「日本」当成「美国」，直接触发用户最怕的跨地区切换。
 * `regionOfNode({ name, server })` 保留 `server` 入参只为调用方形状统一，**不参与判定**。
 */

/** 未识别地区：任何判定都把它当作「不可比较」，绝不当成「同一地区」。 */
export const REGION_UNKNOWN = 'ZZ';
/** 未识别地区的中文标签。 */
export const REGION_UNKNOWN_LABEL = '未知地区';

/** 常用地区的中文标签（只影响展示；解析出的 code 不依赖它）。 */
const REGION_LABELS = Object.freeze({
  JP: '日本', TW: '台湾', US: '美国', HK: '香港', MO: '澳门', RU: '俄罗斯',
  SG: '新加坡', KR: '韩国', GB: '英国', IE: '爱尔兰', DE: '德国', FR: '法国',
  NL: '荷兰', BE: '比利时', LU: '卢森堡', CH: '瑞士', AT: '奥地利', IT: '意大利',
  ES: '西班牙', PT: '葡萄牙', GR: '希腊', PL: '波兰', CZ: '捷克', SK: '斯洛伐克',
  HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚', RS: '塞尔维亚', HR: '克罗地亚',
  SI: '斯洛文尼亚', SE: '瑞典', NO: '挪威', FI: '芬兰', DK: '丹麦', IS: '冰岛',
  EE: '爱沙尼亚', LV: '拉脱维亚', LT: '立陶宛', UA: '乌克兰', BY: '白俄罗斯',
  MD: '摩尔多瓦', TR: '土耳其', IL: '以色列', AE: '阿联酋', SA: '沙特', QA: '卡塔尔',
  KW: '科威特', BH: '巴林', OM: '阿曼', JO: '约旦', LB: '黎巴嫩', IQ: '伊拉克',
  IR: '伊朗', AF: '阿富汗', KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦', KG: '吉尔吉斯斯坦',
  TJ: '塔吉克斯坦', TM: '土库曼斯坦', AZ: '阿塞拜疆', AM: '亚美尼亚', GE: '格鲁吉亚',
  IN: '印度', PK: '巴基斯坦', BD: '孟加拉', NP: '尼泊尔', LK: '斯里兰卡',
  ID: '印度尼西亚', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾',
  KH: '柬埔寨', MM: '缅甸', LA: '老挝', MN: '蒙古', CN: '中国',
  CA: '加拿大', MX: '墨西哥', CU: '古巴', GT: '危地马拉', CR: '哥斯达黎加',
  PA: '巴拿马', DO: '多米尼加', PR: '波多黎各', BR: '巴西', AR: '阿根廷',
  CL: '智利', PE: '秘鲁', CO: '哥伦比亚', VE: '委内瑞拉', UY: '乌拉圭',
  PY: '巴拉圭', BO: '玻利维亚', EC: '厄瓜多尔', AU: '澳大利亚', NZ: '新西兰',
  FJ: '斐济', GU: '关岛', EG: '埃及', MA: '摩洛哥', TN: '突尼斯',
  NG: '尼日利亚', KE: '肯尼亚', ZA: '南非', EU: '欧洲',
});

/**
 * 名字里的「地区词」规则。
 *
 * 顺序即优先级，**长词必须排在短词前面**：`白俄罗斯` 必须早于 `俄罗斯`（否则 BY 会被认成 RU），
 * `印度尼西亚` 必须早于 `印度`。改这张表时把新词插到会被它包含的短词之前。
 */
const NAME_RULES = Object.freeze([
  { code: 'TW', re: /台湾|臺灣|台北|新北|台中|台南|高雄|新竹|桃园|taiwan|taipei|taiwanese/i },
  { code: 'HK', re: /香港|港区|荃湾|沙田|hong\s?kong|hongkong/i },
  { code: 'MO', re: /澳门|澳門|macau|macao/i },
  { code: 'BY', re: /白俄罗斯|白俄|belarus|minsk|明斯克/i },
  { code: 'RU', re: /俄罗斯|俄羅斯|莫斯科|圣彼得堡|海参崴|新西伯利亚|russia|moscow|saint\s?petersburg/i },
  { code: 'UA', re: /乌克兰|烏克蘭|基辅|ukraine|kyiv|kiev/i },
  { code: 'KZ', re: /哈萨克|哈薩克|kazakh/i },
  { code: 'ID', re: /印度尼西亚|印度尼西亞|印尼|雅加达|indonesia|jakarta/i },
  { code: 'IN', re: /印度|孟买|班加罗尔|india|mumbai|bangalore/i },
  { code: 'JP', re: /日本|东京|東京|大阪|埼玉|名古屋|福冈|福岡|北海道|冲绳|沖繩|京都|japan|tokyo|osaka|nagoya|fukuoka|hokkaido|okinawa/i },
  { code: 'KR', re: /韩国|韓國|首尔|首爾|釜山|春川|korea|seoul|busan|chuncheon/i },
  { code: 'SG', re: /新加坡|狮城|獅城|singapore/i },
  { code: 'US', re: /美国|美國|洛杉矶|洛杉磯|圣何塞|聖何塞|硅谷|矽谷|西雅图|西雅圖|纽约|紐約|芝加哥|达拉斯|達拉斯|凤凰城|鳳凰城|迈阿密|邁阿密|亚特兰大|波特兰|united\s?states|\busa\b|\bamerica\b|los\s?angeles|san\s?jose|silicon\s?valley|seattle|new\s?york|chicago|dallas|phoenix|miami/i },
  { code: 'CA', re: /加拿大|多伦多|多倫多|温哥华|溫哥華|蒙特利尔|canada|toronto|vancouver|montreal/i },
  { code: 'GB', re: /英国|英國|伦敦|倫敦|曼彻斯特|united\s?kingdom|\bbritain\b|london|manchester/i },
  { code: 'DE', re: /德国|德國|法兰克福|法蘭克福|柏林|慕尼黑|germany|frankfurt|berlin|munich/i },
  { code: 'FR', re: /法国|法國|巴黎|马赛|france|paris|marseille/i },
  { code: 'NL', re: /荷兰|荷蘭|阿姆斯特丹|netherlands|amsterdam/i },
  { code: 'CH', re: /瑞士|苏黎世|日內瓦|日内瓦|switzerland|zurich|geneva/i },
  { code: 'SE', re: /瑞典|斯德哥尔摩|sweden|stockholm/i },
  { code: 'NO', re: /挪威|奥斯陆|norway|oslo/i },
  { code: 'FI', re: /芬兰|芬蘭|赫尔辛基|finland|helsinki/i },
  { code: 'DK', re: /丹麦|丹麥|哥本哈根|denmark|copenhagen/i },
  { code: 'PL', re: /波兰|波蘭|华沙|poland|warsaw/i },
  { code: 'CZ', re: /捷克|布拉格|czech|prague/i },
  { code: 'AT', re: /奥地利|奧地利|维也纳|維也納|austria|vienna/i },
  { code: 'IT', re: /意大利|义大利|米兰|米蘭|罗马|羅馬|italy|milan|rome/i },
  { code: 'ES', re: /西班牙|马德里|馬德里|巴塞罗那|spain|madrid|barcelona/i },
  { code: 'PT', re: /葡萄牙|里斯本|portugal|lisbon/i },
  { code: 'GR', re: /希腊|希臘|雅典|greece|athens/i },
  { code: 'IE', re: /爱尔兰|愛爾蘭|都柏林|ireland|dublin/i },
  { code: 'TR', re: /土耳其|伊斯坦布尔|伊斯坦堡|turkey|türkiye|istanbul/i },
  { code: 'IL', re: /以色列|特拉维夫|israel|tel\s?aviv/i },
  { code: 'AE', re: /阿联酋|阿聯酋|迪拜|杜拜|\buae\b|dubai|emirates/i },
  { code: 'SA', re: /沙特|沙乌地|saudi/i },
  { code: 'ZA', re: /南非|south\s?africa/i },
  { code: 'EG', re: /埃及|开罗|egypt|cairo/i },
  { code: 'NG', re: /尼日利亚|拉各斯|nigeria|lagos/i },
  { code: 'KE', re: /肯尼亚|內罗毕|kenya|nairobi/i },
  { code: 'BR', re: /巴西|圣保罗|brazil|são\s?paulo|sao\s?paulo/i },
  { code: 'AR', re: /阿根廷|布宜诺斯艾利斯|argentina|buenos\s?aires/i },
  { code: 'CL', re: /智利|圣地亚哥|chile|santiago/i },
  { code: 'MX', re: /墨西哥|mexico/i },
  { code: 'AU', re: /澳大利亚|澳洲|悉尼|墨尔本|australia|sydney|melbourne/i },
  { code: 'NZ', re: /新西兰|紐西蘭|奥克兰|new\s?zealand|auckland/i },
  { code: 'VN', re: /越南|河内|胡志明|vietnam|hanoi|ho\s?chi\s?minh/i },
  { code: 'TH', re: /泰国|泰國|曼谷|thailand|bangkok/i },
  { code: 'PH', re: /菲律宾|菲律賓|马尼拉|philippines|manila/i },
  { code: 'MY', re: /马来西亚|馬來西亞|吉隆坡|malaysia|kuala\s?lumpur/i },
  { code: 'CN', re: /中国|中國|大陆|大陸|上海|北京|广州|廣州|深圳|杭州|成都|重庆|china|shanghai|beijing|guangzhou|shenzhen/i },
]);

/**
 * 两位代码白名单：只在**没有命中任何地区词**时才用，且必须左右都不是字母
 * （否则 `us` 会命中 `business`、`in` 会命中 `india` 里的片段）。
 * `UK` 是口语写法，映射到 ISO 的 `GB`。
 */
const CODE_ALIASES = Object.freeze([
  ['UK', 'GB'], ['USA', 'US'], ['JPN', 'JP'], ['SGP', 'SG'], ['HKG', 'HK'],
  ['TWN', 'TW'], ['KOR', 'KR'], ['RUS', 'RU'], ['DEU', 'DE'],
]);
const CODE_WHITELIST = Object.freeze([
  'JP', 'TW', 'US', 'HK', 'MO', 'RU', 'SG', 'KR', 'GB', 'DE', 'FR', 'NL', 'CH',
  'SE', 'NO', 'FI', 'DK', 'PL', 'CZ', 'AT', 'IT', 'ES', 'PT', 'GR', 'IE', 'TR',
  'IL', 'AE', 'SA', 'ZA', 'EG', 'NG', 'KE', 'IN', 'ID', 'VN', 'TH', 'PH', 'MY',
  'BR', 'AR', 'CL', 'MX', 'CA', 'AU', 'NZ', 'UA', 'BY', 'KZ', 'CN', 'EU',
]);

/** 地区码 → 中文标签；未知码回落成码本身（不编造国家名）。 */
export function regionLabel(code) {
  const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!upper || upper === REGION_UNKNOWN) return REGION_UNKNOWN_LABEL;
  return REGION_LABELS[upper] ?? upper;
}

const REGIONAL_A = 0x1f1e6;
const REGIONAL_Z = 0x1f1ff;

/**
 * 从字符串里解出第一个国旗 emoji 对应的两位代码。
 * 国旗 = 两个「区域指示符」字母（🇯🇵 = U+1F1EF U+1F1F5 → "JP"），这里按码点解码，
 * 因此常见国家**不需要**逐条登记，新增国旗天然支持。
 */
export function codeFromFlagEmoji(text) {
  const chars = Array.from(typeof text === 'string' ? text : '');
  for (let index = 0; index < chars.length - 1; index += 1) {
    const first = chars[index].codePointAt(0);
    const second = chars[index + 1].codePointAt(0);
    if (first < REGIONAL_A || first > REGIONAL_Z) continue;
    if (second < REGIONAL_A || second > REGIONAL_Z) continue;
    const code = String.fromCharCode(
      0x41 + (first - REGIONAL_A),
      0x41 + (second - REGIONAL_A),
    );
    // 白名单外的国旗也照实返回：它确实是一个国家码，只是我们没有中文标签。
    return code;
  }
  return '';
}

/**
 * 两位代码的匹配规则：**大写形态**要求两侧不是字母；**小写形态**只在其后紧跟数字时才算
 * （`jp1` / `us-02` 这种命名很常见，而英文单词 `no` / `my` / `it` 后面跟数字几乎不可能）。
 * 不做全大小写不敏感：否则 `my node` 会被认成马来西亚、`no.3` 被认成挪威。
 */
function matchesCodeToken(text, code) {
  const upper = new RegExp(`(?:^|[^A-Za-z])${code}(?![A-Za-z])`);
  if (upper.test(text)) return true;
  const lowerWithDigit = new RegExp(`(?:^|[^A-Za-z])${code.toLowerCase()}(?=\\d)`);
  return lowerWithDigit.test(text);
}

/** 名字里的地区词 → 两位代码（不含国旗）。 */
export function codeFromRegionWords(name) {
  const text = typeof name === 'string' ? name : '';
  if (!text.trim()) return '';
  for (const rule of NAME_RULES) {
    if (rule.re.test(text)) return rule.code;
  }
  for (const [alias, code] of CODE_ALIASES) {
    if (matchesCodeToken(text, alias)) return code;
  }
  for (const code of CODE_WHITELIST) {
    if (matchesCodeToken(text, code)) return code;
  }
  return '';
}

/**
 * 节点 → `{ code, label }`。
 *
 * 优先级：① 名字里的国旗 emoji → ② 名字里的中文/英文地区词（含两位代码） → ③ `ZZ`。
 * 解析不出就是 `ZZ`（`未知地区`），**绝不按概率猜**：猜错的代价是跨地区切换（账号风控）。
 *
 * @param {{ name?: string, server?: string }} [node]
 * @returns {{ code: string, label: string }}
 */
export function regionOfNode(node = {}) {
  const name = typeof node?.name === 'string' ? node.name : '';
  const fromFlag = codeFromFlagEmoji(name);
  if (fromFlag) return { code: fromFlag, label: regionLabel(fromFlag) };
  const fromWords = codeFromRegionWords(name);
  if (fromWords) return { code: fromWords, label: regionLabel(fromWords) };
  return { code: REGION_UNKNOWN, label: REGION_UNKNOWN_LABEL };
}

/**
 * 两个地区是否「同地区」。
 *
 * 只有**两边都是已知代码且相同**才算；`ZZ` 与任何值（包括另一个 `ZZ`）都不算。
 * 保守是有意的：把「两个未知」当成同地区，等于在信息不足时替用户做跨地区决定。
 *
 * @param {{ code?: string }|string|null} [a] 地区对象或两位代码
 * @param {{ code?: string }|string|null} [b]
 * @returns {boolean}
 */
export function sameRegion(a, b) {
  const left = normalizeCode(a);
  const right = normalizeCode(b);
  if (!left || !right) return false;
  if (left === REGION_UNKNOWN || right === REGION_UNKNOWN) return false;
  return left === right;
}

/** 把「地区对象 / 代码字符串」统一成大写代码；无效返回空串。 */
export function normalizeCode(value) {
  const raw = typeof value === 'string'
    ? value
    : (typeof value?.code === 'string' ? value.code : '');
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/**
 * 一组地区的共同代码：全部一致且已知 → 该代码；否则 `mixed`（含全体未知）。
 * `runtime-config.mjs` 用它写 `mova-meta.pools[].region`。
 *
 * @param {{ code: string }[]} regions
 * @returns {string} 两位代码或 `'mixed'`
 */
export function commonRegionCode(regions = []) {
  const codes = (Array.isArray(regions) ? regions : []).map(normalizeCode);
  if (!codes.length) return 'mixed';
  const first = codes[0];
  if (!first || first === REGION_UNKNOWN) return 'mixed';
  return codes.every(code => code === first) ? first : 'mixed';
}
