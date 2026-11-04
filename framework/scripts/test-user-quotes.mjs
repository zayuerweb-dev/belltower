#!/usr/bin/env node
// 用户原话汇总(scripts/user-quotes.mjs)的断言。跑法:node scripts/test-user-quotes.mjs
//
// 两段:
//   一、夹具 —— 自己编的小段 markdown(内容、日期全是编的,年份放在 2031,一看就是夹具)。每条判据一收一拒。
//   二、沙箱仓库 —— 临时目录里建一个带 origin 的 git 仓库,摆好台账 / 设计页 / skill / 访谈记录,跑命令行 --json:
//       核扫哪些文件、读 git 不读工作树、仓库地址 / 时区 / 板块从 .claude/belltower.json 读。
// 期望值都写死在这儿,不从被测脚本里读。全角字一律 String.fromCharCode 拼(手打的全角常常其实是半角)。
//
// ★ 变异验证:UQ_MODULE=<改坏的副本路径> node scripts/test-user-quotes.mjs —— 换一份被测脚本跑同一套断言
//   (副本旁边要有 ../.claude/hooks/lib/,所以整个框架目录一起拷)。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOD = resolve(process.env.UQ_MODULE || resolve(dirname(fileURLToPath(import.meta.url)), "user-quotes.mjs"));
const { extractFromText, dedupe, normalize } = await import(pathToFileURL(MOD).href);

let pass = 0, fail = 0;
const results = [];
function assert(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? `  — ${String(detail).slice(0, 400)}` : ""}`); }
}
const B = ["plan", "product", "dev", "data", "ops", "biz", "meta", "test", "patrol"];   // 默认板块清单,写死
const ledger = (md, path = "docs/journal.md") => extractFromText(path, md, { boards: B, year: 2031 });
const strictDoc = (md, path = "docs/design/x.md") => extractFromText(path, md, { strict: true, boards: B, year: 2031 });
const has = (list, text) => list.find((q) => normalize(q.text) === normalize(text));
const show = (r) => JSON.stringify({ q: r.quotes.map((q) => [q.text, q.date, q.time, q.tower]), c: r.candidates.map((c) => c.text) });
const C = (...n) => String.fromCharCode(...n);
const FW_COMMA = C(0xFF0C), FW_COLON = C(0xFF1A);

// ── 一、夹具 ─────────────────────────────────────────────────────────
const H = "### 某条 · 2031-03-20 10:00 —— 夹具\n";

// 1. 要能收的写法(最后一条:时区缩写不只认 ET)
const WRITES = [
  ["> **用户 3/16 10:12 ET 原话**:「先放着,下周再说」", "先放着,下周再说", "2031-03-16", "10:12"],
  ["**用户 2031-04-02 11:41 在 meta 塔原话:「做,按乙方案来」**", "做,按乙方案来", "2031-04-02", "11:41"],
  ["用户 16:12「列表再密一点」", "列表再密一点", "2031-03-20", "16:12"],
  ["用户 3/23 10:05 说「先把定稿的那几页做完」", "先把定稿的那几页做完", "2031-03-23", "10:05"],
  ["**3/15 18:47 用户「旧的那版不用留」**", "旧的那版不用留", "2031-03-15", "18:47"],
  ["用户 17:36 问「设置页还没做吗?」", "设置页还没做吗?", "2031-03-20", "17:36"],
  ["*出处:2031-03-10 22:18 用户「以后不用我来回转述了」*", "以后不用我来回转述了", "2031-03-10", "22:18"],
  ["**用户原话**(16:40,附截图):「这个按钮挪到右边」", "这个按钮挪到右边", "2031-03-20", "16:40"],
  ["用户 13:5x 定:「就照这个来」", "就照这个来", "2031-03-20", "13:5x"],
  ["plan 转来用户 15:52「这条先不报」", "这条先不报", "2031-03-20", "15:52"],
  ["用户 09:30 JST「东京那边也一样」", "东京那边也一样", "2031-03-20", "09:30"],
];
for (const [md, text, date, time] of WRITES) {
  const r = ledger(H + md);
  const q = has(r.quotes, text);
  assert(`收:${md}`, q && q.date === date && q.time === time, show(r));
}

// 2. 只有「原话」没写「用户」:前面同一分句有「用户」才收;点名了别的说话人不收
{
  const md = "- 2031-03-29 11:3x · product → dev · 用户 3/29 11:12「顶部换成三栏」→ 11:17「给我看看效果」→ 11:2x 原话:「选丁方案,定了」";
  const r = ledger(md, "docs/BACKLOG.md");
  assert("收:「→ 11:17「…」」连写继承,时刻用自己的", has(r.quotes, "给我看看效果")?.time === "11:17", show(r));
  assert("收:「11:2x 原话:「…」」(同分句前面有用户)", has(r.quotes, "选丁方案,定了")?.time === "11:2x", show(r));
  assert("收:只有原话的那句,日期取用户那段的 3/29", has(r.quotes, "选丁方案,定了")?.date === "2031-03-29", show(r));
  assert("记录塔:从「product → dev」认出 product", has(r.quotes, "顶部换成三栏")?.tower === "product", show(r));
  const m = ledger(H + "用户 10:00 派了活,工人回来报了。原话「我做完了」");
  assert("不收:用户和「原话」之间插进了别的说话人", !has(m.quotes, "我做完了"), show(m));
  const mail2 = ledger(H + "用户 10:00 转来,邮件原话「请于周五前回复」");
  assert("不收:「原话」紧前点名了别的来源(邮件原话)", !has(mail2.quotes, "请于周五前回复"), show(mail2));
  const w = ledger(H + "工人 16:4x 原话:「我做完了」;dev 原话「测试全绿」");
  assert("不收:工人原话 / dev 原话", !has(w.quotes, "我做完了") && !has(w.quotes, "测试全绿"), show(w));
  const n = ledger(H + "那边定了。16:4x 原话:「没人说过这句」");
  assert("不收:只有原话、前面找不到用户 → 进候选", !has(n.quotes, "没人说过这句") && has(n.candidates, "没人说过这句"), show(n));
  const s = ledger(H + "- 2031-03-30 14:4x · product → dev · **用户 14:4x 在 product 塔定列表页**。原话(附截图):「列表要能按名字搜」");
  assert("收:「用户…定X。原话:「…」」隔一个句号", has(s.quotes, "列表要能按名字搜")?.time === "14:4x", show(s));
}

// 3. 连写继承
{
  const r = ledger(H + "用户原话:**「甲方案」**、**「乙方案也行」**");
  assert("收:「…」、「…」两条都收", has(r.quotes, "甲方案") && has(r.quotes, "乙方案也行"), show(r));
  const r2 = ledger(H + "> 用户原话:**「第一句」**、\n> **「跨行的第二句」**。下面是塔的话「这句不是」");
  assert("收:跨行连写继承", has(r2.quotes, "跨行的第二句"), show(r2));
  assert("不收:连写中间夹了别的话就断", !has(r2.quotes, "这句不是"), show(r2));
  const r3 = ledger(H + "> 用户 3/23 10:05「先把定稿的做完」\n> 「定稿的」= 规格里写死的那些。");
  assert("不收:下一行「「词」= 解释」不继承", !has(r3.quotes, "定稿的"), show(r3));
}

// 4. 不收:指引、讲规矩的假设句、转贴邮件、宾语、产品的用户、讲误收的句子
{
  const r = ledger(H + "用户 3/10 10:00 拍板过,原话见上面「做这个」。");
  assert("不收:原话见上面「…」", !has(r.quotes, "做这个"), show(r));
  const rule = ledger("## 铁律\n| 用户在**别的塔**说「照这个做」,原话 + 时刻已落进台账 | ✅ |\n立号前必须有用户那一句「做这个」。\n", "CLAUDE.md");
  assert("不收:规矩表里的「用户在别的塔说「照这个做」」", !has(rule.quotes, "照这个做"), show(rule));
  assert("不收:「用户那一句「做这个」」(没时刻,是讲规矩)", !has(rule.quotes, "做这个"), show(rule));
  const ref = ledger(H + "用户 3/16 10:20 那句「先用甲方案顶着」");
  assert("收:「用户 3/16 10:20 那句「…」」(有时刻的回指)", has(ref.quotes, "先用甲方案顶着"), show(ref));
  const mail = ledger("- **2031-04-02 14:3x meta → dev** · 前情:用户 11:12 在 meta 塔贴了一封邮件截图「Your trial ends in 3 days」「Upgrade now」,原话「这封是什么意思」");
  assert("不收:转贴的邮件文字", !has(mail.quotes, "Your trial ends in 3 days") && !has(mail.quotes, "Upgrade now"), show(mail));
  assert("收:邮件后面那句「原话「…」」,时刻 11:12、日期取条目", has(mail.quotes, "这封是什么意思")?.time === "11:12" && has(mail.quotes, "这封是什么意思")?.date === "2031-04-02", show(mail));
  const obj = ledger(H + "meta 问了用户 14:25「要不要换个配色」");
  assert("不收:用户是宾语(问了用户「…」)", !has(obj.quotes, "要不要换个配色"), show(obj));
  const pu = ledger(H + "新用户 10:00 反馈「注册太麻烦」。终端用户 10:05 原话「导出太慢」");
  assert("不收:说的是产品的用户(新用户 / 终端用户)", !has(pu.quotes, "注册太麻烦") && !has(pu.quotes, "导出太慢"), show(pu));
  const neg1 = ledger(H + "判据 C 把它当成了用户原话「做这个」,一条红。");
  assert("不收:「当成了用户原话「…」」(讲误收)", !has(neg1.quotes, "做这个"), show(neg1));
  const neg2 = ledger(H + "不是用户原话:「做这个」是规矩里的术语。");
  assert("不收:「不是用户原话:「…」」", !has(neg2.quotes, "做这个"), show(neg2));
  const neg3 = ledger(H + "这句被误当成用户 3/20 10:00 说的「做这个」。");
  assert("不收:「误当成用户 3/20 10:00 说的「…」」(有时刻也不收)", !has(neg3.quotes, "做这个"), show(neg3));
}

// 5. 无时间锚进候选不进正文
{
  const r = ledger(H + "用户说「以后再说吧」");
  assert("候选:用户说「…」没带时刻", !has(r.quotes, "以后再说吧") && has(r.candidates, "以后再说吧"), show(r));
}

// 6. 只有时刻时取条目日期(journal 行首 / 标题),年份照条目
{
  const j = ledger("2031-03-11 · dev · 某事 · 用户 23:41 原话「再派两个工人」\n");
  assert("日期:journal 行首 2031-03-11", has(j.quotes, "再派两个工人")?.date === "2031-03-11", show(j));
  // 塔名打头的行首日期也认(塔名来自板块清单)。原话在下一行、本行没日期 → 只能靠上一行 `patrol 2031-03-08` 的行首日期
  const pj = ledger("patrol 2031-03-08 · 每日归档\n  接着:用户 06:15 原话「早报再短一点」\n");
  assert("日期:patrol 打头的行首 2031-03-08 管到下一行", has(pj.quotes, "早报再短一点")?.date === "2031-03-08", show(pj));
  const pk = extractFromText(".claude/skills/tower-patrol/SKILL.md", "用户 2031-03-08 06:20「早报只要一屏」\n", { boards: B, year: 2031 });
  assert("记录塔:落在 .claude/skills/tower-patrol/ 的原话归 patrol", has(pk.quotes, "早报只要一屏")?.tower === "patrol", show(pk));
  const h = ledger("#### v4 · 2031-03-15 11:52 —— 某版\n\n用户 11:30「那一版先不发」\n", "docs/BACKLOG.md");
  assert("日期:取所在小节标题的 2031-03-15", has(h.quotes, "那一版先不发")?.date === "2031-03-15", show(h));
  const b = ledger("#### 某节(2031-03-27)\n      - 11/30 的范围。\n      - 用户 12:00「先别管它」\n", "docs/BACKLOG.md");
  assert("日期:正文里的「11/30 的范围」不算条目日期", has(b.quotes, "先别管它")?.date === "2031-03-27", show(b));
  const bl = ledger("### 某小节(2031-03-27)\n- ✅ **T9 · 某事**(4/01 09:1x 立,用户在 dev 塔原话:「地址分三行」)\n", "docs/BACKLOG.md");
  assert("日期:列表项取本行条目头的 4/01,不取小节的 3/27", has(bl.quotes, "地址分三行")?.date === "2031-04-01", show(bl));
  const nb = ledger("### dev 塔 · 接手须知(2031-03-27 06:1x 更新)\n- **三件做到哪(3/29 13:2x 更新)**:\n  - 某页:用户 13:3x「这个先不做」\n- **排着(14:5x 重排)**:\n  - 某页:用户 16:44「都交给 dev」\n", "docs/BACKLOG.md");
  assert("日期:子项没写日期 → 取父项条目头的 3/29", has(nb.quotes, "这个先不做")?.date === "2031-03-29", show(nb));
  assert("日期:「接手须知(…更新)」滚动标题的日期不当条目日期", has(nb.quotes, "都交给 dev") && !has(nb.quotes, "都交给 dev").date, show(nb));
  const ans = ledger("**★ 用户 2031-03-14 16:21 答 D1:「放」** —— 即选项 (a)。\n工时那条按用户 3/10 13:05「不用再议了」办。\n", "docs/BACKLOG.md");
  assert("收:「用户 … 答 D1:「放」」—— 问题编号算归属", has(ans.quotes, "放")?.time === "16:21", show(ans));
  assert("收:「按用户 3/10 13:05「…」」—— 按 / 照用户不是宾语", has(ans.quotes, "不用再议了")?.date === "2031-03-10", show(ans));
}

// 7. 截断前缀 + 不同文件的同一句 → 去重成一条
{
  const a = ledger("2031-03-16 · biz · 用户 3/16 15:2x 原话:「这个先放一放。眼下就用甲方案顶着,以后再换」\n", "docs/journal.md");
  const b = ledger("### X\n用户 15:26 原话「这个先放一放。眼下就用甲方案顶着……」\n", "docs/BACKLOG.md");
  const c = ledger("### Y\n用户 3/16 原话「这个先放一放……以后再换」\n", "CLAUDE.md");
  const d = dedupe([...a.quotes, ...b.quotes, ...c.quotes]);
  assert("去重:三处合成一条", d.length === 1, JSON.stringify(d.map((x) => x.text)));
  assert("去重:留最长全文", d[0] && normalize(d[0].text) === normalize("这个先放一放。眼下就用甲方案顶着,以后再换"), JSON.stringify(d[0]));
  assert("去重:留最精确的时刻(15:26 胜过全文那处的 15:2x)", d[0]?.time === "15:26", JSON.stringify(d[0]));
  assert("去重:出处全列", d[0]?.sources.length === 3, JSON.stringify(d[0]?.sources));
  const sub = dedupe([...ledger("### Z\n用户 3/30 10:48 原话「我的意思是两边看起来要一致,字号,颜色」\n").quotes, ...ledger("### Z\n用户 10:48「两边看起来要一致,字号,颜色」\n").quotes]);
  assert("去重:掐头的转述(≥10 字)也合成一条", sub.length === 1, JSON.stringify(sub.map((x) => x.text)));
  const e = dedupe([...ledger("### Z\n用户 3/10 10:00 原话「选1」\n").quotes, ...ledger("### Z\n用户 3/14 10:00 原话「选1」\n").quotes]);
  assert("去重:写明的日期不同不合并", e.length === 2, JSON.stringify(e));
  // 全角逗号 / 冒号跟半角当一回事(规整时换成半角);全角字用 fromCharCode 拼,不靠手打
  assert("规整:全角逗号、冒号换成半角", normalize(`做${FW_COMMA}按甲${FW_COLON}乙`) === "做,按甲:乙", normalize(`做${FW_COMMA}按甲${FW_COLON}乙`));
  const fw = dedupe([...ledger(`### Z\n用户 3/12 10:00 原话「做${FW_COMMA}按甲方案来」\n`).quotes, ...ledger("### Z\n用户 3/12 10:00 原话「做,按甲方案来」\n").quotes]);
  assert("去重:只差全角 / 半角逗号的两处是同一句", fw.length === 1, JSON.stringify(fw.map((x) => x.text)));
}

// 8. 严格模式(台账四件 + CLAUDE.md 以外的文档)
{
  const r = strictDoc("### 保存\n用户点「保存」后跳回列表。用户 16:10 说「好」。用户 3/23 16:10「好的」。用户原话「可以」\n");
  assert("严格:用户点「保存」不收", !has(r.quotes, "保存"), show(r));
  assert("严格:只有时刻没「原话」不收", !has(r.quotes, "好"), show(r));
  assert("严格:日期 + 时刻收", has(r.quotes, "好的"), show(r));
  assert("严格:带「原话」收", has(r.quotes, "可以"), show(r));
}

// 9. 表格里「原话」是列名 → 候选
{
  const r = ledger("| # | 分歧 | 用户原话 |\n|---|---|---|\n| ① | 编号 | 「编号不同的也可能是同一个」 |\n", "docs/BACKLOG.md");
  assert("表格:原话列进候选不进正文", !has(r.quotes, "编号不同的也可能是同一个") && has(r.candidates, "编号不同的也可能是同一个"), show(r));
}

// 10. 记录塔只认板块清单里的名字(清单换了,结果跟着变)
{
  const line = "- 2031-03-07 09:00 · alpha · 某事 · 用户 08:55 原话「这条记在 alpha 塔」\n";
  const mine = extractFromText("docs/journal.md", line, { boards: ["alpha", "beta"], year: 2031 });
  const dflt = ledger(line);
  assert("记录塔:板块清单里有 alpha → 认出 alpha;默认清单没有 → 不认", has(mine.quotes, "这条记在 alpha 塔")?.tower === "alpha" && has(dflt.quotes, "这条记在 alpha 塔")?.tower === null, show(mine) + " | " + show(dflt));
  const devLine = ledger("- 2031-03-07 09:00 · dev · 某事 · 用户 08:55 原话「这条记在 dev 塔」\n");
  const devNo = extractFromText("docs/journal.md", "- 2031-03-07 09:00 · dev · 某事 · 用户 08:55 原话「这条记在 dev 塔」\n", { boards: ["alpha", "beta"], year: 2031 });
  assert("记录塔:清单里没有 dev 就不认 dev", has(devLine.quotes, "这条记在 dev 塔")?.tower === "dev" && has(devNo.quotes, "这条记在 dev 塔")?.tower === null, show(devLine) + " | " + show(devNo));
}

// ── 二、沙箱仓库 + 命令行 ───────────────────────────────────────────
const TMPS = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMPS.push(d); return d; };
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
// 时钟钉在 2031-03-20 03:00Z(东京 12:00):generatedAt 和「只写了月/日取今年」都跟着它,期望值才写得死
const PIN = { CLAUDE_HOOK_TEST: "1", BELLTOWER_NOW: "2031-03-20T03:00:00Z" };
const cli = (cwd, args) => {
  const r = spawnSync(process.execPath, [MOD, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...PIN } });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", j };
};
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
const find = (data, text) => data?.quotes?.find((q) => normalize(q.text) === normalize(text));

const P = tmp("uq-repo-");
const ORIGIN = join(tmp("uq-origin-"), "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", ORIGIN]);
g(P, "init", "-q", "-b", "main");
g(P, "config", "user.email", "t@example.com"); g(P, "config", "user.name", "t");
g(P, "remote", "add", "origin", ORIGIN);

const CFG = { repo: "acme/widget", timezone: "Asia/Tokyo", boards: ["plan", "product", "dev", "meta", "patrol", "alpha"] };
put(P, ".claude/belltower.json", JSON.stringify(CFG, null, 2) + "\n");
const JOURNAL = [
  "# 行为流水", "",
  "- 2031-03-02 10:05 · plan · 定范围 · 用户 2031-03-02 09:58 原话「先做列表页,详情页下个月再说」",
  "- 2031-03-03 11:20 · dev · 返工 · 用户 11:12「我说过表头要固定」",
  "- 2031-03-05 16:20 · product · 定列宽 · 用户 2031-03-05 15:10 原话「列宽可以拖动,但要记住」",
  "- 2031-03-07 09:00 · alpha · 某事 · 用户 08:55 原话「这条记在 alpha 塔」", ""].join("\n");
put(P, "docs/journal.md", JOURNAL);
put(P, "docs/BACKLOG.md", [
  "# BACKLOG", "", "## 二、任务池", "", "### T3 · 列表页 · dev —— 🟢 可做", "",
  "> **用户 2031-03-04 14:00 原话:「按甲方案做」** —— 据此 T3 可以开工。", ""].join("\n"));
put(P, "CLAUDE.md", [
  "# 项目规矩", "",
  "6. **派活要用户点头。** 立号前必须有用户那一句「做这个」。",
  "   | 用户在**别的塔**说「照这个做」,原话 + 时刻已落进台账 | ✅ 算 |",
  "*出处:用户 2031-02-20 16:30 原话「报号的时候带上一句话说明」*", ""].join("\n"));
const DESIGN = ["# 列表页设计", "", "用户 15:00 说「好」。", "用户 2031-03-05 15:10「列宽可以拖动,但要记住」", ""].join("\n");
put(P, "docs/design/list.md", DESIGN);
put(P, "docs/product/interviews.md", "# 访谈记录(产品的用户说的)\n\n用户 2031-03-06 10:00 原话「希望能批量改」\n");
put(P, "docs/research/notes.md", "# 调研\n\n用户 2031-03-01 10:00 原话「调研里引的一句」\n");
put(P, ".claude/skills/tower-dev/SKILL.md", "---\nname: tower-dev\n---\n\n*出处:用户 2031-02-27 09:00 原话「没有规格不开工」*\n");
put(P, ".claude/skills/tower-meta/references/dispatch.md", "**用户 2031-01-05 10:00 原话**:「框架作者那边说的」\n");
g(P, "add", "-A"); g(P, "commit", "-qm", "台账");
g(P, "push", "-q", "-u", "origin", "main");
// 工作树里没提交的改动:不该进结果(读的是 git)
appendFileSync(join(P, "docs/journal.md"), "- 2031-03-08 10:00 · plan · 某事 · 用户 2031-03-08 09:50 原话「工作树里没提交的」\n");

{
  const r = cli(P, ["--json"]);
  const d = r.j;
  const sha = g(P, "rev-parse", "origin/main").trim();
  assert("命令行 --json 退出 0、出合法 JSON", r.code === 0 && d && Array.isArray(d.quotes), `code=${r.code} ${r.err.slice(0, 200)}`);
  assert("读的是 origin/main 那一版(sha 对得上)", d?.sha === sha && d?.ref === "origin/main", `${d?.sha} vs ${sha}`);
  assert("工作树里没提交的改动不算(读 git,不读工作树)", !find(d, "工作树里没提交的"));
  const q1 = find(d, "先做列表页,详情页下个月再说");
  assert("收:journal 行里的原话(日期、时刻、记录塔)", q1?.date === "2031-03-02" && q1?.time === "09:58" && q1?.tower === "plan", JSON.stringify(q1));
  const q2 = find(d, "我说过表头要固定");
  assert("收:只写时刻的取 journal 行首日期", q2?.date === "2031-03-03" && q2?.time === "11:12" && q2?.tower === "dev", JSON.stringify(q2));
  assert("收:BACKLOG 授权行的原话", find(d, "按甲方案做")?.date === "2031-03-04" && find(d, "按甲方案做")?.time === "14:00", JSON.stringify(find(d, "按甲方案做")));
  const dup = find(d, "列宽可以拖动,但要记住");
  assert("同一句在 journal 和设计页各记一处 → 合成一条、出处两处",
    dup?.sources?.length === 2 && dup.sources.map((s) => s.path).join() === "docs/design/list.md,docs/journal.md", JSON.stringify(dup?.sources));
  assert("设计页按严格判据:只有时刻、没写原话的「好」不收", !find(d, "好"));
  assert("CLAUDE.md:讲规矩的「做这个」「照这个做」不收,出处行里的原话收",
    !find(d, "做这个") && !find(d, "照这个做") && find(d, "报号的时候带上一句话说明")?.date === "2031-02-20", JSON.stringify(d?.quotes?.map((q) => q.text)));
  assert("塔的 SKILL.md 也扫(严格),记录塔取目录名 dev", find(d, "没有规格不开工")?.tower === "dev", JSON.stringify(find(d, "没有规格不开工")));
  assert("tower-meta/references/ 是框架文件,不扫(那里引的是框架作者那边的用户)", !find(d, "框架作者那边说的"));
  assert("默认不扫 docs/product/(访谈里的「用户」是产品的用户)、docs/research/", !find(d, "希望能批量改") && !find(d, "调研里引的一句"));
  assert("记录塔认配置 boards 里的 alpha", find(d, "这条记在 alpha 塔")?.tower === "alpha", JSON.stringify(find(d, "这条记在 alpha 塔")));
  const url = `https://github.com/acme/widget/blob/${sha}/docs/journal.md#L${lineOf(JOURNAL, "先做列表页")}`;
  assert("出处链接用配置里的 repo(acme/widget)、那一版的 sha、那一行", q1?.sources?.[0]?.url === url && d?.repo === "acme/widget", `${q1?.sources?.[0]?.url} vs ${url}`);
  assert("generatedAt 按配置的时区(Asia/Tokyo)", /^2031\/03\/20\D*12:00 \(Asia\/Tokyo\)$/.test(d?.generatedAt ?? "") && d?.timezone === "Asia/Tokyo", d?.generatedAt);
  const st = cli(P, []);
  assert("不带 --json:打统计,条数跟 --json 一致", st.code === 0 && st.out.includes(`正文 ${d?.quotes?.length} 条`) && /docs\/journal\.md/.test(st.out), st.out.slice(0, 300));
}
{
  const r = cli(P, ["--json", "--also", "docs/product/"]);
  const q = find(r.j, "希望能批量改");
  assert("--also docs/product/:多扫这一处(严格判据),记录塔取目录名", q?.date === "2031-03-06" && q?.tower === "product" && !find(r.j, "调研里引的一句"), JSON.stringify(q));
}
// 配置换了,结果跟着变:去掉 repo / boards / timezone
{
  put(P, ".claude/belltower.json", "{}\n");
  const r = cli(P, ["--json"]);
  const q1 = find(r.j, "先做列表页,详情页下个月再说");
  assert("配置没 repo、origin 也不是 GitHub 地址 → 不给链接", r.j?.repo === null && q1?.sources?.[0]?.url === null, JSON.stringify(q1?.sources));
  assert("配置没 boards → 默认清单里没有 alpha,不认", find(r.j, "这条记在 alpha 塔")?.tower === null);
  assert("配置没 timezone → generatedAt 用默认 America/New_York", /\(America\/New_York\)$/.test(r.j?.generatedAt ?? ""), r.j?.generatedAt);
  g(P, "remote", "set-url", "origin", "https://github.com/acme/gadget.git");
  const r2 = cli(P, ["--json"]);
  assert("配置没 repo → 从 origin 的地址现解析(acme/gadget)",
    r2.j?.repo === "acme/gadget" && /^https:\/\/github\.com\/acme\/gadget\/blob\/[0-9a-f]{40}\/docs\/journal\.md#L\d+$/.test(find(r2.j, "先做列表页,详情页下个月再说")?.sources?.[0]?.url ?? ""),
    JSON.stringify(find(r2.j, "先做列表页,详情页下个月再说")?.sources));
  g(P, "remote", "set-url", "origin", ORIGIN);
}
// timezone 写坏了:单子照出,按默认时区(lib/config.mjs 把认不得的时区换成默认值,lib/now.mjs 就不会抛错)
{
  put(P, ".claude/belltower.json", JSON.stringify({ timezone: "Mars/Olympus" }) + "\n");
  const r = cli(P, ["--json"]);
  assert("timezone 写坏了:照样出单子不崩,按默认时区 America/New_York",
    r.code === 0 && r.j?.quotes?.length > 0 && r.j?.timezone === "America/New_York" &&
    /\(America\/New_York\)$/.test(r.j?.generatedAt ?? ""), `code=${r.code} ${r.err.slice(0, 200)} ${r.j?.timezone} ${r.j?.generatedAt}`);
  put(P, ".claude/belltower.json", "{}\n");
}
// --ref:本地新提交没推 → 默认(origin/main)看不到,--ref HEAD 看得到
{
  g(P, "add", "-A"); g(P, "commit", "-qm", "第二笔");
  assert("默认读 origin/main:本地没推的提交不算", !find(cli(P, ["--json"]).j, "工作树里没提交的"));
  assert("--ref HEAD:读本地这一版", !!find(cli(P, ["--json", "--ref", "HEAD"]).j, "工作树里没提交的"));
}
// 没有 origin/main:说清楚、退出 2,不吐一堆 git 报错
{
  const Q = tmp("uq-noorigin-");
  g(Q, "init", "-q", "-b", "main");
  g(Q, "config", "user.email", "t@example.com"); g(Q, "config", "user.name", "t");
  put(Q, "docs/journal.md", "# 行为流水\n");
  g(Q, "add", "-A"); g(Q, "commit", "-qm", "x");
  const r = cli(Q, ["--json"]);
  assert("读不到 origin/main → 退出 2,提示先 fetch 或用 --ref", r.code === 2 && /读不到 origin\/main/.test(r.err) && /--ref/.test(r.err), `code=${r.code} ${r.err.slice(0, 200)}`);
}

for (const d of TMPS) rmSync(d, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(`\nuser-quotes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
