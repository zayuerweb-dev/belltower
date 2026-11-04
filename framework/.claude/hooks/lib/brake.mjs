// 刹车(派工刹车)的共用判据:闸门17(guard-mcp,派工那一刻)· 闸门14 记账的豁免(guard-edit)· scripts/brake.mjs 用这一份。
// 出处:装了框架的项目里,一夜之间 test 的门铃响了几十次、同一件东西一夜合了 8 轮 —— 环里没有「停」。
//   test 每验出一条就按门铃,dev 每收一条就开一轮,半夜没人看着也照转。三条规矩见 dispatch.md「刹车」。
// 全是纯函数(时区、号段这类从参数或 config 拿),失败返回空值,不抛 —— 调用方一律 fail-open。
// ★ 全角字一律码位拼(String.fromCharCode),不直接敲进正则:源码里看不出全角半角,敲错一个就悄悄只认一种。
import { config } from "./config.mjs";
import { ringLine } from "./doorbell.mjs";
import { wallParts } from "./now.mjs";

const CH = (...cs) => String.fromCharCode(...cs);

// ── 号:Q + 数字 + 可选 [a-z]+ + 可选 -数字;前面不紧挨字母数字,后面不紧挨字母、数字、`-` ──
// 所以 Q36 ≠ Q361 ≠ Q3610,Q361c-2 ≠ Q361c-20。基号 = Q + 数字。
const QNO = () => /(?<![A-Za-z0-9])Q(\d+)(?:[a-z]+(?:-\d+)?)?(?![A-Za-z0-9-])/g;
export const qNos = (text) => [...String(text ?? "").matchAll(QNO())].map((m) => ({ no: m[0], base: `Q${m[1]}`, digits: m[1] }));
export const baseOf = (q) => qNos(q)[0]?.base ?? null;

// 号段首位:config().ranges[board] 形如 "Q3xx" → "3";没配 / 认不出 → null。
export function rangeDigit(board, ranges = null) {
  try {
    const r = (ranges ?? config().ranges)?.[board];
    return String(r ?? "").match(/^Q(\d)/)?.[1] ?? null;
  } catch { return null; }
}
// 这次派的号:优先取派工塔自己号段的(首位数字对得上、至少三位;号段用完接四位也认),认不出塔就取第一个。
export function firstQ(text, digit = null) {
  const all = qNos(text);
  return (digit && all.find((q) => q.digits.length >= 3 && q.digits[0] === digit)) || all[0] || null;
}

// ── 轮:一次合进 origin/main 的交付 ──────────────────────────────────────────
// 两种合并都认:
//   squash:标题以 `(#数字)` 结尾 → 取标题里第一个号;
//   普通合并:标题 `Merge pull request #数字 …` → 取正文第一行(PR 标题)里第一个号。
// git log 用下面这个格式(记录之间 \x1e,标题与正文之间 \x1f;正文可能多行)。--first-parent:只看主干上那一串,
// 合进来的分支自己的提交不算交付。
export const LOG_ARGS = ["log", "--first-parent", "--format=%x1e%H%x09%ct%x09%s%x1f%b"];
// 返回按合进顺序(旧 → 新):{ q, base, pr, at(Date), sha(7 位), subject }
export function deliveries(logText) {
  const out = [];
  for (const rec of String(logText ?? "").split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, body = ""] = rec.split("\x1f");
    const [sha, ct, ...rest] = head.replace(/^\n+/, "").split("\t");
    const subject = rest.join("\t").trim();
    if (!ct || !/^\d+$/.test(ct)) continue;
    let pr = subject.match(/\(#(\d+)\)$/), q = null;
    if (pr) q = qNos(subject)[0];
    else if ((pr = subject.match(/^Merge pull request #(\d+)\b/))) {
      const title = String(body).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      q = qNos(title)[0];
    }
    if (pr && q) out.push({ q: q.no, base: q.base, pr: Number(pr[1]), at: new Date(Number(ct) * 1000), sha: String(sha).slice(0, 7), subject });
  }
  return out.reverse();
}

// ── 家:基号相同;任务书里含「返工自 Qnnn」的行把那几家并进来 ───────────────────
export const reworkBases = (text) => [...new Set(String(text ?? "").split("\n")
  .flatMap((l) => { const i = l.indexOf("返工自"); return i < 0 ? [] : qNos(l.slice(i)).map((q) => q.base); }))];
// 这一家已合的不同号(按第一次合进排)+ 再派 q 是第几轮。轮次 = 已合的不同号 ∪ 这次的号。
export function familyRounds(q, bases, dels) {
  const fam = new Set([baseOf(q), ...(bases ?? [])].filter(Boolean));
  const merged = [], seen = new Set();
  for (const d of dels ?? []) if (fam.has(d.base) && !seen.has(d.q)) { seen.add(d.q); merged.push(d); }
  return { family: [...fam], merged, round: merged.length + (q && !seen.has(q) ? 1 : 0) };
}

// ── 记号:〔攒批〕〔待用户〕;左括号认 U+3014 / U+3010 / U+FF3B / [,右括号认 U+3015 / U+3011 / U+FF3D / ],中间可有空白 ──
const LB = `[${CH(0x3014, 0x3010, 0xFF3B)}\\[]`, RB = `[${CH(0x3015, 0x3011, 0xFF3D)}\\]]`;
export const MARK_BATCH = "攒批", MARK_USER = "待用户";
export const markRe = (word) => new RegExp(`${LB}\\s*${word}\\s*${RB}`);
export const hasMark = (text, word) => markRe(word).test(String(text ?? ""));
// 带两个记号之一(闸门14 记账的豁免用)
export const brakeMarked = (text) => hasMark(text, MARK_BATCH) || hasMark(text, MARK_USER);
export const stripMarks = (text) => String(text ?? "").replace(new RegExp(`${LB}\\s*(?:${MARK_BATCH}|${MARK_USER})\\s*${RB}`, "g"), " ");

// ── 收件箱留言块 · 开着的〔攒批〕 ───────────────────────────────────────────
// 括号里任何位置的「已修 / 不修」都算收口(〔dev 收到 · 不修:…〕也认)。被 ~~ 划掉的不算。
const NRB = `[^${CH(0x3015, 0x3011, 0xFF3D)}\\]\\n]`;
const CLOSED = new RegExp(`${LB}${NRB}{0,60}?(?:已修|不修)`);
const unstruck = (t) => String(t ?? "").replace(/~~[\s\S]*?~~/g, " ");
// 留言块:顶格 `- ` 那行 + 下面的续行,到下一个顶格 `- ` 或标题为止。
export function blocks(text) {
  const out = [];
  let cur = null;
  String(text ?? "").split("\n").forEach((l, i) => {
    if (/^- /.test(l)) { cur = { line: i + 1, head: l, lines: [l] }; out.push(cur); }
    else if (/^#/.test(l)) cur = null;
    else if (cur) cur.lines.push(l);
  });
  return out.map((b) => ({ line: b.line, head: b.head, text: b.lines.join("\n") }));
}
// 开着的〔攒批〕:头一行带记号(没被划掉),整块里没有收口的括号(划掉的收口不算)。
export const openBatch = (b) => hasMark(unstruck(b.head), MARK_BATCH) && !CLOSED.test(unstruck(b.text));

// 留言头 → { date, time, src, dsts }。格式照收件箱模板:`- 日期 时刻 · 源 → 目标 · …`;源 / 目标只认 boards 里的板块。
// 认不出 → null(列表里照列,源 / 目标打问号)。
const TARGET_END = new RegExp(` · |[(${CH(0xFF08)}:${CH(0xFF1A)}]`);
const TARGET_SEP = new RegExp(`[+/,${CH(0x3001, 0xFF0C)}]`);
export function parseHead(line, boards = null) {
  try {
    const names = boards ?? config().boards;
    const s = stripMarks(line).replace(/\*\*|`/g, "");
    const m = s.match(/^- (20\d\d-\d\d-\d\d)(?:\s+(\d{1,2}:[0-9x]{2}))?[^→\n]{0,40}?(?<![a-z])([a-z][a-z0-9-]*)\s*(?:\+\s*[a-z][a-z0-9-]*\s*)*→([^\n]*)/);
    if (!m || !names.includes(m[3])) return null;
    const dsts = [...new Set(m[4].split(TARGET_END)[0].split(TARGET_SEP)
      .map((x) => x.trim().replace(/塔$/, "")).filter((x) => names.includes(x) && x !== m[3]))];
    const i = s.indexOf("→");
    const body = s.slice(i + 1).replace(/^[^·]*?(?= · |$)/, "").replace(new RegExp(`^[\\s·:${CH(0xFF1A)}]+`), "").replace(/\s+/g, " ").trim();
    return { date: m[1], time: m[2] ?? "", src: m[3], dsts, body };
  } catch { return null; }
}
// 开着的〔攒批〕逐条:{ line, head, date, time, parts, src, dsts, body }。发给谁都列,目标在 dsts 里标出。
export function batchItems(backlogText, boards = null) {
  return blocks(backlogText).filter(openBatch).map((b) => {
    const r = parseHead(b.head, boards);
    const d = b.head.match(/(20\d\d)-(\d\d)-(\d\d)(?:\s+(\d{1,2}):([0-9x]{2}))?/);
    const fallback = stripMarks(b.head).replace(/\*\*|`/g, "").replace(/^- /, "").replace(/\s+/g, " ").trim();
    return { line: b.line, head: b.head, date: d ? `${d[1]}-${d[2]}-${d[3]}` : "", time: d?.[4] ? `${d[4]}:${d[5]}` : "",
      parts: d ? [+d[1], +d[2], +d[3], +(d[4] ?? 0), +String(d[5] ?? "0").replace(/x/g, "0")] : null,
      src: r?.src ?? "?", dsts: r?.dsts ?? [], body: [...(r?.body || fallback)].slice(0, 80).join("") };
  });
}

// ── 时刻(项目时区)──────────────────────────────────────────────────────
const tzOf = (tz) => { try { return tz ?? config().timezone; } catch { return "UTC"; } };
// 按时区取墙钟走 lib/now.mjs 那一份(全框架只许一份时区实现,项目的规矩也是这么查的)。
const partsIn = (t, tz) => wallParts(t, tz);
// 项目时区的 YYYY-MM-DD HH:MM
export function fmtTime(t, tz = null) {
  try { const p = partsIn(t, tzOf(tz)); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; } catch { return "?"; }
}
// 开了多少小时。parts = [年, 月, 日, 时, 分],是项目时区的墙钟(`10:1x` 的 x 当 0)。
export function hoursOpen(parts, now = new Date(), tz = null) {
  try {
    if (!parts) return null;
    const z = tzOf(tz);
    const [y, mo, d, h, mi] = parts;
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const off = (t) => { const p = partsIn(t, z); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t; };
    const at = guess - off(guess - off(guess));
    return (now.getTime() - at) / 3600e3;
  } catch { return null; }
}

// ── 「用户点头」行:去掉 `**`、行首列表 / 引用记号后,以它开头紧跟半角 / 全角冒号,同一行有「原话」(≥ 2 字) ──
const NOD = new RegExp(`^用户点头[:${CH(0xFF1A)}]`);
const QUOTE = new RegExp(`${CH(0x300C)}([^${CH(0x300D)}\\n]{2,})${CH(0x300D)}`, "g");
export const nodQuotes = (text) => String(text ?? "").split("\n").map(ringLine).filter((l) => NOD.test(l))
  .flatMap((l) => [...l.matchAll(QUOTE)].map((m) => m[1]));

// 排版变体:全角 / 半角的 , : ; ! ? ( ) 互换、汉字和英文 / 数字之间加或去空格 —— 原话落盘时常换了排版。不换字、不缩短。
const FULLW = CH(0xFF0C, 0xFF1A, 0xFF1B, 0xFF01, 0xFF1F, 0xFF08, 0xFF09);
const HALFW = ",:;!?()";
const swapWidth = (s, from, to) => [...s].map((c) => { const i = from.indexOf(c); return i < 0 ? c : to[i]; }).join("");
export function variantsOf(seg) {
  const s = String(seg ?? "");
  const spaced = s.replace(/(\p{Script=Han})(?=[A-Za-z0-9])|([A-Za-z0-9])(?=\p{Script=Han})/gu, "$1$2 ");
  const unspaced = s.replace(/(\p{Script=Han}) +(?=[A-Za-z0-9])|([A-Za-z0-9]) +(?=\p{Script=Han})/gu, "$1$2");
  const out = new Set();
  for (const a of [s, spaced, unspaced]) for (const b of [a, swapWidth(a, FULLW, HALFW), swapWidth(a, HALFW, FULLW)]) out.add(b);
  return [...out];
}
// 点头绑号:台账里**同一行**既有这句原话、又有这次派的号 —— 一次点头管一轮,换个号 / 换一轮就不认。
//   bind = { no: 这次派的号, bases: 这一家的基号(含「返工自」并进来的), round: 这次是第几轮(算不出就 null) }
//   同一行认两种写法:写着这次的号本身(Q361d);或写着这一家的号 + 「第 N 轮」(Q361 第 5 轮,N = 这次的轮次)。
//   bind 为空(任务书里认不出号)→ 只认原话,绑不了号。
// ⚠ 只证明「台账里有这句话」,证明不了是用户说的 —— 塔自己写一句再引用就过了(已知的洞)。
export function quoteInLedger(quote, ledgerText, bind = null) {
  const q = String(quote ?? "");
  if (!q) return false;
  const vs = variantsOf(q);
  const lines = String(ledgerText ?? "").split("\n").filter((l) => vs.some((v) => l.includes(v)));
  if (!bind?.no) return lines.length > 0;
  const bases = new Set([baseOf(bind.no), ...(bind.bases ?? [])].filter(Boolean));
  const roundRe = Number.isInteger(bind.round) && bind.round > 0 ? new RegExp(`第\\s*${bind.round}\\s*轮`) : null;
  return lines.some((l) => {
    const nos = qNos(l);
    if (nos.some((x) => x.no === bind.no)) return true;
    return !!roundRe && roundRe.test(l) && nos.some((x) => bases.has(x.base));
  });
}
