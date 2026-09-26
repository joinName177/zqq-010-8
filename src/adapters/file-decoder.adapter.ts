/**
 * 统一文件解码适配器：按 BOM 与字节内容探测编码，
 * 兼容 UTF-8 / UTF-16 与 GBK / GB18030 导出的聊天记录，避免混合编码产生乱码。
 */
export async function decodeChatFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // BOM 检测：UTF-8 / UTF-16LE / UTF-16BE
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // 无 BOM：优先严格 UTF-8，解码失败则回退 GB18030（兼容 GBK / GB2312 中文导出文件）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}
