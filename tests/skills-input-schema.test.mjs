// electron/skills/input-schema.mjs 的单元测试。
// 这是技能层唯一的入参校验入口：类型/必填/长度/范围/枚举/数组项/嵌套对象/多余键都在这里判。
// 断言只碰返回值形状与消息前缀（`<字段> 必须…` / `缺少必填参数 <字段>`），
// 因为四个 pack 的 handler 把**第一条 message** 原样交给模型——消息就是用户看到的那句话。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidArgumentsResult, validateInput } from '../electron/skills/input-schema.mjs';

/** 一次调用的最小规则：必填的字符串 + 可选整数 + 可选枚举 + 可选数组 + 可选嵌套对象。 */
const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', required: true, maxLength: 12 },
    depth: { type: 'integer', minimum: 1, maximum: 3 },
    zoom: { type: 'number', minimum: 0.1, maximum: 4 },
    kind: { type: 'string', enum: ['read', 'write'] },
    tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1 } },
    steps: { type: 'array', maxItems: 2, items: { type: 'object' } },
    expect: {
      type: 'object',
      properties: {
        kind: { type: 'string', required: true, enum: ['pixels'] },
        threshold: { type: 'number', minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

function firstError(input, schema = SCHEMA, options = {}) {
  const result = validateInput(schema, input, options);
  assert.equal(result.ok, false, `应当被拒绝：${JSON.stringify(input)}`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'errors 不能为空');
  return result.errors[0];
}

function ok(input, schema = SCHEMA, options = {}) {
  const result = validateInput(schema, input, options);
  assert.deepEqual(result.errors ?? [], [], `不该有错误：${JSON.stringify(result.errors)}`);
  assert.equal(result.ok, true);
  return result.value;
}

test('合法入参归一成只含声明字段的对象（additionalProperties:false = 声明即白名单）', () => {
  const value = ok({
    path: 'a.txt',
    depth: '2',
    zoom: '1.5',
    kind: 'write',
    tags: ['x'],
    junk: 'drop me',
  });
  assert.deepEqual(value, { path: 'a.txt', depth: 2, zoom: 1.5, kind: 'write', tags: ['x'] });
  assert.equal('junk' in value, false, '未声明的键必须被丢弃');
});

test('缺少必填参数：消息与路径都指向那个字段', () => {
  const error = firstError({});
  assert.equal(error.path, 'path');
  assert.equal(error.message, '缺少必填参数 path');
});

test('类型错误：字符串 / 整数 / 数字 / 布尔 / 数组 / 对象各有自己的消息', () => {
  assert.equal(firstError({ path: 42 }).message, 'path 必须是字符串');
  assert.equal(firstError({ path: 'a', depth: 1.5 }).message, 'depth 必须是整数');
  assert.equal(firstError({ path: 'a', zoom: 'abc' }).message, 'zoom 必须是数字');
  assert.equal(firstError({ path: 'a', expect: [] }).message, 'expect 必须是对象');
  assert.equal(firstError({ path: 'a', tags: 'x' }).message, 'tags 必须是数组');
  assert.equal(
    firstError({ path: 'a' }, { type: 'object', properties: { path: { type: 'boolean' } }, additionalProperties: false }).message,
    'path 必须是布尔值',
  );
});

test('边界值：maxLength / minLength / minimum / maximum 都按含边界判', () => {
  assert.equal(ok({ path: 'x'.repeat(12) }).path.length, 12, '正好等于上限要过');
  assert.match(firstError({ path: 'x'.repeat(13) }).message, /^path 超过 12 字符上限（当前 13）/);
  assert.equal(ok({ path: 'a', depth: 1 }).depth, 1);
  assert.equal(ok({ path: 'a', depth: 3 }).depth, 3);
  assert.equal(firstError({ path: 'a', depth: 0 }).message, 'depth 不能小于 1');
  assert.equal(firstError({ path: 'a', depth: 4 }).message, 'depth 不能大于 3');
  assert.equal(firstError({ path: 'a', zoom: 0 }).message, 'zoom 不能小于 0.1');
  assert.equal(firstError({ path: 'a', zoom: 5 }).message, 'zoom 不能大于 4');
});

test('枚举：只接受声明过的值，且大小写宽容只能用 normalize:\'upper\' 显式开启', () => {
  assert.equal(ok({ path: 'a', kind: 'read' }).kind, 'read');
  assert.equal(firstError({ path: 'a', kind: 'delete' }).message, 'kind 只能是 read / write');
  assert.equal(firstError({ path: 'a', kind: 'READ' }).message, 'kind 只能是 read / write', '没写 normalize 就不许大小写宽容');

  const upper = {
    type: 'object',
    properties: { format: { type: 'string', enum: ['PNG', 'JPG'], normalize: 'upper' } },
    additionalProperties: false,
  };
  assert.equal(ok({ format: ' png ' }, upper).format, 'PNG', 'trim + 大写后写入归一值');
  assert.equal(firstError({ format: 'gif' }, upper).message, 'format 只能是 PNG / JPG');
});

test('数组：条数上下限与每项类型/非空/长度', () => {
  assert.equal(firstError({ path: 'a', tags: [] }).message, 'tags 至少 1 项');
  assert.match(firstError({ path: 'a', tags: ['a', 'b', 'c', 'd'] }).message, /^tags 最多 3 项（当前 4）/);
  assert.equal(firstError({ path: 'a', tags: ['a', ''] }).message, 'tags 的每一项都必须是非空字符串');
  assert.equal(firstError({ path: 'a', tags: [1] }).message, 'tags 的每一项都必须是字符串');
  assert.equal(firstError({ path: 'a', steps: [{}, 1] }).message, 'steps 的每一项都必须是对象');
  assert.deepEqual(ok({ path: 'a', steps: [{ op: 'click' }, { op: 'wait' }] }).steps, [{ op: 'click' }, { op: 'wait' }]);
});

test('数组项 maxLength（files 那种路径列表）与 items.trim', () => {
  const schema = {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4 } },
      ids: { type: 'array', items: { type: 'string', minLength: 1, trim: true } },
    },
    additionalProperties: false,
  };
  assert.equal(firstError({ files: ['12345'] }, schema).message, 'files 的每一项不得超过 4 字符');
  assert.deepEqual(ok({ ids: [' n1 ', 'n2'] }, schema).ids, ['n1', 'n2'], 'items.trim 要真的 trim 掉空白');
});

test('嵌套 object：递归校验 required / 枚举 / 范围，错误路径是点分路径', () => {
  assert.equal(ok({ path: 'a', expect: { kind: 'pixels', threshold: 0.5 } }).expect.threshold, 0.5);
  const missing = firstError({ path: 'a', expect: { threshold: 0.5 } });
  assert.equal(missing.path, 'expect.kind');
  assert.equal(missing.message, '缺少必填参数 kind');
  const badEnum = firstError({ path: 'a', expect: { kind: 'text' } });
  assert.equal(badEnum.path, 'expect.kind');
  assert.equal(badEnum.message, 'kind 只能是 pixels');
  assert.equal(firstError({ path: 'a', expect: { kind: 'pixels', threshold: 2 } }).message, 'threshold 不能大于 1');
  assert.deepEqual(
    ok({ path: 'a', expect: { kind: 'pixels', junk: 1 } }).expect,
    { kind: 'pixels' },
    '嵌套对象同样按 additionalProperties:false 丢未声明键',
  );
});

test('自由对象（只有 type:object 没有 properties）原样透传，不在技能层再建一份 schema', () => {
  const schema = {
    type: 'object',
    properties: { region: { type: 'object' } },
    additionalProperties: false,
  };
  const region = { x: 1, y: 2, anything: ['goes'] };
  assert.deepEqual(ok({ region }, schema).region, region);
});

test('可选空串：默认当成没传（drop）；emptyStrings:\'keep\' 时原样保留', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 10 }, value: { type: 'string', maxLength: 10 } },
    additionalProperties: false,
  };
  assert.deepEqual(ok({ path: '   ' }, schema), {}, '默认语义：可选空串被丢掉');
  assert.deepEqual(ok({ value: '' }, schema, { emptyStrings: 'keep' }), { value: '' },
    'browser_act 的 value:\'\' 是「清空输入框」，必须保留');
  assert.equal(ok({ path: 'a' }, schema).path, 'a');
});

test('必填空串与 allowEmpty：必填空串报「不能为空」，allowEmpty 放行', () => {
  assert.equal(firstError({ path: '  ' }).message, 'path 不能为空');
  const schema = {
    type: 'object',
    properties: { content: { type: 'string', required: true, maxLength: 10, allowEmpty: true } },
    additionalProperties: false,
  };
  assert.deepEqual(ok({ content: '' }, schema), { content: '' }, 'write_file 写空文件是合法操作');
});

test('null / undefined 都按「没传」处理，非对象入参按空对象处理', () => {
  assert.equal(firstError({ path: null }).message, '缺少必填参数 path');
  assert.equal(firstError({ path: undefined }).message, '缺少必填参数 path');
  assert.equal(firstError(undefined).message, '缺少必填参数 path');
  assert.equal(firstError('not an object').message, '缺少必填参数 path');
});

test('规则写错（未知 type）时报「校验规则未定义」，而不是静默放过', () => {
  const schema = {
    type: 'object',
    properties: { weird: { type: 'objectArray' } },
    additionalProperties: false,
  };
  const error = firstError({ weird: [] }, schema);
  assert.equal(error.path, 'weird');
  assert.equal(error.message, 'weird 的校验规则未定义');
});

test('根规则不是对象时直接报根路径错误（作者写错 schema 不该变成运行时崩溃）', () => {
  const result = validateInput(null, {});
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].path, '');
});

test('invalidArgumentsResult 的输出形状与三个 pack 改造前完全一致', () => {
  const result = invalidArgumentsResult([{ path: 'path', message: 'path 必须是字符串' }]);
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: 'invalid_arguments',
    message: 'path 必须是字符串',
  });
});

test('invalidArgumentsResult 只取第一条消息；没有消息时有兜底文案', () => {
  const many = invalidArgumentsResult([
    { path: 'a', message: 'a 必须是字符串' },
    { path: 'b', message: 'b 必须是整数' },
  ]);
  assert.equal(JSON.parse(many.content[0].text).message, 'a 必须是字符串', '错误是摘要，只交第一条');
  assert.equal(JSON.parse(invalidArgumentsResult([]).content[0].text).message, '参数不合法');
  assert.equal(JSON.parse(invalidArgumentsResult([{ path: 'x' }]).content[0].text).message, '参数不合法');
  assert.equal(JSON.parse(invalidArgumentsResult('直接给一句话').content[0].text).message, '直接给一句话');
  assert.equal(JSON.parse(invalidArgumentsResult([]).content[0].text).error, 'invalid_arguments');
});
