/**
 * 统一文本安全口径（核心领域层，无外部依赖）
 *
 * 供解析适配器、地层分析引擎与 UI 共用，保证：
 * - 混合编码 / 特殊字符进入领域模型前统一为 NFC + LF
 * - HTML 转义只有一份实现
 * - 超长引用按 Unicode 码点（而非 UTF-16 码元）截断，不切断 emoji 代理对
 * - 字数统计、容量上限使用同一口径
 */

/** 容量保护：文件、消息数、单条文本、化石引文的统一上限 */
export const TEXT_LIMITS = {
  /** 导入文件最大字节数（10 MiB） */
  maxFileBytes: 10 * 1024 * 1024,
  /** 单次勘探最多保留的消息条数（超出时丢弃最新尾部） */
  maxMessages: 20000,
  /** 单条消息归一化后的最大码点数（超出截断） */
  maxMessageChars: 5000,
  /** 对话化石引文展示的最大码点数 */
  maxQuoteChars: 120
} as const;

const NUL_RE = /\x00/g;
// U+2028 / U+2029 是合法 JSON 字符串字符但会破坏脚本与文本结构
const LINE_SEP_RE = /[\u2028\u2029]/g;
const BOM_RE = /\uFEFF/g;
const EDGE_WS_RE = /^[\s\uFEFF]+|[\s\uFEFF]+$/g;

/**
 * 统一文本归一化：
 * 1. 非字符串强制转为字符串
 * 2. 去除 NUL / BOM / U+2028 / U+2029 等结构破坏字符
 * 3. CRLF / CR 统一为 LF
 * 4. Unicode NFC 归一化，混合编码下的同形字符只保留一种形态
 */
export function normalizeText(input: unknown): string {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : String(input);
  text = text.replace(BOM_RE, '');
  text = text.replace(NUL_RE, '');
  text = text.replace(LINE_SEP_RE, '\n');
  text = text.replace(/\r\n?/g, '\n');
  text = text.normalize('NFC');
  return text;
}

/**
 * 归一化单行文本并折叠空白（用于发送者等不应保留换行的字段）。
 */
export function normalizeInline(input: unknown): string {
  return normalizeText(input).replace(/\s+/g, ' ').trim();
}

/**
 * 归一化多行内容，保留内部换行结构，只清理整体首尾空白与 BOM。
 */
export function normalizeContent(input: unknown): string {
  return normalizeText(input).replace(EDGE_WS_RE, '');
}

/**
 * 按 Unicode 码点统计长度，换行不计入字数。
 * 按迭代器展开可正确处理 emoji 与星面字符，不会像 str.length 那样
 * 把代理对中的单个字符重复计数。
 */
export function countChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch !== '\n') count++;
  }
  return count;
}

// 截断边界上可能悬挂的变体选择符 U+FE0F、ZWJ、肤色修饰符、组合记号
const DANGLING_TAIL_RE = /(?:\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|\p{Mn})+$/u;

/**
 * 按码点截断文本到 maxChars 以内，超长时附加省略号。
 * 截断后回收边界上的悬挂变体/组合修饰符，避免出现半个 emoji。
 */
export function clipText(input: string, maxChars: number): string {
  const text = normalizeText(input);
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) return text;
  const kept = codePoints.slice(0, Math.max(1, maxChars - 1)).join('');
  return kept.replace(DANGLING_TAIL_RE, '') + '…';
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
};

/** 唯一的 HTML 转义实现：先归一化，再转义五类结构字符 */
export function escapeHtml(input: unknown): string {
  return normalizeText(input).replace(/[&<>'"]/g, ch => HTML_ESCAPE_MAP[ch] ?? ch);
}

/**
 * 转义 HTML 并把换行转成 <br>，用于多行引文展示，保留原始换行结构。
 */
export function escapeHtmlMultiline(input: unknown): string {
  return escapeHtml(input).replace(/\n/g, '<br>');
}
