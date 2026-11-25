import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFormModel,
  collectContent,
  countMissing,
  createFormState,
  describeFieldType,
  setFieldValue,
  validateForm,
} from '../src/features/ask/schema-form.mjs';

// 表单卡是纯逻辑模块：这里只构造 schema 与 values，不碰 React/DOM/Electron。

const fieldOf = (model, key) => model.fields.find(field => field.key === key);

function nestedSchema(levels) {
  let schema = { type: 'object', properties: { leaf: { type: 'string' } }, required: ['leaf'] };
  for (let i = 1; i < levels; i += 1) {
    schema = { type: 'object', properties: { [`level${i}`]: schema } };
  }
  return schema;
}

/* ---------------------------------------------------------------- 类型映射 */

test('short string without enum maps to a single-line text control', () => {
  assert.equal(describeFieldType({ type: 'string' }), 'text', '普通字符串应映射为单行输入');
  assert.equal(describeFieldType({ type: 'string', maxLength: 240 }), 'text', 'maxLength=240 仍是单行');
  const model = buildFormModel({
    type: 'object',
    properties: { name: { type: 'string', title: '名称', description: '给任务起个名字' } },
    required: ['name'],
  });
  const field = fieldOf(model, 'name');
  assert.equal(model.kind, 'form', '简单 schema 应正常建模');
  assert.equal(field.kind, 'text', '字段 kind 应为 text');
  assert.equal(field.label, '名称', 'label 优先取 title');
  assert.equal(field.description, '给任务起个名字', 'description 应透传');
  assert.equal(field.required, true, 'required 应透传');
  assert.equal(field.path, 'name', '顶层字段 path 即键名');
  assert.equal(field.depth, 0, '顶层字段 depth 为 0');
});

test('long or multi-line strings map to textarea', () => {
  assert.equal(describeFieldType({ type: 'string', maxLength: 241 }), 'textarea', 'maxLength>240 应给多行');
  assert.equal(describeFieldType({ type: 'string', format: 'multi' }), 'textarea', 'format:multi 应给多行');
  const model = buildFormModel({
    type: 'object',
    properties: { brief: { type: 'string', format: 'multi', maxLength: 2000 } },
  });
  assert.equal(fieldOf(model, 'brief').kind, 'textarea', '长文本字段 kind 应为 textarea');
  assert.equal(fieldOf(model, 'brief').maxLength, 2000, 'maxLength 应保留供计数提示');
});

test('enum strings split into segment (<=4) and select (>=5)', () => {
  const two = { type: 'string', enum: ['fast', 'slow'] };
  const five = { type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] };
  assert.equal(describeFieldType(two), 'segment', '2–4 项枚举用内联分段');
  assert.equal(describeFieldType(five), 'select', '≥5 项枚举用下拉');

  const model = buildFormModel({
    type: 'object',
    properties: { speed: { ...two, title: '速度' }, mode: five },
  });
  assert.deepEqual(fieldOf(model, 'speed').enumValues, ['fast', 'slow'], 'enumValues 应保留全部选项');
  assert.equal(fieldOf(model, 'mode').kind, 'select', '5 项枚举字段应为 select');
});

test('format:path stays a plain text input', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { outDir: { type: 'string', format: 'path' } },
  });
  assert.equal(describeFieldType({ type: 'string', format: 'path' }), 'text', 'path 只是字符串，不弹系统选择器');
  assert.equal(fieldOf(model, 'outDir').kind, 'text', 'path 字段 kind 应为 text');
});

test('numbers, integers and booleans map to number/switch controls', () => {
  assert.equal(describeFieldType({ type: 'number' }), 'number', 'number → 数字输入');
  assert.equal(describeFieldType({ type: 'integer' }), 'number', 'integer → 数字输入');
  assert.equal(describeFieldType({ type: 'boolean' }), 'switch', 'boolean → 开关');

  const model = buildFormModel({
    type: 'object',
    properties: {
      retries: { type: 'integer', minimum: 1, maximum: 9, title: '重试', unit: '次' },
      verbose: { type: 'boolean', title: '详细输出' },
    },
  });
  const retries = fieldOf(model, 'retries');
  assert.equal(retries.kind, 'number', 'integer 字段 kind 为 number');
  assert.equal(retries.integer, true, 'integer 需要标记，校验时才拒绝小数');
  assert.equal(retries.minimum, 1, 'minimum 应透传');
  assert.equal(retries.maximum, 9, 'maximum 应透传');
  assert.equal(retries.unit, '次', 'unit 应透传');
  assert.equal(fieldOf(model, 'verbose').kind, 'switch', 'boolean 字段 kind 为 switch');
});

test('arrays of scalars become string lists, arrays of objects recurse children', () => {
  const tags = buildFormModel({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 50 } } });
  const tagsField = fieldOf(tags, 'tags');
  assert.equal(tagsField.kind, 'string-list', '标量数组 → 胶囊列表');
  assert.equal(tagsField.itemKind, 'string', 'itemKind 应为 string');
  assert.equal(tagsField.maxItems, 20, '数组项上限 20，schema 声明的 50 被收紧');

  const jobs = buildFormModel({
    type: 'object',
    properties: {
      jobs: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, cmd: { type: 'string' } }, required: ['name'] },
      },
    },
  });
  const jobsField = fieldOf(jobs, 'jobs');
  assert.equal(jobsField.kind, 'object-list', '对象数组 → 子卡列表');
  assert.equal(jobsField.itemKind, 'object', 'itemKind 应为 object');
  assert.deepEqual(jobsField.children.map(child => child.path), ['jobs[0].name', 'jobs[0].cmd'], '子字段路径带 [0] 模板');
  assert.equal(jobsField.children[0].depth, 1, '子字段深度 +1');
  assert.equal(jobsField.children[0].required, true, '项内 required 应透传');
});

test('nested objects recurse, additionalProperties becomes key-value rows', () => {
  assert.equal(describeFieldType({ type: 'object', properties: { a: { type: 'string' } } }), 'object', '带 properties 的对象是分组节点');
  assert.equal(describeFieldType({ type: 'object', additionalProperties: { type: 'string' } }), 'key-value', '只有 additionalProperties → 键值行');
  assert.equal(describeFieldType({ type: 'object' }), 'unsupported', '空对象没有可填字段');

  const model = buildFormModel({
    type: 'object',
    properties: {
      policy: { type: 'object', properties: { name: { type: 'string' } } },
      env: { type: 'object', additionalProperties: { type: 'string' } },
    },
  });
  const policy = fieldOf(model, 'policy');
  assert.equal(policy.kind, 'object', '嵌套对象 kind 为 object');
  assert.deepEqual(policy.children.map(child => child.path), ['policy.name'], '嵌套字段路径用点号连接');
  assert.equal(fieldOf(model, 'env').kind, 'key-value', '键值对字段 kind 为 key-value');
});

test('enum containing null marks allowNull and keeps null out of options', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { speed: { type: 'string', enum: ['fast', 'slow', null], title: '速度' } },
  });
  const field = fieldOf(model, 'speed');
  assert.equal(field.allowNull, true, 'enum 含 null 应置 allowNull');
  assert.deepEqual(field.enumValues, ['fast', 'slow'], 'null 不进选项列表');
  assert.equal(field.kind, 'segment', '去掉 null 后 2 项仍走分段');
  assert.deepEqual(collectContent(model.fields, { speed: null }), { speed: null }, '显式留空应回填 null');
  assert.equal(validateForm(model.fields, { speed: null }).ok, true, '留空不应报错');
});

test('external $ref and format:file are unsupported without degrading the form', () => {
  assert.equal(describeFieldType({ $ref: 'https://example.com/schema.json' }), 'unsupported', '外链 $ref 不支持');
  assert.equal(describeFieldType({ type: 'string', format: 'file' }), 'unsupported', 'format:file 不支持');

  const model = buildFormModel({
    type: 'object',
    properties: {
      attachment: { type: 'string', format: 'file', title: '附件' },
      name: { type: 'string', title: '名称' },
    },
    required: ['attachment', 'name'],
  });
  const unsupported = fieldOf(model, 'attachment');
  assert.equal(model.kind, 'form', '单个不支持字段不应整体降级');
  assert.equal(unsupported.kind, 'unsupported', '不支持字段 kind 为 unsupported');
  assert.match(unsupported.unsupportedReason, /文件|终端/, '不支持字段要给出可读原因');
  const result = validateForm(model.fields, { name: 'demo' });
  assert.equal(result.ok, true, '不可填字段不应阻断其余提交');
  assert.deepEqual(collectContent(model.fields, { name: 'demo', attachment: 'x' }), { name: 'demo' }, '不支持字段不进回填内容');
});

/* ---------------------------------------------------------------- 校验 */

test('required field missing reports a Chinese sentence', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { name: { type: 'string', title: '名称' }, note: { type: 'string', title: '备注' } },
    required: ['name'],
  });
  const empty = validateForm(model.fields, {});
  assert.equal(empty.ok, false, '必填缺失应校验失败');
  assert.deepEqual(empty.errors, [{ path: 'name', message: '名称不能为空' }], '错误应指向必填字段并用 title 拼句子');
  assert.equal(validateForm(model.fields, { name: 'x' }).ok, true, '填上后应通过');
  assert.equal(validateForm(model.fields, { name: '   ' }).ok, false, '纯空白视同未填');
});

test('minLength and maxLength both bound string fields', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { name: { type: 'string', minLength: 2, maxLength: 4, title: '名称' } },
  });
  const tooShort = validateForm(model.fields, { name: 'a' });
  assert.deepEqual(tooShort.errors, [{ path: 'name', message: '名称至少 2 个字符' }], '下界应报错');
  const tooLong = validateForm(model.fields, { name: 'abcde' });
  assert.deepEqual(tooLong.errors, [{ path: 'name', message: '名称最多 4 个字符' }], '上界应报错');
  assert.equal(validateForm(model.fields, { name: 'abc' }).ok, true, '界内应通过');
});

test('number bounds are enforced and integers reject decimals', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1, maximum: 10, title: '数量' } },
  });
  assert.equal(validateForm(model.fields, { count: 1.5 }).ok, false, 'integer 不接受小数');
  assert.match(validateForm(model.fields, { count: 1.5 }).errors[0].message, /整数/, '小数错误应说明需要整数');
  assert.match(validateForm(model.fields, { count: 0 }).errors[0].message, /不能小于 1/, '下界应报错');
  assert.match(validateForm(model.fields, { count: 11 }).errors[0].message, /不能大于 10/, '上界应报错');
  assert.equal(validateForm(model.fields, { count: '3' }).ok, true, '数字字符串按数字处理');
  assert.equal(validateForm(model.fields, { count: 3 }).ok, true, '界内整数应通过');
});

test('array minItems and maxItems are enforced', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, title: '标签' } },
    required: ['tags'],
  });
  assert.deepEqual(validateForm(model.fields, {}).errors, [{ path: 'tags', message: '标签不能为空' }], '必填数组为空应报空');
  assert.match(validateForm(model.fields, { tags: ['a'] }).errors[0].message, /至少 2 项/, '低于 minItems 应报错');
  assert.match(validateForm(model.fields, { tags: ['a', 'b', 'c', 'd'] }).errors[0].message, /最多 3 项/, '超过 maxItems 应报错');
  assert.equal(validateForm(model.fields, { tags: ['a', 'b'] }).ok, true, '界内应通过');
});

test('an invalid pattern is ignored with a warning instead of throwing', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { code: { type: 'string', pattern: '[', title: '编码' } },
  });
  let result;
  assert.doesNotThrow(() => { result = validateForm(model.fields, { code: 'anything' }); }, 'pattern 编译失败不得抛出');
  assert.equal(result.ok, true, '非法 pattern 应被忽略');
  assert.equal(result.warnings.length, 1, '非法 pattern 要记一条 warning');
  assert.match(result.warnings[0].message, /无法编译/, 'warning 要说明规则被忽略');
});

test('a valid pattern still rejects mismatching values', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { slug: { type: 'string', pattern: '^[a-z0-9-]+$', title: '标识' } },
  });
  assert.deepEqual(validateForm(model.fields, { slug: 'Bad Name' }).errors, [{ path: 'slug', message: '标识格式不正确' }], '不匹配应报格式错误');
  assert.equal(validateForm(model.fields, { slug: 'good-name-1' }).ok, true, '匹配应通过');
});

test('key-value rows reject duplicate keys and ignore empty keys', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { env: { type: 'object', additionalProperties: { type: 'string' }, title: '环境变量' } },
  });
  const dup = validateForm(model.fields, { env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] });
  assert.equal(dup.ok, false, '重复键应校验失败');
  assert.deepEqual(dup.errors, [{ path: 'env.A', message: '键重复：A' }], '重复键错误应带键名');

  const content = collectContent(model.fields, { env: [{ key: '  ', value: 'x' }, { key: 'A', value: '1' }] });
  assert.deepEqual(content, { env: { A: '1' } }, '键为空的行应被忽略');
  assert.equal(validateForm(model.fields, { env: [{ key: '', value: 'x' }] }).ok, true, '只有空键时可选字段仍视为未填');

  const required = buildFormModel({
    type: 'object',
    properties: { env: { type: 'object', additionalProperties: { type: 'string' }, title: '环境变量' } },
    required: ['env'],
  });
  assert.deepEqual(validateForm(required.fields, { env: [{ key: '', value: 'x' }] }).errors, [{ path: 'env', message: '环境变量不能为空' }], '必填键值对全为空键应报空');
});

/* ---------------------------------------------------------------- 回填 */

test('collectContent drops empty optional fields and keeps declared types', () => {
  const model = buildFormModel({
    type: 'object',
    properties: {
      name: { type: 'string' },
      note: { type: 'string' },
      retries: { type: 'number' },
      verbose: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
  });
  const content = collectContent(model.fields, { name: 'build', note: '', retries: '3', verbose: false, extra: 'nope' });
  assert.deepEqual(content, { name: 'build', retries: 3, verbose: false }, '空可选字段与声明外键都不应出现');
  assert.equal(content.note, undefined, '未填的可选字段不出现（不发 null）');
  assert.equal(typeof content.retries, 'number', '数字保持 number');
  assert.equal(typeof content.verbose, 'boolean', '布尔保持 boolean');
  assert.deepEqual(collectContent(model.fields, { name: 'x', tags: ['a', '', 'b'] }), { name: 'x', tags: ['a', 'b'] }, '列表保持顺序并丢弃空项');
});

test('collectContent rebuilds nested objects and object arrays', () => {
  const model = buildFormModel({
    type: 'object',
    properties: {
      policy: { type: 'object', properties: { name: { type: 'string' }, owner: { type: 'string' } } },
      jobs: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, cmd: { type: 'string' } } },
      },
    },
  });
  const content = collectContent(model.fields, {
    policy: { name: 'strict' },
    jobs: [{ name: 'build', cmd: 'npm run build' }, { name: 'test' }, {}],
  });
  assert.deepEqual(content, { policy: { name: 'strict' }, jobs: [{ name: 'build', cmd: 'npm run build' }, { name: 'test' }] }, '嵌套结构与空项应被正确整理');
});

/* ---------------------------------------------------------------- 状态 */

test('createFormState keeps only declared keys', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { name: { type: 'string' }, jobs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } },
  });
  const state = createFormState(model.fields, { name: 'draft', extra: 1, jobs: [{ name: 'build', nope: 2 }] });
  assert.deepEqual(state.values, { name: 'draft', jobs: [{ name: 'build' }] }, '只有 schema 声明过的键进入状态');
  assert.deepEqual(createFormState(model.fields).values, {}, '无初值时状态为空');
});

test('setFieldValue is immutable and writes nested array paths', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { jobs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, cmd: { type: 'string' } } } } },
  });
  const state = createFormState(model.fields);
  const one = setFieldValue(state, 'jobs[0].name', 'build');
  const two = setFieldValue(one, 'jobs[0].cmd', 'npm run build');
  assert.deepEqual(state.values, {}, '原 state 不得被修改');
  assert.deepEqual(one.values, { jobs: [{ name: 'build' }] }, '第一次写入应建出数组与对象');
  assert.deepEqual(two.values, { jobs: [{ name: 'build', cmd: 'npm run build' }] }, '第二次写入应保留同项其它值');
  assert.notEqual(one.values, two.values, '必须返回新的 values 引用');
  const cleared = setFieldValue(two, 'jobs[0].cmd', undefined);
  assert.deepEqual(cleared.values, { jobs: [{ name: 'build' }] }, '传 undefined 表示清除该键');
});

test('countMissing counts required fields across nesting', () => {
  const model = buildFormModel({
    type: 'object',
    properties: {
      name: { type: 'string', title: '名称' },
      note: { type: 'string', title: '备注' },
      jobs: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
    },
    required: ['name', 'jobs'],
  });
  assert.equal(countMissing(model.fields, {}), 2, '未填时应统计 name 与 jobs 两项');
  assert.equal(countMissing(model.fields, { name: 'x', jobs: [{ cmd: 'a' }, {}] }), 1, '数组项内必填缺失也要统计');
  assert.equal(countMissing(model.fields, { name: 'x', jobs: [{ cmd: 'a' }], note: '' }), 0, '可选字段为空不计入');
});

/* ---------------------------------------------------------------- 降级 */

test('more than 40 fields degrades the whole form', () => {
  const properties = {};
  for (let i = 0; i < 41; i += 1) properties[`field${i}`] = { type: 'string' };
  const model = buildFormModel({ type: 'object', properties });
  assert.equal(model.kind, 'degraded', '超出 40 字段应整体降级');
  assert.match(model.degradedReason, /字段过多/, '降级原因应说明字段过多');
  assert.equal(model.stats.fields, 40, '建模在 40 个字段处停止');
  assert.equal(model.fields.length, 40, '返回的字段数被封顶');
});

test('nesting deeper than 5 levels degrades the form', () => {
  const okModel = buildFormModel(nestedSchema(5));
  assert.equal(okModel.kind, 'form', '5 层嵌套仍在允许范围内');
  assert.equal(okModel.stats.depth, 4, '5 层嵌套的最深字段 depth 为 4');

  const model = buildFormModel(nestedSchema(7));
  assert.equal(model.kind, 'degraded', '超过 5 层应整体降级');
  assert.match(model.degradedReason, /嵌套过深/, '降级原因应说明嵌套过深');
  assert.equal(model.stats.depth, 5, '深度统计停在 5');
  const deepest = model.fields[0].children[0].children[0].children[0].children[0].children[0];
  assert.match(deepest.unsupportedReason, /嵌套过深/, '被截断的节点要标出原因');

  const tight = buildFormModel(nestedSchema(3), { maxDepth: 1 });
  assert.equal(tight.kind, 'degraded', '自定义 maxDepth 也应生效');
});

test('schema larger than 64KB degrades the form', () => {
  const model = buildFormModel({
    type: 'object',
    properties: { note: { type: 'string', description: 'x'.repeat(70 * 1024) } },
  });
  assert.equal(model.kind, 'degraded', '超过 64KB 应整体降级');
  assert.match(model.degradedReason, /schema 过大/, '降级原因应说明 schema 过大');
  assert.ok(model.stats.bytes > 65536, '字节统计应反映真实体积');
});

test('non-object root and byte stats are reported as degraded', () => {
  const model = buildFormModel({ type: 'string' });
  assert.equal(model.kind, 'degraded', '根节点不是对象时无法渲染表单');
  assert.equal(model.fields.length, 0, '降级时不给字段');
  assert.equal(model.stats.fields, 0, '降级时字段统计为 0');
});
