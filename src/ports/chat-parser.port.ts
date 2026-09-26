import { ChatMessage } from '../core/models';

export interface ChatParserPort {
  /** 把导入文件的原始字节解码为统一（UTF-8 / NFC）文本 */
  decodeBytes(bytes: Uint8Array): string;
  parse(rawText: string): Promise<ChatMessage[]>;
}
