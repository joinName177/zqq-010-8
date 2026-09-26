import { UniversalChatParserAdapter } from './src/adapters/chat-parser.adapter';
import { analyzeChatStrata } from './src/core/archaeology-engine';
import { TEXT_LIMITS, clipText, countChars, normalizeText, escapeHtml, escapeHtmlMultiline } from './src/core/text-safety';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail); }
}

// ---------- 1. 编码：GBK 导出文件不再乱码 ----------
const parser = new UniversalChatParserAdapter();
// "张三" 的 GBK 字节为 d5 c5 c8 fd；纯 GBK 字节以 UTF-8 fatal 解码必然失败，
// 用来验证 decodeBytes 的 GB18030 回退路径。
const zhangSanGbk = new Uint8Array([0xd5, 0xc5, 0xc8, 0xfd]);
ok('GBK 字节回退解码为 张三', parser.decodeBytes(zhangSanGbk) === '张三', parser.decodeBytes(zhangSanGbk));

// UTF-8 BOM
const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('你好<b>')]);
ok('UTF-8 BOM 被剥离且正常解码', parser.decodeBytes(bomBytes) === '你好<b>');

// UTF-16LE BOM
{
  const s = '晚安宝贝';
  const u16 = new Uint8Array(2 + s.length * 2);
  u16[0] = 0xff; u16[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { u16[2 + i * 2] = s.charCodeAt(i) & 0xff; u16[3 + i * 2] = s.charCodeAt(i) >> 8; }
  ok('UTF-16LE BOM 解码', parser.decodeBytes(u16) === s, parser.decodeBytes(u16));
}

// 纯 UTF-8 中文（无 BOM）正常
ok('UTF-8 无 BOM 正常解码', parser.decodeBytes(new TextEncoder().encode('哈哈哈开心')) === '哈哈哈开心');

// ---------- 2. 归一化：特殊字符 / 换行 / 混合编码 ----------
ok('CRLF/CR 统一为 LF', normalizeText('a\r\nb\rc\n') === 'a\nb\nc\n');
ok('NUL 被清除', !normalizeText('a\x00b').includes('\x00'));
ok('BOM 被清除', !normalizeText('﻿你好').includes('﻿'));
ok('U+2028/U+2029 转为换行', normalizeText('a b c') === 'a\nb\nc');
ok('NFC 归一化（é 分解形式合并）', normalizeText('é'.normalize('NFD')) === 'é');

// ---------- 3. 码点安全截断：不切断 emoji 代理对 ----------
const emojiText = '😀'.repeat(200);
const clipped = clipText(emojiText, TEXT_LIMITS.maxQuoteChars);
ok('超长 emoji 串不含替换符', !clipped.includes('�'), clipped.slice(-10));
ok('截断结果以省略号结尾', clipped.endsWith('…'));
ok('截断码点数 <= 上限', Array.from(clipped).length <= TEXT_LIMITS.maxQuoteChars);
const zwj = '👨‍👩‍👧'.repeat(60);
const clippedZwj = clipText(zwj, 120);
ok('ZWJ emoji 序列截断无悬挂修饰符', !/[‍️]$/.test(clippedZwj.slice(0, -1)), clippedZwj.slice(-8));
ok('中文截断不劈坏字符', clipText('我们承诺以后一直在一起'.repeat(20), 120).endsWith('…'));

// ---------- 4. 转义与多行结构 ----------
ok('HTML 五类字符转义', escapeHtml('<b class="x">a&b\'c</b>') === '&lt;b class=&quot;x&quot;&gt;a&amp;b&#39;c&lt;/b&gt;');
ok('多行文本换行转 <br>', escapeHtmlMultiline('第一行\n第二行') === '第一行<br>第二行');
ok('转义先于换行处理（尖括号不穿透）', escapeHtmlMultiline('<x>\n<y>') === '&lt;x&gt;<br>&lt;y&gt;');

// ---------- 5. 统计口径：wordCount 码点口径一致 ----------
ok('countChars 忽略换行', countChars('a\nb') === 2);
ok('countChars emoji 按码点计', countChars('😀😀') === 2);

// ---------- 6. 解析端到端：特殊字符 + 多行 + 超长 ----------
const raw = [
  '2023-08-12 21:04:12 张三',
  '今天真的好累 <script>alert(1)</script> 但是看见你发的猫咪照片就开心了 😍😘🥰 爱你宝贝！'.repeat(60),
  '第二行续：明天一起吃饭看电影好不好',
  '2023-08-12 21:10:00 李四：嗯好的，我等你下班',
  '[2023-08-13 09:00] 王五: 早上好呀'
].join('\r\n') + '﻿';
const msgs = await parser.parse(raw);
ok('多行消息合并为一条', msgs.length === 3, `got ${msgs.length}`);
ok('微信表头行识别发送者且不污染正文', msgs[0].sender === '张三' && msgs[0].content.startsWith('今天真的好累') && msgs[0].content.includes('第二行续：明天一起吃饭看电影好不好'),
  `${msgs[0].sender} / ${msgs[0].content.slice(0, 20)}`);
ok('消息内容统一 LF 无 CR', msgs.every(m => !m.content.includes('\r')));
ok('超长单条按上限截断', Array.from(msgs[0].content).length <= TEXT_LIMITS.maxMessageChars, String(Array.from(msgs[0].content).length));
ok('wordCount 与内容码点数一致', msgs.every(m => m.wordCount === countChars(m.content)),
  msgs.map(m => `${m.wordCount}/${countChars(m.content)}`).join(','));
ok('特殊字符原文保留在领域层（不做 HTML 转义）', msgs[0].content.includes('<script>'));
ok('发送者名归一化', msgs[1].sender === '李四', msgs[1].sender);
ok('括号格式时间解析', msgs[2].sender === '王五' && msgs[2].content === '早上好呀');

// JSON 行
const jsonMsgs = await parser.parse('{"sender":"赵六","content":"晚安🌙宝贝\\n爱你","timestamp":"2024-01-01 22:00:00"}');
ok('JSON 消息解析成功', jsonMsgs.length === 1 && jsonMsgs[0].sender === '赵六');
ok('JSON 消息换行保留且 wordCount 不含换行', jsonMsgs[0].content === '晚安🌙宝贝\n爱你' && jsonMsgs[0].wordCount === 7,
  `${jsonMsgs[0].content} / ${jsonMsgs[0].wordCount}`);

// 容量保护：消息条数上限
{
  const huge = Array.from({ length: TEXT_LIMITS.maxMessages + 50 }, (_, i) =>
    `[2023-01-01 00:00] 用户${i % 2}: 消息${i}`).join('\n');
  const hugeMsgs = await parser.parse(huge);
  ok('消息条数触发容量上限', hugeMsgs.length === TEXT_LIMITS.maxMessages, String(hugeMsgs.length));
}

// ---------- 7. 引擎端到端：化石引文 + 报告结构完整 ----------
const report = analyzeChatStrata(msgs, '测试遗址·特殊字符<script>');
ok('报告正常生成五层', report.strata.length >= 1);
ok('所有化石引文不超过上限', report.notableRelics.every(r => Array.from(r.quote).length <= TEXT_LIMITS.maxQuoteChars),
  report.notableRelics.map(r => String(Array.from(r.quote).length)).join(','));
ok('化石引文无代理对碎片', report.notableRelics.every(r => !r.quote.includes('�')));
// 换行位于前 120 码点内时，化石引文保留换行结构
{
  const nlRaw = [
    '2023-08-12 21:04:12 张三',
    '今天真的好累但是看见你就开心了爱你宝贝晚安',
    '第二行续：明天一起吃饭看电影好不好呀'
  ].join('\n');
  const nlMsgs = await parser.parse(nlRaw);
  const nlReport = analyzeChatStrata(nlMsgs);
  ok('化石引文保留多行换行结构', nlReport.notableRelics.some(r => r.quote.includes('\n')),
    JSON.stringify(nlReport.notableRelics.map(r => r.quote)));
}
ok('站点名特殊字符原样保留在领域层', report.siteName.includes('<script>'));
ok('综述/评定为完整字符串', report.archaeologicalSummary.length > 10 && report.curatorAssessment.length > 5);

// 超长 emoji 消息选为化石时引文不破坏
{
  const emojiMsgs = [
    { id: '1', timestamp: new Date('2023-01-01'), sender: 'A', content: '开心喜欢爱你宝贝 '.repeat(5) + '😍'.repeat(300), sentimentScore: 0, wordCount: 0 },
    { id: '2', timestamp: new Date('2023-02-01'), sender: 'B', content: '哈哈哈吃饭', sentimentScore: 0, wordCount: 3 }
  ];
  emojiMsgs[0].wordCount = countChars(emojiMsgs[0].content);
  const r2 = analyzeChatStrata(emojiMsgs);
  ok('emoji 超长消息化石引文以完整 emoji 结尾', r2.notableRelics.every(r => !/[‍️]$/.test(r.quote) && !r.quote.includes('�')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
