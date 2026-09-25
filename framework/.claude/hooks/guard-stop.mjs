#!/usr/bin/env node
// Stop 闸门 6(没证据不许说完成)/ 8(改了 harness 没合 main)/ 12(台账 PR 没合)/ 7(改了文件要写 journal)/ 9(上下文过半)。
// ★ 8 排在 7 前面:harness 没合 = 别的塔读不到,比少一行 journal 严重。
// 各拦一次,第二次放行。
// block = stdout 输出 {"decision":"block","reason":...};放行 = 无输出 exit 0。
//
// ★全是软闸,偏 fail-open。理由:误放的代价是少一行 journal
//   (自己会发现),误拦的代价是白烧一个会话的收尾 + 错误自诊扩散。
import { readFileSync, existsSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ymd } from "./lib/now.mjs";
import { config } from "./lib/config.mjs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
if (input.stop_hook_active) process.exit(0); // 防循环

const stateFile = join(".claude/.session-state", `${input.session_id ?? "unknown"}.flags`);
const flags = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "";
const remember = (k) => { try { appendFileSync(stateFile, k + "\n"); } catch {} };
const block = (reason) => { console.log(JSON.stringify({ decision: "block", reason })); process.exit(0); };

// 取最后一条 assistant 文本
let lastText = "";
try {
  const lines = readFileSync(input.transcript_path, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    if (e.type === "assistant" && e.message?.content) {
      lastText = e.message.content.map((c) => c.text ?? "").join("\n");
      break;
    }
  }
} catch {}

// ── 闸门6:改过源文件却在没有回归证据时宣布完成(铁律3、4)──────────────
// 出处:改完代码说「修好了」、实际没重测,同类旧错复发了好几轮 —— 用户得反过来提醒「你要自己重测」。
// 「源文件」= 配置 codeExt 里的扩展名(默认 py / ts / tsx / js / jsx / sql)。
// 证据 = 转录里出现测试实际输出(PASS / OK / 数字比分 / 「回归全绿」字样)。
const CODE_EXT = config().codeExt.map((e) => e.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
const EDITED_CODE = new RegExp(`^edit:.*\\.(${CODE_EXT.join("|") || "py"})$`, "m");
const CLAIMS_DONE = /(完成|已修好|修好了|已上线|搞定|\bdone\b|\bfixed\b|\ball set\b)/i;
const HAS_EVIDENCE = /(ALL PASS|\bPASS\b|\bOK\b|Gate ?A|\d+\s*\/\s*\d+|回归(全)?绿|测试通过)/i;
if (EDITED_CODE.test(flags) && CLAIMS_DONE.test(lastText) &&
    !HAS_EVIDENCE.test(lastText) && !/^testrun$/m.test(flags) &&
    !flags.includes("gatea-reminded")) {
  remember("gatea-reminded");
  block("闸门6:本会话改过源文件,而这条收尾说了「完成」却没有回归证据(铁律4)。\n" +
        "先自己重跑测试,把实际输出贴出来;\n" +
        "或者用户已经说「就这样」,那就直接收尾。");
}

// ── 闸门8:改了 harness 却没合进 main(软闸,拦一次)───────────────────────
// 出处(2026-09-10):台账有 ledger-push 一条命令直推 main,写完就到位;
//   而 skill / CLAUDE.md / hooks / scripts 要开 PR 合并,写完顺手就去说下一件事了。
//   后果:新配方在自己分支上躺着,用户按给的路径去找 —— 不存在;
//   再让用户挨个去叫塔来拉,拉的是空气。两条路径一条自动一条手动,手动那条靠记性 = 必漏。
// 判据:本会话动过 harness 路径的文件,且此刻这些改动还没出现在 origin/main 上。
const HARNESS = /^edit:(CLAUDE\.md|\.claude\/(skills|hooks|agents)\/|scripts\/)/m;
if (HARNESS.test(flags) && !flags.includes("mainmerge-reminded")) {
  const touched = [...flags.matchAll(/^edit:(.+)$/gm)].map((m) => m[1])
    .filter((f) => /^(CLAUDE\.md|\.claude\/(skills|hooks|agents)\/|scripts\/)/.test(f));
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });
  let unmerged = [];
  try {
    git("fetch", "-q", "origin", "main");
    // 逐个比:工作树里的这个文件,和 origin/main 上的那份,内容一样吗
    for (const f of [...new Set(touched)]) {
      if (!existsSync(f)) continue;
      let onMain = null;
      try { onMain = git("show", `origin/main:${f}`); } catch { onMain = null; }   // main 上没有 = 新文件没合
      const local = readFileSync(f, "utf8");
      if (onMain === null || onMain !== local) unmerged.push(f);
    }
  } catch { process.exit(0); }   // fail-open:查不了就放行,闸门瘫了不该让工作瘫
  if (unmerged.length) {
    remember("mainmerge-reminded");
    block("闸门8:本会话改过 harness,但这些改动**还没进 origin/main**,别的塔一个都读不到:\n" +
          unmerged.map((f) => "  · " + f).join("\n") +
          "\n\nharness 不像台账 —— 台账 `node scripts/ledger-push.mjs` 一条命令直推 main;" +
          "\nharness 要开 PR 合并。**写完没合 = 只有你自己有。**" +
          "\n\n现在就合(mcp__github__create_pull_request → merge_pull_request),或者明确说清为什么先不合。" +
          "\n合完再说「各塔 merge 一下」才有意义;顺序反了就是让人去拉空气。" +
          "\n(本闸只拦这一次,再 Stop 就放行。)");
  }
}

// ── 闸门12:台账推成分支了,PR 还没合(软闸,拦一次)──────────────────────
// 出处(2026-09-10):main 一上分支保护,`ledger-push` 就推不动
//   main 了 —— 它改成推一个 ledger/* 分支,**由塔用 MCP 开 PR 再合**。
//   问题是后半截脚本干不了,只能靠塔记得做;而「两条路径一条自动一条手动,
//   手动那条靠记性 = 必漏」正是闸门8 的出处,同一个病不该犯第二次。
// 判据现查,不看记号文件说了算:工作树的台账四件 和 origin/main 上的那份一样吗?
//   一样 = PR 已经合了(或者压根没进 PR 模式),顺手把记号删掉;
//   不一样 = 还没合,别的塔一行都读不到,拦一次。
const PENDING = ".claude/.session-state/ledger-pending.json";
const LEDGER_FILES = ["docs/journal.md", "docs/BACKLOG.md",
                      "docs/session-pool.md", "docs/gate-log.md"];
// ★「拦一次」只管**拦**,不管**查**:查和自清理每次 Stop 都做。
//   否则拦过一次之后整段跳过,PR 合掉了记号也没人清,下个会话继续被它绊。
if (existsSync(PENDING)) {
  let p = null;
  try { p = JSON.parse(readFileSync(PENDING, "utf8")); } catch {}
  if (p?.branch) {
    const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });
    let synced = false;
    try {
      git("fetch", "-q", "origin", "main");
      synced = LEDGER_FILES.every((f) => {
        if (!existsSync(f)) return true;
        try { return git("show", `origin/main:${f}`) === readFileSync(f, "utf8"); }
        catch { return false; }          // main 上没有这个文件 = 没合
      });
    } catch { process.exit(0); }         // fail-open:查不了就放行
    if (synced) {
      try { unlinkSync(PENDING); } catch {}   // 合了,自清理
    } else if (!flags.includes("ledgerpr-reminded")) {
      remember("ledgerpr-reminded");
      block("闸门12:台账已经推成分支 **" + p.branch + "**,但**还没进 origin/main** —— " +
            "别的塔一行都读不到。\n\n" +
            "main 上了分支保护,直推走不通了,所以 `ledger-push` 只把台账推成分支;" +
            "**开 PR 和合 PR 是你的事**:\n" +
            "  1) mcp__github__create_pull_request  base=main head=" + p.branch + "\n" +
            "     title=" + JSON.stringify(p.title ?? "台账同步") + "\n" +
            "  2) mcp__github__enable_pr_auto_merge(CI 绿了自动合,不用等)\n" +
            "     或者等 CI 绿之后 pull_request_read 看过实际状态再 merge_pull_request\n\n" +
            "  PR 报 not mergeable = 别的塔先合了它的台账,**重跑一次 " +
            "`node scripts/ledger-push.mjs`** 即可。\n" +
            "  合掉之后这个记号本闸会自己清掉(它查的是台账进没进 main,不是这个文件)。\n" +
            "  (本闸只拦这一次,再 Stop 就放行。)");
    }
  }
}

// ── 闸门7:改过文件但没写 journal(软闸,提醒一次)────────────────────────
// 三条路任一成立即放行:①Edit/Write 写过 journal ②Bash 写过(guard-bash 补同一旗标)
// ③journal 末行是今日 **且本会话期间动过它**。
// 第三条为什么还要看 mtime:一天开好几个会话,当天第一条 journal 一落地,
// 光看「末行是今日」就会对当天剩下所有会话全天放行。
const journalTouchedThisSession = () => {
  try {
    const born = statSync(input.transcript_path).birthtimeMs;
    if (!born) return true;
    return statSync("docs/journal.md").mtimeMs >= born;
  } catch { return true; }
};
const journalWrittenToday = () => {
  try {
    const lines = readFileSync("docs/journal.md", "utf8").split(/\r?\n/)
      .map((s) => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? "";
    if (!last.startsWith(ymd())) return false;
    return journalTouchedThisSession();
  } catch { return false; }
};
if (/^edit:/m.test(flags) && !/^edit:docs\/journal\.md$/m.test(flags) &&
    !journalWrittenToday() && !flags.includes("journal-reminded")) {
  remember("journal-reminded");
  block("闸门7:本会话改过文件,而 docs/journal.md 末行不是今日、本会话也没写过它。\n" +
        "追加一行:日期 · 板块 · 任务 · 干了什么 · 产出在哪。");
}

// ── 闸门9:上下文过半 —— 落盘先于压缩(软闸,拦一次)────────────────────
// 规矩早写着(`tower-meta/SKILL.md`「上下文经济六条」):**落盘先于压缩**。
// 问题是**塔看不见自己用了多少** —— 会话拿不到自己的 token 数,看不见的阈值等于没有阈值。
//
// ★ 第一版拿**转录文件大小**估,错得离谱,当天就误伤了作者自己:
//   报 80%,平台实际 42%(转录 7.7 MB 是**从会话创建起累加的**,`/clear` 和压缩都不换文件,
//   所以它量的是「这个会话一共说过多少」,不是「现在上下文里有多少」)[实测✅ 2026-09-10]。
//   误伤记进了 `docs/gate-log.md`。
// ★ 正解:**转录里本来就有真数,不用估。** 最后一条 assistant 的 `message.usage`:
//   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
//   = 这一轮实际喂进去的上下文。实测 426,283 vs 平台报 418,019,差 2%(还隔了一分钟)。
// ★ v3(2026-09-25,两层:自动压缩 30 万 + 每周深度重开):
//   窗口从 `.claude/settings.json` 的 `autoCompactWindow` **现读**,不写死 —— 写死的数一定跟配置分叉(派生 > 存储)。
//   **只认数字**:平台把字符串 "300k" 静默忽略 [实测 2026-09-24],闸门要是认了,
//   就会以为窗口 30 万、而平台实际按默认窗口压(实测默认在 78.9 万左右才压),提醒就对不上了。
//   有配置 → 窗口的 70% 提醒(留三成余量落盘);没配置 → 老规矩,100 万的一半。
//   **每压缩一次重新提醒一次**:每次压缩在转录里留一条 `"subtype":"compact_boundary"`,
//   标记按「第几次压缩」分开记。旧版整个会话只拦一次 —— 压过一轮之后就再也不提醒了。
let WINDOW = 1_000_000, RATIO = 0.5, AUTO = false;
try {
  const w = JSON.parse(readFileSync(".claude/settings.json", "utf8")).autoCompactWindow;
  if (typeof w === "number" && w >= 100_000 && w <= 1_000_000) { WINDOW = w; RATIO = 0.7; AUTO = true; }
} catch {}
let ctx = 0, compactions = 0;
try {
  const lines = readFileSync(input.transcript_path, "utf8").trimEnd().split("\n");
  compactions = lines.filter((l) => l.includes('"subtype":"compact_boundary"')).length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    const u = e.type === "assistant" && e.message?.usage;
    if (u) {
      ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
      break;
    }
  }
} catch { ctx = 0; }              // 读不了就放行,闸门瘫了不该让工作瘫
const ctxKey = compactions ? `ctx-reminded@${compactions}` : "ctx-reminded";
if (ctx > WINDOW * RATIO && !flags.split("\n").includes(ctxKey)) {
  remember(ctxKey);
  const pct = Math.round((ctx / WINDOW) * 100);
  block(`闸门9:这个会话的上下文已经用掉 **${pct}%**` +
        `(${Math.round(ctx / 1000)}K / ${WINDOW / 1000}K,读的是转录里的真数,不是估的)。\n\n` +
        (AUTO ? `**自动压缩就在前面**(窗口 ${WINDOW / 1000}K 是仓库设置里配的)—— 压缩会丢细节。\n` : "") +
        `「上下文经济六条」的最后一条是**落盘先于压缩**:细节只要已经在盘上就不怕丢。收尾前先做:\n` +
        `  ① 把「做到哪 / 下一步 / 没解决的 / 排着的回查 / 在跑的工人」写回 docs/` +
        `(journal 一行不够,该进 BACKLOG 的进 BACKLOG);\n` +
        `  ② 塔的话:压缩后开局 hook 会从会话 ID 重新认出你是哪个塔,身份不用记;别的只认台账。\n\n` +
        `(每个压缩周期只拦一次,再 Stop 就放行。)`);
}

process.exit(0);
