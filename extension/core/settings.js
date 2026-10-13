export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  granularity: 'balanced',
  lockedBookmarkUrls: Object.freeze([]),
  lockedFolderPaths: Object.freeze([]),
  rules: Object.freeze([]),
  overrides: Object.freeze([]),
});

const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function objectWithFields(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label}字段不符合允许的 schema`);
  }
}

function text(value, label, { empty = false, max = 4096, trim = false } = {}) {
  if (typeof value !== 'string' || value.length > max || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${label}必须是长度合适且不含控制字符的文本`);
  }
  const result = trim ? value.trim() : value;
  if (!empty && !result.trim()) throw new TypeError(`${label}不能为空`);
  return result;
}

function literalUrl(value) {
  const result = text(value, '网址', { max: 16384 });
  if (result !== result.trim()) throw new TypeError('网址不能包含首尾空白');
  let parsed;
  try { parsed = new URL(result); } catch { throw new TypeError('网址格式无效'); }
  if (parsed.username || parsed.password) throw new TypeError('网址不能包含登录凭据');
  // Never return parsed.href: bookmark URLs remain byte-for-byte identical.
  return result;
}

function list(value, label, max = 10000) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label}必须是长度合适的数组`);
  return value;
}

function domain(value) {
  const pattern = text(value, '规则域名', { max: 253, trim: true }).toLowerCase();
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})*$`, 'u').test(pattern)) {
    throw new TypeError('规则域名必须是完整主机名，不含协议、路径、端口或通配符');
  }
  return pattern;
}

export function validateSettings(value) {
  objectWithFields(value, SETTINGS_FIELDS, [], '设置');
  if (value.version !== 1) throw new TypeError('不支持的设置版本 version');
  if (!['few', 'balanced', 'many'].includes(value.granularity)) throw new TypeError('分类粒度 granularity 无效');
  const result = {
    version: 1,
    granularity: value.granularity,
    lockedBookmarkUrls: list(value.lockedBookmarkUrls, '锁定网址').map(literalUrl),
    lockedFolderPaths: list(value.lockedFolderPaths, '锁定文件夹路径').map((path) => {
      if (!Array.isArray(path) || path.length === 0 || path.length > 100) throw new TypeError('文件夹路径必须是非空字符串数组');
      return path.map((segment) => text(segment, '文件夹路径'));
    }),
    rules: list(value.rules, '规则', 5000).map((rule) => {
      objectWithFields(rule, ['type', 'pattern', 'category'], [], '规则');
      if (!['domain', 'keyword'].includes(rule.type)) throw new TypeError('规则 type 无效');
      return {
        type: rule.type,
        pattern: rule.type === 'domain' ? domain(rule.pattern) : text(rule.pattern, '规则关键词', { max: 512, trim: true }),
        category: text(rule.category, '规则分类', { max: 80, trim: true }),
      };
    }),
    overrides: list(value.overrides, '人工选择 override').map((override) => {
      objectWithFields(override, ['url'], ['title', 'category'], '人工选择 override');
      if (!Object.hasOwn(override, 'title') && !Object.hasOwn(override, 'category')) throw new TypeError('人工选择必须包含标题或分类');
      const item = { url: literalUrl(override.url) };
      if (Object.hasOwn(override, 'title')) item.title = text(override.title, '人工标题', { max: 200 });
      if (Object.hasOwn(override, 'category')) item.category = text(override.category, '人工分类', { max: 80, trim: true });
      return item;
    }),
  };
  const overrideUrls = new Set();
  for (const override of result.overrides) {
    if (overrideUrls.has(override.url)) throw new TypeError('人工选择网址不能重复');
    overrideUrls.add(override.url);
  }
  return result;
}

export function exportSettings(settings) {
  return JSON.stringify(validateSettings(settings), null, 2);
}

export function importSettings(value) {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 2_000_000) throw new TypeError('设置 JSON 文件过大');
    try { parsed = JSON.parse(value); } catch { throw new TypeError('设置 JSON 格式无效'); }
  }
  return validateSettings(parsed);
}
