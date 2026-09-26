import { ChatMessage } from '../core/models';
import { ChatParserPort } from '../ports/chat-parser.port';
import {
  TEXT_LIMITS,
  countChars,
  clipText,
  normalizeContent,
  normalizeInline,
  normalizeText
} from '../core/text-safety';

// 除 \t \n \r 外的 C0 控制字符（微信导出偶发夹带的设备控制符等）
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export class UniversalChatParserAdapter implements ChatParserPort {
  /**
   * 统一编码入口：
   * - UTF-8 / UTF-16（LE/BE）BOM 优先嗅探
   * - 无 BOM 先按 UTF-8 严格解码；字节序列非法时
   *   回退 GB18030（Windows 微信/QQ 导出的常见编码，兼容 GBK / GB2312）
   */
  decodeBytes(bytes: Uint8Array): string {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return normalizeText(new TextDecoder('utf-8').decode(bytes.subarray(3)));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return normalizeText(new TextDecoder('utf-16le').decode(bytes.subarray(2)));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return normalizeText(new TextDecoder('utf-16be').decode(bytes.subarray(2)));
    }
    try {
      const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return normalizeText(utf8);
    } catch {
      // UTF-8 严格解码失败：回退 GB18030（可兼容 GBK / GB2312）
      try {
        return normalizeText(new TextDecoder('gb18030').decode(bytes));
      } catch {
        return normalizeText(new TextDecoder('utf-8').decode(bytes));
      }
    }
  }

  async parse(rawText: string): Promise<ChatMessage[]> {
    const normalized = normalizeText(rawText).replace(CONTROL_CHARS_RE, '');
    const lines = normalized
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const messages: ChatMessage[] = [];

    // Regex patterns for WeChat, QQ, SMS
    // WeChat: 2023-08-12 21:04:12 张三
    const wechatPattern = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*?)(?::|：)?$/;
    // QQ: 2023-08-12 21:04:12 张三(123456)
    const qqPattern = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*?)\(\d+\)$/;
    // SMS / simple: [2023-08-12 21:04] 张三: 内容
    const bracketPattern = /^\[?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:：]+)[：:](.*)$/;

    let currentSender = '发件人';
    let currentTimestamp: Date | null = null;
    let currentContent: string[] = [];

    const buildMessage = (timestamp: Date, sender: string, content: string): ChatMessage => {
      const safeContent = clipText(normalizeContent(content), TEXT_LIMITS.maxMessageChars);
      return {
        id: `msg-${messages.length + 1}`,
        timestamp,
        sender: normalizeInline(sender) || '未知者',
        content: safeContent,
        sentimentScore: 0,
        wordCount: countChars(safeContent)
      };
    };

    const flush = () => {
      if (currentContent.length === 0) return;
      const text = normalizeContent(currentContent.join('\n'));
      if (text) {
        messages.push(buildMessage(currentTimestamp ?? new Date(), currentSender, text));
      }
      currentContent = [];
    };

    for (const line of lines) {
      // Check bracket pattern
      const bMatch = line.match(bracketPattern);
      if (bMatch) {
        flush();
        currentTimestamp = parseTimestamp(bMatch[1]);
        currentSender = bMatch[2].trim();
        currentContent.push(bMatch[3].trim());
        continue;
      }

      // Check QQ pattern
      const qMatch = line.match(qqPattern);
      if (qMatch) {
        flush();
        currentTimestamp = parseTimestamp(qMatch[1]);
        currentSender = qMatch[2].trim();
        continue;
      }

      // Check WeChat header pattern
      // 注：带冒号且同行有正文的形式（张三: 内容）已在上面 bracket 分支消费；
      // 走到这里的是「时间 + 昵称」独立表头行（昵称尾部可能带冒号）。
      const wMatch = line.match(wechatPattern);
      if (wMatch) {
        flush();
        currentTimestamp = parseTimestamp(wMatch[1]);
        currentSender = wMatch[2].trim();
        continue;
      }

      // If JSON format
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const rawBody = parsed.content ?? parsed.message ?? parsed.text;
          if (typeof rawBody === 'string') {
            flush();
            const body = clipText(normalizeContent(rawBody), TEXT_LIMITS.maxMessageChars);
            messages.push({
              id: `msg-${messages.length + 1}`,
              timestamp: parsed.timestamp ? parseTimestamp(String(parsed.timestamp)) : new Date(),
              sender: normalizeInline(parsed.sender ?? parsed.user ?? '未知者'),
              content: body,
              sentimentScore: 0,
              wordCount: countChars(body)
            });
            continue;
          }
        } catch {
          // not json, continue
        }
      }

      // Otherwise regular dialogue line
      currentContent.push(line);
    }

    flush();

    // If still empty or no timestamps recognized, fallback to sequential mock dates
    if (messages.length === 0 && lines.length > 0) {
      const now = Date.now();
      lines.forEach((line, idx) => {
        const colonIdx = line.search(/[:：]/);
        let sender: string;
        let content: string;
        if (colonIdx > 0) {
          sender = line.slice(0, colonIdx);
          content = line.slice(colonIdx + 1);
        } else {
          sender = idx % 2 === 0 ? '挖掘目标A' : '挖掘目标B';
          content = line;
        }
        const safeContent = clipText(normalizeContent(content), TEXT_LIMITS.maxMessageChars);
        messages.push({
          id: `msg-${idx + 1}`,
          timestamp: new Date(now - (lines.length - idx) * 86400000 * 3),
          sender: normalizeInline(sender) || '未知者',
          content: safeContent,
          sentimentScore: 0,
          wordCount: countChars(safeContent)
        });
      });
    }

    // 容量保护：超过上限时保留最早的地层记录（基岩不可丢），丢弃最新尾部
    return messages.length > TEXT_LIMITS.maxMessages
      ? messages.slice(0, TEXT_LIMITS.maxMessages)
      : messages;
  }
}

/**
 * 统一日期解析：把 2023/8/12 或 2023.8.12 等分隔符规整为 ISO 形式，
 * 统一按本地时间构造 Date，避免各入口 new Date 口径不一。
 */
function parseTimestamp(raw: string): Date {
  const isoLike = raw.trim().replace(/[/.]/g, '-');
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
