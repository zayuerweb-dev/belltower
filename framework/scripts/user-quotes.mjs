#!/usr/bin/env node
/**
 * 用户原话汇总:从台账现抽用户说过的原话(「用户 + 时刻 + 原话」),按日期排好,汇成一张清单。
 *
 * 为什么存在:框架里没有单独的会议记录。惯例是各塔把用户拍板的那句话原样、带时刻抄进台账
 * (BACKLOG 的授权行和收件箱、journal 的记账行)。这里**每次从 git 现抽,不另存一份** ——
 * 存下来的那份迟早跟台账分叉(派生 > 存储)。谁用:
 *   - 巡检塔周一数「又说一遍」(`.claude/skills/tower-meta/references/patrol.md`「周一」(a),吃 --json);
 *   - 塔问用户之前先查已定的(CLAUDE.md〈板块路由〉的顾问姿态):用户对这件事说过什么,先在这里找。
 *
 * 用法(在项目根跑):
 *   node scripts/user-quotes.mjs                打统计(正文几条、去重前几处、候选几处、按文件分布)
 *   node scripts/user-quotes.mjs --json         出数据(stdout)
 *   --ref <ref>                                 读哪个版本,默认 origin/main(用 git show,不读工作树)
 *   --also <文件或目录>                         多扫一处一手记录用户原话的文档(严格判据);可给多次,也可逗号分隔
 *
 * 扫哪些:台账四件 + CLAUDE.md 用常规判据;docs/design/ 下的 .md、各塔的 SKILL.md(.claude/skills/tower-<板块>/SKILL.md)
 *   用严格判据(只收带「原话」、或日期 + 时刻的)。别的默认不扫:访谈、调研里的「用户」多半是**产品的用户**,
 *   不是跟塔说话的这位;转抄台账原话的页扫进来只会重复,讲「误收」的句子还会被当成原话;
 *   框架文件(tower-meta/references/ 那几份)里「出处」引的是框架作者那边的用户说的话,不是本项目这位。
 * 时刻:台账里写的什么就记什么(写成 14:3x 的,原文就只记到十分钟);generatedAt 按项目时区(.claude/belltower.json 的 timezone)。
 * 链接:每处出处带 url(GitHub 上那一版的那一行)。仓库取 belltower.json 的 repo,空着从 origin 的地址现解析;认不出就是 null。
 * 记录塔(tower)只认 belltower.json 的 boards 里的板块名。
 *
 * 判据(宁漏勿错 —— 把规矩里的假设句或别人的话当成用户说的,比漏掉一句更糟):
 *   A 紧挨:「用户」和「之间只能是归属成分(时刻 / 日期 / 时区缩写 / 在 X 塔 / 原话 / 说问答令定…
 *     / 标点 / markdown / 一个不长的括注)。夹了别的词就不算。用户前面是「问 / 给 / 让…」
 *     (用户是宾语)、「新 / 老 / 终端」(说的是产品的用户)也不算。
 *   B 时间锚:归属成分里(或紧贴在「用户」前面)有时刻或日期,或有「原话」二字。
 *     没锚的进候选。台账四件 + CLAUDE.md 以外的文档用严格模式:只收带「原话」或日期 + 时刻的。
 *   C 只有「原话」没写「用户」:前面点名了别的说话人(工人 / 某个塔 / 老板…)不收;
 *     同一分句(或同一行)前面有「用户」、中间没插进别的说话人,才收。
 *   D 连写继承:「…」「…」、「…」、「…」→ 10:15「…」连着的,继承前一条的归属;行尾一条接下一行行首一条也算。
 *     接着的那条后面紧跟「=」「:」(在解释一个词)不继承。
 *   E 去重:规整后一句是另一句的前缀(短的至少 5 个字;中间截成「……」的,各段按顺序都在长句里;
 *     掐头的转述 —— 短句 ≥10 字、整句出现在长句里 —— 也算)
 *     且写明的日期不冲突 → 合成一条,留最长的全文、最精确的时刻,出处全列。
 *   F 表格里「原话」是列名、引语在另一格的 → 进候选,不进正文。
 *   日期:归属里写明的 > 列表项本行条目头(子项取父项)> 小节标题(「…更新 / 交接 / 接手须知」这种滚动记录的不算)
 *     > 行首日期。都没有就记「日期不明」,不猜。只写了月 / 日的,年份取条目的,条目也没有就取今年(项目时区)。
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config, SKILL_PREFIX } from "../.claude/hooks/lib/config.mjs";
import { stamp, ymd } from "../.claude/hooks/lib/now.mjs";

export const LEDGER = ["docs/BACKLOG.md", "docs/journal.md", "docs/session-pool.md", "docs/gate-log.md", "CLAUDE.md"];

// 时刻后面常跟的时区缩写(「10:12 ET」「09:30 JST」),算归属成分。
const TZ_ABBR = "ET|EST|EDT|PT|PST|PDT|CT|CDT|MT|MST|MDT|UTC|GMT|JST|KST|CST|HKT|SGT|IST|CET|CEST|BST|AEST|AEDT";
const TZ_ALL = new RegExp(`\\b(?:${TZ_ABBR})\\b`, "g");
// 日期:2031-03-02 / 03/02 / 3/2。时刻:14:05 / 14:0x。
const DATE_RE = /(20\d\d)-(\d{1,2})-(\d{1,2})|(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g;
const TIME_RE = /(?<![\d:])(\d{1,2}):([0-5][0-9x])(?![\d:])/g;
// 归属成分里允许的词 —— 去掉这些之后什么都不剩,才算「紧挨」。(判据 A)
const ATTR_WORDS = /原话|原文|拍板|纠正|追问|回复|明说|当场|改口|确认|补充|又说|再说|已经|一句|说|问|回|答|令|定|补|选|已|的|是|道/g;
const ATTR_PUNCT = /[\s:：,，、—\-–·\/()（）\[\]→>*_`~]/g;
// 用户前面是这些 → 用户是宾语(问了用户「…」),或说的是产品的用户(新用户「…」),不是说话人。
// 「当成 / 不是…」:讲「误收」的句子自己别被误收(「把它当成了用户原话「做这个」」「不是用户原话:「…」」)。
const OBJ_BEFORE = /(?:(?:问|给|让|告诉|提醒|等|替|帮|向|教|请|劝|催|带|陪|回答|答复|应|当成|当作|算成|算作|认成|误当|误认为)了?|不是|并非|不算|终端|新|老|的)$/;
// 往回找「原话」前面那段的尾巴:日期、时刻、时区缩写、冒号括号空白都剃掉,剩下的才看是谁说的。
const PRE_TAIL = new RegExp(`(?:20\\d\\d-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}|\\d{1,2}:[0-5][0-9x]|\\b(?:${TZ_ABBR})\\b|[\\s:：(（])*$`);
// 连写的两条引语之间只许有这些(判据 D)
const CHAIN_STRIP = new RegExp(`\\d{1,2}:[0-5][0-9x]|\\b(?:${TZ_ABBR})\\b|20\\d\\d-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}`, "g");
const LEFT_ANCHOR = new RegExp(`((?:20\\d\\d-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2})?\\s*(?:\\d{1,2}:[0-5][0-9x])?\\s*(?:${TZ_ABBR})?)\\s*$`);

const pad2 = (n) => String(n).padStart(2, "0");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 时刻一律走 lib/now.mjs(全框架唯一的实现)。timezone 写坏了 config 已经换成默认时区;这里再兜一层,万一 Intl 本身出事,别让整张单子出不来。
const thisYear = () => { try { return +ymd().slice(0, 4); } catch { return new Date().getUTCFullYear(); } };
const nowStamp = () => { try { return stamp(); } catch { return `${new Date().toISOString()}(timezone 读不了,按 UTC)`; } };

// 跟板块名有关的正则:板块清单从配置来(boards),按清单现拼,同一份清单只拼一次。
const RX = new Map();
function rx(boards) {
  const key = boards.join(",");
  if (RX.has(key)) return RX.get(key);
  const TW = boards.map(esc).join("|") || "(?!)";
  const r = {
    // 「原话」紧前点名的别的说话人(判据 C)
    otherSpeaker: new RegExp(`(工人|塔|${TW}|老板|合伙人|Claude|客户|文档|邮件|作者|对方|代理|会计|律师|reviewer|bot|他|她|我|你)\\s*$`, "i"),
    otherSpeakerAny: new RegExp(`工人|老板|合伙人|Claude|客户说|对方|会计|律师|reviewer|bot|(?:^|[^在对])\\s*(?:${TW})(?:\\s*塔)?\\s*(?:原话|说|问|答|回|写|转)`, "i"),
    attrTower: new RegExp(`(?:在|对|跟|向|给|问)\\s*(${TW})(?:\\s*塔)?`, "i"),
    attrTowerAll: new RegExp(`(?:在|对|跟|向|给|问)\\s*(?:${TW})(?:\\s*塔)?(?:\\s*说的)?`, "gi"),
    midTower: new RegExp(`(?:在|对)\\s*(?:${TW})(?:\\s*塔)?`, "gi"),
    // 记录塔:收件箱「product → dev」、journal「日期 · meta ·」、「日期 时刻 meta:」、「[plan 3/23 …」
    lineArrow: new RegExp(`(?:^|[\\s*\\[(·])(${TW})\\s*(?:塔)?\\s*→`, "i"),
    lineJournal: new RegExp(`^[-\\s*]*\\d{4}-\\d\\d-\\d\\d[^·]{0,40}·\\s*(${TW})(?:\\s*塔)?\\s*·`, "i"),
    lineStamp: new RegExp(`^[-\\s*]*\\d{4}-\\d\\d-\\d\\d\\s+[\\d:x]+(?:\\s*(?:${TZ_ABBR}))?\\s*(?:·\\s*)?(${TW})(?:\\s*塔)?\\s*[:：·(（]`, "i"),
    lineBracket: new RegExp(`^[-\\s*>]*\\[(${TW})\\s`, "i"),
    heading: new RegExp(`(?:·|\\|)\\s*(${TW})\\b|\\b(${TW})\\s*塔`, "i"),
    // 条目开头的日期:journal 行首、收件箱条目头、`[plan 3/23 09:4x]`。月/日后面必须跟时刻或 · ,
    // 否则「      - 11/30 的范围。」这种正文也会被当成条目日期。
    lineDate: new RegExp(String.raw`^[\s>*#\-[★✅⛔🟢🟡🟠🔒~]*(?:(?:${TW})\s+)?(20\d\d-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?=\s*(?:\d{1,2}:[0-5][0-9x]|·|(?:${TZ_ABBR})\b|\*\*)))`, "iu"),
  };
  RX.set(key, r);
  return r;
}

/** 找一行里所有顶层「…」(内层的「」算在里面)。返回 [{s,e}],s 指「,e 指」。 */
export function topQuotes(line) {
  const out = []; let depth = 0, s = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "「") { if (depth === 0) s = i; depth++; }
    else if (c === "」" && depth > 0) { depth--; if (depth === 0) out.push({ s, e: i }); }
  }
  return out;
}

/** 把引语内部换成占位符,长度不变 —— 往回找「用户」时不会找进别的引语里。 */
function maskLine(line, qs) {
  let m = line;
  for (const q of qs) m = m.slice(0, q.s + 1) + "□".repeat(q.e - q.s - 1) + m.slice(q.e);
  return m;
}

function firstDate(text, ctxYear) {
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(text))) {
    const [y, mo, d] = m[1] ? [+m[1], +m[2], +m[3]] : [ctxYear, +m[4], +m[5]];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  return null;
}
function lastTime(text) {
  TIME_RE.lastIndex = 0;
  let m, t = null;
  while ((m = TIME_RE.exec(text))) if (+m[1] <= 23) t = `${pad2(m[1])}:${m[2]}`;
  return t;
}
const stripMd = (t) => t.replace(/[*_`~]/g, "");

/**
 * 判据 A:between 是「用户」和「之间的文字。合格就返回 {date,time,hasYuanhua,tower},不合格返回 null。
 * 一个不长的括注(≤30 字,里面不能再有引语)整个算归属成分;括注里的时刻照样认。
 */
export function parseAttribution(between, ctxYear, boards = config().boards) {
  const R = rx(boards);
  let s = stripMd(between);
  const anchorsText = s;
  let tower = null;
  const tm = s.match(R.attrTower);
  if (tm) tower = tm[1].toLowerCase();
  s = s.replace(R.attrTowerAll, "");
  // 「答 D1:」「回 T7-1:」—— 答的是哪一问,编号也算归属成分
  s = s.replace(/(?:答|回|选)\s*[A-Z]{1,3}\d+(?:[-.]\d+)*/g, "");
  // 一个括注
  let paren = 0;
  s = s.replace(/[(（][^()（）「」□]{0,30}[)）]/g, (x) => (paren++ ? x : ""));
  s = s.replace(/20\d\d-\d{1,2}-\d{1,2}/g, "").replace(/\d{1,2}\/\d{1,2}/g, "")
       .replace(/\d{1,2}:[0-5][0-9x]/g, "").replace(TZ_ALL, "");
  s = s.replace(ATTR_WORDS, "").replace(ATTR_PUNCT, "");
  // 「用户 3/16 10:20 那句「…」」是回指一句真说过的话;没有时刻的「用户那一句「做这个」」是讲规矩,不收。
  if (/^[那这]一?句?$/.test(s) && /一句|句/.test(stripMd(between)) && /\d{1,2}:[0-5][0-9x]/.test(anchorsText)) s = "";
  if (s !== "") return null;
  return {
    date: firstDate(anchorsText, ctxYear),
    time: lastTime(anchorsText),
    hasYuanhua: /原话/.test(anchorsText),
    tower,
  };
}

/** 紧贴在「用户」前面的日期 / 时刻(`**3/15 18:47 用户「`、`出处:2031-03-10 22:18 用户「`)。 */
function leftAnchor(before, ctxYear) {
  const m = stripMd(before).match(LEFT_ANCHOR);
  const t = m ? m[1] : "";
  return { date: firstDate(t, ctxYear), time: lastTime(t) };
}

function towerFromLine(line, R) {
  for (const re of [R.lineArrow, R.lineJournal, R.lineStamp, R.lineBracket]) {
    const m = line.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}
function towerFromHeading(h, R) {
  const m = h.match(R.heading);
  return m ? (m[1] || m[2]).toLowerCase() : null;
}
// 落在某个塔自己的 skill 目录、或 docs/<板块>/ 下的 → 归那个塔(板块要在清单里)
function towerFromPath(p, boards) {
  const m = p.match(new RegExp(`^\\.claude/skills/${esc(SKILL_PREFIX)}([^/]+)/`)) || p.match(/^docs\/([^/]+)\//);
  return m && boards.includes(m[1]) ? m[1] : null;
}

/**
 * 抽一份 markdown。返回 {quotes, candidates},每条带 path/line/date/time/tower/text/context。
 * strict:台账四件 + CLAUDE.md 以外的文档,只收带「原话」或日期 + 时刻的。
 * boards:认记录塔用的板块清单(默认读配置);year:只写了月/日、条目也没给年份时用哪年(默认今年,项目时区)。
 */
export function extractFromText(path, text, { strict = false, boards = config().boards, year } = {}) {
  const R = rx(boards);
  const baseYear = year ?? thisYear();
  const lines = text.split("\n");
  const quotes = [], candidates = [];
  let heading = "", headingTower = null, ctxDate = null;
  let carry = null;                 // 上一行以一条用户原话结尾 → 本行开头的引语可以继承(判据 D)
  let table = null;                 // {cols:[...]} 表头含「原话」列(判据 F)
  let bullets = [];                 // 列表项的祖先链 [{indent, date}] —— 子项没写日期就取父项条目头的
  const ctxYear = () => (ctxDate ? +ctxDate.slice(0, 4) : baseYear);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNo = li + 1;
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      heading = stripMd(hm[2]).trim();
      headingTower = towerFromHeading(heading, R) ?? headingTower;
      if (hm[1].length <= 2) headingTower = towerFromHeading(heading, R);
      // 「接手须知(3/27 更新)」这种滚动记录的标题日期是「最后改的那天」,不是条目日期 —— 不用
      ctxDate = /更新|交接|接手须知/.test(heading) ? null : firstDate(heading, ctxYear());
      carry = null; table = null; bullets = [];
      continue;
    }
    const ld = line.match(R.lineDate);
    if (ld) ctxDate = firstDate(ld[1], ctxYear()) ?? ctxDate;

    // 表格:表头带「原话」列 → 那一列的引语进候选
    if (/^\s*\|/.test(line)) {
      const cells = line.replace(/^\s*\||\|\s*$/g, "").split("|");
      if (!table && /^\s*\|[\s|:-]+\|?\s*$/.test(lines[li + 1] ?? "")) {
        const cols = cells.map((c) => /原话/.test(c));
        table = cols.some(Boolean) ? { cols } : { cols: [] };
      } else if (table && table.cols.length && !/^\s*\|[\s|:-]+\|?\s*$/.test(line)) {
        cells.forEach((c, i) => {
          if (!table.cols[i]) return;
          for (const q of topQuotes(c)) {
            const t = c.slice(q.s + 1, q.e).trim();
            if (t) candidates.push(mk(path, lineNo, t, line, line.indexOf(c) + q.s, { date: ctxDate, time: null, reason: "表格「原话」列,说话人在表头" }));
          }
        });
      }
    } else table = null;

    const qs = topQuotes(line);
    const masked = maskLine(line, qs);
    const bm = line.match(/^(\s*)(?:[-*+]|\d+\.)\s/);
    let parentDate = null;
    if (bm) {
      const indent = bm[1].length;
      while (bullets.length && bullets[bullets.length - 1].indent >= indent) bullets.pop();
      parentDate = bullets.length ? bullets[bullets.length - 1].date : null;
      bullets.push({ indent, date: firstDate(stripMd(masked), ctxYear()) ?? parentDate });
    } else if (line.trim() !== "" && !/^\s/.test(line)) bullets = [];
    if (!qs.length) { if (line.trim() === "") carry = null; continue; }
    let prev = null;                // 本行上一条的判定 {status, attr}

    for (let qi = 0; qi < qs.length; qi++) {
      const q = qs[qi];
      const qtext = line.slice(q.s + 1, q.e).replace(/\*\*/g, "").trim();
      if (!normalize(qtext).replace(/[…().]/g, "")) { prev = null; continue; }
      const prefix = masked.slice(0, q.s);
      let res = null;               // {status:'quote'|'cand', attr, reason}

      // D 连写继承
      const gapStart = prev ? qs[qi - 1].e + 1 : 0;
      const gap = stripMd(masked.slice(gapStart, q.s));
      const chainable = (g) => !/原话/.test(g) &&
        g.replace(CHAIN_STRIP, "").replace(/[\s、,，;；→+>①-⑩和及或与]/g, "") === "";
      // 引语后面紧跟「=」「:」「是指」→ 是在解释一个词,不是一句话
      const termDef = /^[*_\s]*(?:=|＝|:|：|是指|指的是|即)/.test(line.slice(q.e + 1));
      if (termDef && (prev || (qi === 0 && carry))) { prev = null; continue; }
      if (prev && chainable(gap)) {
        res = { status: prev.status, attr: { ...prev.attr, time: lastTime(gap) ?? prev.attr.time, date: firstDate(gap, ctxYear()) ?? prev.attr.date }, reason: prev.reason };
      } else if (!prev && qi === 0 && carry && chainable(stripMd(prefix).replace(/^[\s>|]*/, ""))) {
        res = { ...carry };
      }

      // A/B 用户 + 归属成分
      if (!res) {
        const u = prefix.lastIndexOf("用户");
        if (u >= 0 && q.s - u <= 70) {
          const before = prefix.slice(0, u);
          const between = prefix.slice(u + 2);
          const attr = OBJ_BEFORE.test(stripMd(before).trimEnd()) ? null : parseAttribution(between, ctxYear(), boards);
          if (attr) {
            const la = leftAnchor(before, ctxYear());
            attr.date = attr.date ?? la.date;
            attr.time = attr.time ?? la.time;
            attr.explicitDate = !!attr.date;
            const anchored = strict ? (attr.hasYuanhua || (attr.date && attr.time)) : (attr.hasYuanhua || attr.date || attr.time);
            res = anchored ? { status: "quote", attr } : { status: "cand", attr, reason: strict ? "严格模式:没写「原话」也没有日期 + 时刻" : "没带时刻 / 日期" };
          } else if (!strict && stripMd(between).replace(/\s/g, "").length <= 12 && !OBJ_BEFORE.test(stripMd(before).trimEnd())) {
            res = { status: "cand", attr: { date: null, time: null }, reason: "「用户」和引语之间夹了别的词,归属不清", near: true };
          }
        }
      }

      // C 只有「原话」
      if (!res || (res.near && /原话/.test(prefix.slice(-40)))) {
        const y = prefix.lastIndexOf("原话");
        if (y >= 0 && q.s - y <= 30) {
          const after = prefix.slice(y + 2);
          const okAfter = parseAttribution(after, ctxYear(), boards) !== null;
          const pre = stripMd(prefix.slice(0, y)).replace(PRE_TAIL, "");
          if (okAfter && !R.otherSpeaker.test(pre) && !/见|同|在\s*$|里的?\s*$|有\s*$/.test(pre.slice(-4))) {
            // 往回找「用户」:先在本分句,再在整行
            const bounds = [...prefix.slice(0, y).matchAll(/[。;；|]|——|[(（]/g)].map((m) => m.index);
            const clauseStart = bounds.length ? bounds[bounds.length - 1] : 0;
            const u = prefix.lastIndexOf("用户", y);
            if (u >= 0) {
              const mid = stripMd(prefix.slice(u + 2, y)).replace(R.midTower, "");
              const clean = !R.otherSpeakerAny.test(mid) && !OBJ_BEFORE.test(stripMd(prefix.slice(0, u)).trimEnd());
              // 本分句里有「用户」,或者「用户…」那句紧挨在前面(中间最多隔一个句号,原话开新句)
              const stops = (prefix.slice(u, y).match(/。/g) || []).length;
              if (clean && (u >= clauseStart || stops === 0 || (stops === 1 && /。[*_\s]*$/.test(stripMd(prefix.slice(0, y)))))) {
                const ua = prefix.slice(u + 2, Math.min(y, u + 40));
                const own = stripMd(prefix.slice(Math.max(clauseStart, y - 20), y));
                const attr = {
                  date: firstDate(own, ctxYear()) ?? firstDate(stripMd(ua), ctxYear()) ?? leftAnchor(prefix.slice(0, u), ctxYear()).date,
                  time: lastTime(own.slice(-14)) ?? lastTime(stripMd(ua).split(/[「□]/)[0]) ?? leftAnchor(prefix.slice(0, u), ctxYear()).time,
                  hasYuanhua: true, tower: null,
                };
                attr.explicitDate = !!attr.date;
                res = { status: "quote", attr };
              }
            }
            if (!res || res.near) res = { status: "cand", attr: { date: null, time: null }, reason: "只写了「原话」,前面没找到「用户」" };
          }
        }
      }

      if (!res) { prev = null; continue; }
      if (res.near) res = { ...res };
      const attr = res.attr;
      // 列表项的条目头就是这一行:行里引语之前的第一个日期(`- ✅ **T9 …(4/01 09:1x 立,用户…`)
      const bulletDate = bm ? (firstDate(stripMd(prefix), ctxYear()) ?? parentDate) : null;
      const date = attr.date ?? bulletDate ?? ctxDate ?? firstDate(prefix, ctxYear());
      const item = mk(path, lineNo, qtext, line, q.s, {
        date, time: attr.time ?? null, explicitDate: !!attr.explicitDate,
        tower: attr.tower ?? towerFromLine(line, R) ?? headingTower ?? towerFromPath(path, boards),
        heading, reason: res.reason,
      });
      (res.status === "quote" ? quotes : candidates).push(item);
      prev = { status: res.status, attr: { ...attr, date: attr.date }, reason: res.reason };
    }
    // 行尾是一条判定过的引语,后面只剩标点 → 下一行开头的引语可继承
    const last = qs[qs.length - 1];
    carry = prev && /^[\s*_、,，]*$/.test(line.slice(last.e + 1)) ? { status: prev.status, attr: prev.attr, reason: prev.reason } : null;
  }
  return { quotes, candidates };
}

function mk(path, line, text, raw, pos, extra) {
  const plain = (a, b) => stripMd(raw.slice(a, b)).replace(/\s+/g, " ").trim();
  const before = plain(Math.max(0, pos - 40), pos);
  const end = raw.indexOf("」", pos);
  const after = plain(end + 1, end + 41);
  return { path, line, text, before, after, heading: "", ...extra };
}

// ── E 去重 ──────────────────────────────────────────────────────────
export function normalize(t) {
  return t.replace(/[，]/g, ",").replace(/[：]/g, ":").replace(/[；]/g, ";").replace(/[！]/g, "!")
    .replace(/[？]/g, "?").replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[*_`]/g, "")
    .replace(/\s+/g, "")
    .replace(/(?:……|…|\.\.\.)+$/, "")
    .replace(/^[,.:;!?、。—\-]+|[,.:;!?、。—\-]+$/g, "");
}
/** 短句(可能中间截成「……」)的每一段按顺序都出现在长句里,且第一段是长句开头 → 同一句。 */
export function covers(longText, shortText) {
  const L = normalize(longText);
  const parts = shortText.split(/……|…|\.\.\./).map(normalize).filter(Boolean);
  if (!parts.length || parts.join("").length < 5) return normalize(longText) === normalize(shortText);
  if (parts.length === 1 && parts[0].length >= 10 && L.includes(parts[0])) return true;   // 掐头的转述
  if (!L.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (const p of parts.slice(1)) { const i = L.indexOf(p, at); if (i < 0) return false; at = i + p.length; }
  return true;
}
const timeRank = (t) => (!t ? 0 : /x$/.test(t) ? 1 : 2);

export function dedupe(items) {
  const sorted = [...items].sort((a, b) => normalize(b.text).length - normalize(a.text).length || a.path.localeCompare(b.path) || a.line - b.line);
  const groups = [];
  for (const it of sorted) {
    const k = normalize(it.text);
    const g = groups.find((g) => {
      if (!(g.key === k || covers(g.items[0].text, it.text))) return false;
      return !(g.explicitDates.size && it.explicitDate && it.date && !g.explicitDates.has(it.date));
    });
    if (g) { g.items.push(it); if (it.explicitDate && it.date) g.explicitDates.add(it.date); }
    else groups.push({ key: k, items: [it], explicitDates: new Set(it.explicitDate && it.date ? [it.date] : []) });
  }
  return groups.map(({ items }) => {
    const best = (f) => [...items].sort(f)[0];
    const textSrc = items[0];
    const dateSrc = best((a, b) => (b.explicitDate - a.explicitDate) || (!!b.date - !!a.date) || (timeRank(b.time) - timeRank(a.time)));
    const timeSrc = best((a, b) => (timeRank(b.time) - timeRank(a.time)) || (b.explicitDate - a.explicitDate));
    const towers = [...new Set(items.map((i) => i.tower).filter(Boolean))];
    const srcs = items.map(({ path, line }) => ({ path, line })).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return {
      date: dateSrc.date, time: (timeSrc.date === dateSrc.date || !timeSrc.date || !dateSrc.explicitDate) ? timeSrc.time : dateSrc.time,
      tower: (dateSrc.tower ?? towers[0]) || null, towers,
      text: textSrc.text, heading: textSrc.heading, before: textSrc.before, after: textSrc.after,
      sources: srcs,
    };
  }).sort(cmpDesc);
}
function cmpDesc(a, b) {
  return (b.date ?? "").localeCompare(a.date ?? "") || (b.time ?? "").localeCompare(a.time ?? "");
}

// ── 读 git ─────────────────────────────────────────────────────────
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** owner/repo:belltower.json 的 repo 优先,空着从 origin 的地址现解析(只认 GitHub 的地址);认不出 = ""。 */
export function repoSlug() {
  const r = config().repo;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return r;
  try {
    const m = git("remote", "get-url", "origin").trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return "";
}

// 各塔只扫 SKILL.md:同目录下的 references/ 是框架文件(sync 会覆盖),里面「出处」引的是框架作者那边的用户,不是本项目这位。
const STRICT_DEFAULT = (p) => /^docs\/design\/.+\.md$/.test(p) || new RegExp(`^\\.claude/skills/${esc(SKILL_PREFIX)}[^/]+/SKILL\\.md$`).test(p);
/** 要扫的文件:台账四件 + CLAUDE.md、docs/design/、各塔的 SKILL.md,外加 --also 给的(文件名或目录前缀)。 */
export function listFiles(ref, also = []) {
  const extra = (p) => p.endsWith(".md") && also.some((a) => p === a || p.startsWith(a.replace(/\/?$/, "/")));
  return git("ls-tree", "-r", "--name-only", ref).split("\n").filter((p) => p && (LEDGER.includes(p) || STRICT_DEFAULT(p) || extra(p)));
}

export function collect(ref = "origin/main", { also = [], boards = config().boards } = {}) {
  let sha = "";
  try { sha = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim(); } catch {}
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`读不到 ${ref} —— 先 git fetch origin main;要读别的版本用 --ref`);
  const files = listFiles(sha, also);
  const raw = [], cands = [], perFile = {};
  for (const p of files) {
    const text = git("show", `${sha}:${p}`);
    const { quotes, candidates } = extractFromText(p, text, { strict: !LEDGER.includes(p), boards });
    raw.push(...quotes); cands.push(...candidates);
    if (quotes.length || candidates.length) perFile[p] = { quotes: quotes.length, candidates: candidates.length };
  }
  const repo = repoSlug();
  const url = (s) => (repo ? `https://github.com/${repo}/blob/${sha}/${s.path}#L${s.line}` : null);
  const quotes = dedupe(raw);
  for (const q of quotes) q.sources = q.sources.map((s) => ({ ...s, url: url(s) }));
  const candidates = cands.map((c) => ({ ...c, url: url(c) })).sort(cmpDesc);
  return { ref, sha, repo: repo || null, timezone: config().timezone, generatedAt: nowStamp(),
    files: files.length, rawCount: raw.length, quotes, candidates, perFile };
}

// ── 命令行 ─────────────────────────────────────────────────────────
function main(argv) {
  const at = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  const ref = at("--ref") ?? "origin/main";
  const also = argv.flatMap((a, i) => (argv[i - 1] === "--also" ? a.split(",") : []))
    .map((s) => s.trim().replace(/^\.\//, "")).filter(Boolean);
  let data;
  try { data = collect(ref, { also }); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  if (argv.includes("--json")) { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); return; }
  console.log(`基于 ${ref} @ ${data.sha.slice(0, 12)},扫了 ${data.files} 个文件`);
  console.log(`正文 ${data.quotes.length} 条(去重前 ${data.rawCount} 处),候选 ${data.candidates.length} 处`);
  console.log("按文件(去重前正文 / 候选):");
  for (const [p, c] of Object.entries(data.perFile).sort((a, b) => b[1].quotes - a[1].quotes))
    console.log(`  ${String(c.quotes).padStart(4)} / ${String(c.candidates).padStart(4)}  ${p}`);
  console.log("看每一条:加 --json(带日期、时刻、记录塔、出处和链接)。");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
