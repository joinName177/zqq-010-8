import { ChatMessage } from '../core/models';
import { ChatParserPort } from '../ports/chat-parser.port';
import { normalizeText, countChars } from '../core/text-utils';

/** 日期解析守卫：无效日期回退到上一条有效时间，避免异常数据进入统计 */
function toSafeDate(raw: string, fallback: Date): Date {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
}

export class UniversalChatParserAdapter implements ChatParserPort {
  async parse(rawText: string): Promise<ChatMessage[]> {
    // 统一编码与换行：去 BOM/控制字符、\r\n 与 \r 归一为 \n、NFC 归一
    const lines = normalizeText(rawText).split('\n').map(l => l.trim()).filter(Boolean);
    const messages: ChatMessage[] = [];

    // Regex patterns for WeChat, QQ, SMS
    // WeChat: 2023-08-12 21:04:12 张三
    const wechatPattern = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*?)(?::|：)?$/;
    // QQ: 2023-08-12 21:04:12 张三(123456)
    const qqPattern = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*?)\(\d+\)$/;
    // SMS / simple: [2023-08-12 21:04] 张三: 内容
    const bracketPattern = /^\[?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^:：]+)[：:](.*)$/;

    let currentSender = '发件人';
    let currentTimestamp = new Date();
    let currentContent: string[] = [];

    const flush = () => {
      if (currentContent.length > 0) {
        const text = currentContent.join('\n').trim();
        if (text) {
          messages.push({
            id: `msg-${messages.length + 1}`,
            timestamp: new Date(currentTimestamp),
            sender: currentSender,
            content: text,
            sentimentScore: 0,
            wordCount: countChars(text)
          });
        }
        currentContent = [];
      }
    };

    for (const line of lines) {
      // Check bracket pattern
      const bMatch = line.match(bracketPattern);
      if (bMatch) {
        flush();
        currentTimestamp = toSafeDate(bMatch[1], currentTimestamp);
        currentSender = bMatch[2].trim();
        currentContent.push(bMatch[3].trim());
        continue;
      }

      // Check QQ pattern
      const qMatch = line.match(qqPattern);
      if (qMatch) {
        flush();
        currentTimestamp = toSafeDate(qMatch[1], currentTimestamp);
        currentSender = qMatch[2].trim();
        continue;
      }

      // Check WeChat header pattern
      const wMatch = line.match(wechatPattern);
      if (wMatch) {
        flush();
        currentTimestamp = toSafeDate(wMatch[1], currentTimestamp);
        currentSender = wMatch[2].trim();
        continue;
      }

      // If JSON format
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const parsed = JSON.parse(line);
          const jsonContent = parsed.content ?? parsed.message ?? parsed.text;
          if (jsonContent !== undefined && jsonContent !== null && jsonContent !== '') {
            flush();
            const content = normalizeText(String(jsonContent));
            messages.push({
              id: `msg-${messages.length + 1}`,
              timestamp: parsed.timestamp ? toSafeDate(String(parsed.timestamp), currentTimestamp) : new Date(currentTimestamp),
              sender: normalizeText(String(parsed.sender ?? parsed.user ?? '未知者')).trim() || '未知者',
              content,
              sentimentScore: 0,
              wordCount: countChars(content)
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
        const parts = line.split(/[:：]/);
        const sender = parts.length > 1 ? parts[0] : (idx % 2 === 0 ? '挖掘目标A' : '挖掘目标B');
        const content = parts.length > 1 ? parts.slice(1).join(':') : line;
        messages.push({
          id: `msg-${idx + 1}`,
          timestamp: new Date(now - (lines.length - idx) * 86400000 * 3),
          sender: sender.trim(),
          content: content.trim(),
          sentimentScore: 0,
          wordCount: countChars(content)
        });
      });
    }

    return messages;
  }
}
