/**
 * 真实订阅形状的解析回归：`anytls://` 支持、hysteria2 端口跳跃（`mport`）、
 * 以及「跳过必须可见」（`warnings` / `skipped` / `total`）。
 *
 * 全部凭据都是文档保留地址与全 0 占位符（203.0.113.0/24、2001:db8::/32），
 * 不含任何真实订阅链接或真实密码。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseImportPayload, parseProxyUri } from '../electron/vpn/parser.mjs';
import { VpnError, formatImportSummary, summarizeImportResult } from '../electron/vpn/contract.mjs';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const ANYTLS_MAIN = `anytls://${ZERO_UUID}@203.0.113.9:11443?insecure=1#%F0%9F%87%BA%F0%9F%87%B8[Gemini][直达] 美国2`;
const ANYTLS_AI = 'anytls://11111111-1111-1111-1111-111111111111@203.0.113.10:11443?sni=example.com&allow_insecure=1&alpn=h2,http%2F1.1&fp=chrome#%E7%BE%8E%E5%9B%BDai2';

const HY2_JUMP = `hysteria2://${ZERO_UUID}@[2001:db8::1]:28443?sni=example.com&insecure=1&mport=50000-60000#%E6%97%A5%E6%9C%AChy15`;
const HY2_JUMP_SHORT = `hysteria2://${ZERO_UUID}@203.0.113.11:28444?sni=example.com&mport=45000-46000#%E6%97%A5%E6%9C%AChy16`;
const VLESS_CC1 = `vless://${ZERO_UUID}@203.0.113.7:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLIC-KEY-PLACEHOLDER&sid=ab12&flow=xtls-rprx-vision&type=tcp#%E6%97%A5%E6%9C%ACcc1`;
const VLESS_CC2 = `vless://${ZERO_UUID}@203.0.113.8:443?encryption=none&security=reality&sni=www.example.org&fp=chrome&pbk=PUBLIC-KEY-PLACEHOLDER-2&sid=cd34&flow=xtls-rprx-vision&type=tcp#%E6%97%A5%E6%9C%ACcc2`;

function payloadOf(...lines) {
  return lines.join('\n');
}

test('anytls:// 解析出 Mihomo 需要的字段（username 即密码）', () => {
  const parsed = parseImportPayload(ANYTLS_MAIN, { sourceId: 'clipboard' });
  assert.equal(parsed.nodes.length, 1, 'anytls 不能再被丢掉');
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.total, 1);

  const node = parsed.nodes[0];
  assert.equal(node.type, 'anytls');
  assert.equal(node.name, '🇺🇸[Gemini][直达] 美国2');
  assert.equal(node.server, '203.0.113.9');
  assert.equal(node.port, 11443);
  assert.equal(node.raw.password, ZERO_UUID, 'URI 的 username 必须落到 password');
  assert.equal(node.raw['skip-cert-verify'], true);
  assert.equal(node.raw.uuid, undefined, 'anytls 不能用 uuid 表达凭据');
});

test('anytls 的 sni / alpn / client-fingerprint 都按 Mihomo 字段名落位', () => {
  const raw = parseProxyUri(ANYTLS_AI);
  assert.equal(raw.type, 'anytls');
  assert.equal(raw.server, '203.0.113.10');
  assert.equal(raw.port, 11443);
  assert.equal(raw.password, '11111111-1111-1111-1111-111111111111');
  assert.equal(raw.sni, 'example.com');
  assert.equal(raw['client-fingerprint'], 'chrome');
  assert.deepEqual(raw.alpn, ['h2', 'http/1.1']);
  assert.equal(raw['skip-cert-verify'], true, 'allow_insecure=1 与 insecure=1 等价');
});

test('hysteria2 的 mport 写成 ports，同时保留 authority 端口作为兜底', () => {
  const raw = parseProxyUri(HY2_JUMP);
  assert.equal(raw.type, 'hysteria2');
  assert.equal(raw.ports, '50000-60000');
  assert.equal(raw.port, 28443, 'authority 端口必须仍然保留');
  assert.match(raw.server, /2001:db8::1/);

  const node = parseImportPayload(HY2_JUMP).nodes[0];
  assert.equal(node.raw.ports, '50000-60000');
  assert.equal(node.raw.port, 28443);
});

test('mport 非法（逆序 / 非数字 / 缺一半）不写 ports，进 warnings 且节点仍可用', () => {
  for (const bad of ['60000-50000', 'abc', '50000-']) {
    const uri = `hysteria2://${ZERO_UUID}@203.0.113.12:8443?sni=example.com&mport=${encodeURIComponent(bad)}#bad-range`;
    const parsed = parseImportPayload(uri);
    assert.equal(parsed.nodes.length, 1, `${bad}：节点本身仍应导入`);
    assert.equal(parsed.nodes[0].raw.ports, undefined, `${bad}：非法范围不能写进 ports`);
    assert.equal(parsed.nodes[0].raw.port, 8443, `${bad}：必须保留 authority 端口兜底`);
    assert.equal(parsed.warnings.length, 1, `${bad}：必须上报 warning`);
    assert.equal(parsed.warnings[0].code, 'invalid_port_range');
    assert.match(parsed.warnings[0].detail, /端口跳跃/);
  }
});

test('多条非法 mport 合并成一条 warning，count 记真实条数', () => {
  const parsed = parseImportPayload(payloadOf(
    `hysteria2://${ZERO_UUID}@203.0.113.13:8443?mport=60000-50000#a`,
    `hysteria2://${ZERO_UUID}@203.0.113.14:8443?mport=abc#b`,
  ));
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0].code, 'invalid_port_range');
  assert.equal(parsed.warnings[0].count, 2);
});

test('混合订阅（4 hy2 + 3 vless + 2 anytls）应导入 9 条且零跳过', () => {
  const parsed = parseImportPayload(payloadOf(
    HY2_JUMP,
    HY2_JUMP_SHORT,
    `hysteria2://${ZERO_UUID}@203.0.113.15:28445?sni=example.com&mport=47000-48000#%E6%97%A5%E6%9C%AChy17`,
    `hysteria2://${ZERO_UUID}@203.0.113.16:28446?sni=example.com&mport=49000-49500#%E6%97%A5%E6%9C%AChy18`,
    VLESS_CC1,
    VLESS_CC2,
    `vless://${ZERO_UUID}@203.0.113.17:443?encryption=none&security=reality&sni=www.example.net&fp=chrome&pbk=PUBLIC-KEY-PLACEHOLDER-3&sid=ef56&flow=xtls-rprx-vision&type=tcp#%E6%97%A5%E6%9C%ACcc3`,
    ANYTLS_MAIN,
    ANYTLS_AI,
  ));

  assert.equal(parsed.total, 9);
  assert.equal(parsed.nodes.length, 9);
  assert.equal(parsed.skipped.length, 0);
  assert.deepEqual(parsed.warnings, []);
  const counts = parsed.nodes.reduce((acc, node) => ({ ...acc, [node.type]: (acc[node.type] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { hysteria2: 4, vless: 3, anytls: 2 });
  assert.equal(new Set(parsed.nodes.map(node => node.id)).size, 9, '9 条必须是 9 个不同节点');
});

test('未知 scheme 进 skipped（按 scheme 聚合 count），其余条目照常导入', () => {
  const parsed = parseImportPayload(payloadOf(
    VLESS_CC1,
    ANYTLS_MAIN,
    'ssr://cGxhY2Vob2xkZXItYT9yZW1hcmtzPSVFNSVCNyVCNCVFOCVBNSVCRg#%E5%8F%B0%E6%B9%BE1',
    'ssr://cGxhY2Vob2xkZXItYg#%E5%8F%B0%E6%B9%BE2',
  ));

  assert.equal(parsed.total, 4);
  assert.equal(parsed.nodes.length, 2, '支持的两条不受影响');
  assert.equal(parsed.skipped.length, 1, '同一协议聚合成一条');
  assert.equal(parsed.skipped[0].scheme, 'ssr');
  assert.equal(parsed.skipped[0].reason, 'unsupported_scheme');
  assert.equal(parsed.skipped[0].count, 2);
  assert.equal(parsed.skipped[0].sampleName, '台湾1');
  assert.match(formatImportSummary(parsed), /跳过 2 条（不支持的协议：ssr ×2）/);
});

test('整份订阅都不支持时抛出的错误必须说清原因，而不是笼统 empty_input', () => {
  assert.throws(
    () => parseImportPayload('ssr://cGxhY2Vob2xkZXI#%E5%8F%B0%E6%B9%BE1'),
    error => {
      assert.ok(error instanceof VpnError);
      assert.equal(error.code, 'parse_failed');
      assert.match(error.message, /ssr ×1/);
      return true;
    },
  );
});

test('vless reality 的 pbk / sid / flow 全部保留（导出的 YAML 才有得可用）', () => {
  const node = parseImportPayload(VLESS_CC1).nodes[0];
  assert.equal(node.raw.flow, 'xtls-rprx-vision');
  assert.equal(node.raw['reality-opts']['public-key'], 'PUBLIC-KEY-PLACEHOLDER');
  assert.equal(node.raw['reality-opts']['short-id'], 'ab12');
  assert.equal(node.raw.tls, true);
  assert.equal(node.raw['client-fingerprint'], 'chrome');

  // 即便 URI 漏写 security=reality，只要给了 pbk 也必须按 reality 处理（否则一定握手失败）。
  const noSecurity = parseProxyUri(`vless://${ZERO_UUID}@203.0.113.18:443?encryption=none&pbk=PUBLIC-KEY-PLACEHOLDER-4&sid=aa11#nos`);
  assert.equal(noSecurity.tls, true);
  assert.equal(noSecurity['reality-opts']['public-key'], 'PUBLIC-KEY-PLACEHOLDER-4');
});

test('导入结果文案：共 N 条 / 导入 M 条 / 跳过 K 条 + 不支持的协议', () => {
  const parsed = parseImportPayload(payloadOf(VLESS_CC1, ANYTLS_MAIN, 'ssr://cGxhY2U#x'));
  assert.equal(
    formatImportSummary(parsed),
    '共 3 条，导入 2 条，跳过 1 条（不支持的协议：ssr ×1）',
  );
  const summary = summarizeImportResult(parsed);
  assert.equal(summary.partial, true);
  assert.equal(summary.text, '共 3 条，导入 2 条，跳过 1 条（不支持的协议：ssr ×1）');

  // IPC 目前只回传 nodeCount 的旧形状也必须能兜住，不能拼出「共 0 条，导入 9 条」。
  const legacy = summarizeImportResult({ nodeCount: 9 });
  assert.equal(legacy.text, '共 9 条，导入 9 条，跳过 0 条');
  assert.equal(legacy.partial, false);
});
