/**
 * 统一文本规范化与截断工具（领域层共享）。
 * 情感统计、化石引文与报告文本共用同一输入口径，
 * 避免特殊字符、换行与混合编码导致乱码或结构破坏。
 */

/** 规范化任意输入文本：去 BOM、统一换行为 \n、剔除控制/零宽字符、NFC 归一混合编码 */
export function normalizeText(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .normalize('NFC');
}

/** 将多行文本压缩为单行（换行与连续空白折叠为一个空格） */
export function flattenWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** 按 Unicode 码点统计长度（emoji 等代理对计为 1，与展示口径一致） */
export function countChars(input: string): number {
  return Array.from(input).length;
}

/**
 * 码点安全截断：不会截断 emoji/代理对产生乱码，
 * 超长引用统一折叠空白后追加省略号。
 */
export function truncateQuote(input: string, maxLength: number): string {
  const flat = flattenWhitespace(normalizeText(input));
  const chars = Array.from(flat);
  if (chars.length <= maxLength) return flat;
  return chars.slice(0, maxLength).join('') + '…';
}
