#!/usr/bin/env node
// PreToolUse(Edit|Write|NotebookEdit)。stdin 解析失败一律放行(fail-open)。
// 闸门:① 冻结清单 ② key 不落盘 ③ 敏感数据不许写进本仓库(铁律1 的默认值)
// ④ 立号先确认 ⑤ 授权词要带用户原话 ⑥ 写「PR 已合」前先查 main
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { config, regex } from "./lib/config.mjs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const fp = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
const sid = String(input.session_id ?? "unknown");
const deny = (m) => { process.stderr.write(m); process.exit(2); };

let rel = "";
try {
  if (fp) {
    const r = relative(resolve("."), resolve(fp)).replaceAll("\\", "/");
    if (r && !r.startsWith("..")) rel = r;   // 仓库外路径不参与判定
  }
} catch {}

const stateFile = join(".claude/.session-state", `${sid}.flags`);
let flags = "";
try { flags = readFileSync(stateFile, "utf8"); } catch {}
const remember = (k) => { try { appendFileSync(stateFile, k + "\n"); } catch {} };
try {
  mkdirSync(".claude/.session-state", { recursive: true });
  appendFileSync(stateFile, `edit:${rel || fp.replaceAll("\\", "/")}\n`);
} catch {}

// ── 闸门1:冻结清单 ─────────────────────────────────────────────────────
try {
  if (existsSync(".claude/frozen.txt")) {
    const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
    const frozen = readFileSync(".claude/frozen.txt", "utf8")
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    if (rel && frozen.some((f) => fold(f) === fold(rel)))
      deny(`闸门1:${rel} 在冻结清单(.claude/frozen.txt)里。要动它先跟用户确认。`);
  }
} catch {}

// ── 闸门2:key 不落盘 ───────────────────────────────────────────────────
if (/(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/
    .test(JSON.stringify(input.tool_input ?? {})))
  deny("闸门2:写入内容里出现 API key 形状,拒绝落盘。");

// ── 闸门3:敏感数据不许写进本仓库(铁律1)─────────────────────────────
// 这是**确认闸不是禁令**:真实数据往往是唯一的验证素材,迟早要用。
// 但不许自动流进来 —— 要用哪一份、脱敏到什么程度、进不进版本库,逐次问用户。
// 路径模式来自配置 sensitivePaths.edit(空 = 关掉)。
const SENSITIVE = regex(config().sensitivePaths.edit);
if (rel && SENSITIVE && SENSITIVE.test(rel))
  deny(`闸门3:${rel} 看起来是**敏感数据**,不是本项目自己的东西(铁律1)。\n` +
       `默认不进本仓库。真要用这一份:先跟用户确认「取哪一份 / 脱敏到什么程度 / 进不进版本库」,\n` +
       `拿到确认后改 .gitignore 和 .claude/belltower.json 的规则,不要绕过这道闸。`);

// ── 闸门4:往执行队列加 Qn 行 —— 先确认用户点过头(软闸,拦一次)──────────
// 出处(2026-09-10):一个塔自己挑了一件活、自己立号、自己派工人,用户没说过要;
//   转头又替别的塔在队列里写了一行号。用户的反应是「这是什么、谁创建的、我说过吗」。
//   「派发权收归执行方」早写在规矩里 —— 照抄了说法、没照抄做法。
// 判据:这次编辑让 docs/BACKLOG.md **多出**一个队列行号 `| Qnn |`(删行、改行、别的文件都不管)。
// ★ 软闸不是禁令:用户点过头的立号是正常动作,拦一次问一句就放行。
const QROW = /^\|\s*(Q\d{2,})\s*\|/gm;
const qrows = (t) => new Set([...String(t ?? "").matchAll(QROW)].map((m) => m[1]));
if (rel === "docs/BACKLOG.md" && !flags.includes("qrow-reminded")) {
  const ti = input.tool_input ?? {};
  const before = ti.old_string !== undefined
    ? ti.old_string
    : (existsSync(fp) ? (() => { try { return readFileSync(fp, "utf8"); } catch { return ""; } })() : "");
  const after = ti.new_string !== undefined ? ti.new_string : (ti.content ?? "");
  const had = qrows(before);
  const added = [...qrows(after)].filter((q) => !had.has(q));
  if (added.length) {
    remember("qrow-reminded");
    deny(`闸门4:这一笔往执行队列加了新单号 ${added.join(" / ")}。立号前先过两道:\n` +
         `  ① **用户说过要做这件活吗?** 没有就别立 —— 塔不许自己挑活自己派(禁止自主加 Q)。\n` +
         `  ② **这个号是不是你自己板块的?** 派发权归执行方,别的塔的活不许替它立号。\n` +
         `两条都过了,原样再来一次就放行(本闸只拦这一次)。`);
  }
}

// ── 闸门5:授权词要带用户原话(塔不许给自己签字)──────────────────────
// 出处(2026-09-10):一条「等用户拍板,阻塞全部开发」的条目,被 plan 塔自己评审完、
//   自己在台账写下「有条件通过,开发解除阻塞」;dev 塔读到这行就派了工人,第一批代码合进 main。
//   **全程没有用户那句「可以开工」** —— 用户那会儿还在跟 plan 聊设计。
//   铁律6 拦的是「立号」,拦不住「解除阻塞」—— 判据写在台账里,而台账是塔自己写的。
// 判据:往台账里**新增**授权词,而同一笔里没有「用户 + 时刻/原话」。
// ★ 软闸:用户真点过头的是正常动作,拦一次让你把原话贴上就放行。
const AUTH_WORD = /(解除阻塞|评审通过|评审已过|已授权|可以开工|准予开工|用户同意|用户已?批准|批准开工)/g;
const LEDGER_MD = /^docs\/(BACKLOG|journal|session-pool|gate-log)\.md$/;
const tiOf = () => input.tool_input ?? {};
const beforeText = () => {
  const ti = tiOf();
  if (ti.old_string !== undefined) return String(ti.old_string);
  try { return existsSync(fp) ? readFileSync(fp, "utf8") : ""; } catch { return ""; }
};
const afterText = () => {
  const ti = tiOf();
  return String(ti.new_string !== undefined ? ti.new_string : (ti.content ?? ""));
};
if (LEDGER_MD.test(rel) && !flags.includes("authword-reminded")) {
  const after = afterText(), before = beforeText();
  const cnt = (t) => (String(t).match(AUTH_WORD) || []).length;
  const words = [...new Set((after.match(AUTH_WORD) || []))];
  // 同一笔里已经给出用户凭据(提到用户 + 一个时刻,或写了「原话」)就放行
  const hasProof = /用户/.test(after) && (/\d{1,2}:\d{2}/.test(after) || /原话/.test(after));
  if (cnt(after) > cnt(before) && !hasProof) {
    remember("authword-reminded");
    deny(`闸门5:这一笔往台账里写了授权词 ${words.join(" / ")},但没写**谁批的**。\n` +
         `  台账是塔自己写的 —— 你在这儿写「解除阻塞」,别的塔读到就当真去开工了。\n` +
         `  **2026-09-10 就是这么出的事**:plan 塔自己评审完自己写「开发解除阻塞」,\n` +
         `  dev 读到就派了工人,代码进了 main,而用户那会儿还在跟 plan 聊设计。\n\n` +
         `  要么把**用户的原话 + 时刻**写进同一段(「用户 22:22 ET:『……』」),\n` +
         `  要么改个说法 —— 「plan 塔的评审结论是 X」跟「开发解除阻塞」不是一回事。\n` +
         `  (本闸只拦这一次,再来就放行。)`);
  }
}

// ── 闸门6:写「PR 已合」之前,自己去 main 上看一眼 ──────────────────────
// 出处(2026-09-10):工人三次把「我开了 PR」写成「已经合了」;
//   配方 §6 写着「收活时塔自己查 PR,不认工人自述」,而同一晚三个塔收活,
//   **两个没查**,都照抄了工人的「merged」。文字规矩治不了,所以上闸。
// 判据:台账里写 PR #n 已合,而 origin/main 的历史里找不到 (#n)。
// ★ 软闸:合并方式不同可能不留 (#n) 后缀,硬拦会误伤;但把实查结果摆出来。
if (LEDGER_MD.test(rel) && !flags.includes("prmerged-reminded")) {
  const after = afterText(), before = beforeText();
  const seen = new Set([...String(before).matchAll(/#(\d+)/g)].map((m) => m[1]));
  const claims = [...String(after).matchAll(/#(\d+)[^\n]{0,40}?(已合|合了|合入|merged)/gi)]
    .map((m) => m[1]).filter((n) => !seen.has(n));
  if (claims.length) {
    const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });
    let missing = [];
    try {
      git("fetch", "-q", "origin", "main");
      for (const n of [...new Set(claims)])
        if (!git("log", "origin/main", "--oneline", `--grep=(#${n})`, "-5").trim()) missing.push(n);
    } catch { missing = []; }           // 查不了就放行(fail-open),闸门瘫了不该让工作瘫
    if (missing.length) {
      remember("prmerged-reminded");
      deny(`闸门6:你写了 PR ${missing.map((n) => "#" + n).join(" / ")} **已合**,` +
           `但我在 origin/main 的历史里找不到它:\n` +
           `    git log origin/main --oneline --grep='(#${missing[0]})'   → 没有输出\n\n` +
           `  工人**三次**把「我开了 PR」写成「已经合了」,塔照抄进了台账。\n` +
           `  先自己查一遍 GitHub 再写台账;确实合了(或者合并方式没留 (#n) 后缀)就再来一次放行。`);
    }
  }
}

process.exit(0);
