#!/usr/bin/env node
// Stop 闸门 6(没证据不许说完成)/ 8(改了 harness 没合 main)/ 12(台账 PR 没合)/ 14(要对方动手的留言没按门铃)/
// 15(门铃没送到)/ 7(改了文件要写 journal)/ 9(上下文过半)。
// ★ 8 排在 7 前面:harness 没合 = 别的塔读不到,比少一行 journal 严重。12 / 14 / 15 跟总线有关,挨着 8。
// 各拦一次,第二次放行。
// block = stdout 输出 {"decision":"block","reason":...};放行 = 无输出 exit 0。
//
// ★全是软闸,偏 fail-open。理由:误放的代价是少一行 journal
//   (自己会发现),误拦的代价是白烧一个会话的收尾 + 错误自诊扩散。
import { readFileSync, existsSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ymd } from "./lib/now.mjs";
import { config, whoAmI } from "./lib/config.mjs";

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

// ── 仓库内的改动(闸门6、7 共用)────────────────────────────────────────
// guard-edit 往旗标里记 `edit:<路径>`:仓库内的文件记相对路径,**仓库外的记绝对路径**
// (scratchpad、/tmp 里的一次性脚本)。第一版两道闸都不分 —— 只在 scratchpad 里写了个临时 .py,
// 收尾说「完成」就会被闸门6 拦「改过源文件没贴证据」,再被闸门7 要一行 journal。
// 仓库外的一次性脚本不算「改过代码」,也不算「改过文件」。
// 仓库内 = 不以 / 开头、不是盘符开头(X:/ 或 X:\)、不以 ../ 开头。
// (闸门8 本来就锚定相对路径,不用这一条。)
const EDITED_IN_REPO = /^edit:(?![\\/]|[A-Za-z]:[\\/]|\.\.[\\/])/m;

// ── 闸门6:改过源文件却在没有回归证据时宣布完成(铁律3、4)──────────────
// 出处:改完代码说「修好了」、实际没重测,同类旧错复发了好几轮 —— 用户得反过来提醒「你要自己重测」。
// 「源文件」= 配置 codeExt 里的扩展名(默认 py / ts / tsx / js / jsx / sql),而且得在仓库里(见上)。
// 证据 = 转录里出现测试实际输出(PASS / OK / 数字比分 / 「回归全绿」字样)。
const CODE_EXT = config().codeExt.map((e) => e.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean);
const EDITED_CODE = new RegExp(`${EDITED_IN_REPO.source}.*\\.(${CODE_EXT.join("|") || "py"})$`, "m");
const CLAIMS_DONE = /(完成|已修好|修好了|已上线|搞定|\bdone\b|\bfixed\b|\ball set\b)/i;
const HAS_EVIDENCE = /(ALL PASS|\bPASS\b|\bOK\b|Gate ?A|\d+\s*\/\s*\d+|回归(全)?绿|测试通过)/i;
if (EDITED_CODE.test(flags) && CLAIMS_DONE.test(lastText) &&
    !HAS_EVIDENCE.test(lastText) && !/^testrun$/m.test(flags) &&
    !flags.includes("gatea-reminded")) {
  remember("gatea-reminded");
  block("闸门6:本会话改过源文件,而这条收尾说了「完成」却没有回归证据(铁律「说完成前贴证据」)。\n" +
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
// 判据现查,不看记号文件说了算:工作树的直推清单 和 origin/main 上的那份一样吗?
//   一样 = PR 已经合了(或者压根没进 PR 模式),顺手把记号删掉;
//   不一样 = 还没合,别的塔一行都读不到,拦一次。
// 清单跟 ledger-push 读同一份(scripts/lib/direct-push.mjs:台账四件 + 配置 directPush 放行的)——
//   走同一条路上 main 的文件,这道收尾关也得一样管。引用失败(装漏了那个文件)退回下面写死的台账四件。
const PENDING = ".claude/.session-state/ledger-pending.json";
let LEDGER_FILES = ["docs/journal.md", "docs/BACKLOG.md",
                    "docs/session-pool.md", "docs/gate-log.md"];
try { LEDGER_FILES = (await import("../../scripts/lib/direct-push.mjs")).DIRECT_PUSH; } catch {}
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
            "  2) pull_request_read 读实际状态,能合就 merge_pull_request;\n" +
            "     PR 上真跑 CI 且还没跑完,才用 enable_pr_auto_merge 等它绿了自己合\n\n" +
            "  PR 报 not mergeable = 别的塔先合了它的台账,**重跑一次 " +
            "`node scripts/ledger-push.mjs`** 即可。\n" +
            "  合掉之后这个记号本闸会自己清掉(它查的是台账进没进 main,不是这个文件)。\n" +
            "  (本闸只拦这一次,再 Stop 就放行。)");
    }
  }
}

// ── 门铃的共用件(闸门14、15)──────────────────────────────────────────────
// 载不进来 = 这两道跳过,别的闸照跑(闸门自己坏了要放行)。transcript 只在真要用时读一次。
let bell = null;
try { bell = await import("./lib/doorbell.mjs"); } catch {}
const flagLines = flags.split("\n");
const hasLine = (k) => flagLines.includes(k);     // 按整行比对:带时刻的键用 includes 会前缀误中
let evCache;
const transcriptEvents = () => {
  if (evCache === undefined) {
    const entries = bell.readTranscript(input.transcript_path);
    evCache = entries ? bell.events(entries) : null;
  }
  return evCache;
};

// ── 闸门14:要对方动手的留言,同一轮得按门铃(软闸,拦一次)────────────────────
// 出处:规矩早写着「只写留言板不按门铃 = 对方不知道」(tower.md〈平台事实〉),一次犯先记文字规矩 ——
//   装了框架的项目又犯了两次:写给别的塔的留言只进了收件箱,对方没被叫醒(有一次是用户把话贴过去,对方才看到)。所以上闸。
// 记账在 guard-edit(往 BACKLOG 新增留言 → 旗标 `relay:<目标们>:<毫秒>`);这里核:
//   留言时刻之后,每个目标塔都有一个门铃绑在它**当前会话**上 —— 活表塔表「会话 ID」格的第一个 session_…,去前缀比。
//   门铃从哪几处认见 lib/doorbell.mjs 的 bellsOf(fire_trigger 回执 / 建门铃时绑的会话 / 带 run_once_at 自己会响的 /
//   PostToolUse 记下的回执)。活表里查不到那个塔的会话(没这一行、还待开)→ 核不了对不对,
//   只看留言之后有没有按过「活表认不出是哪个塔」的门铃,这样的目标有几个就要几个
//   (绑在活表里别的塔会话上的门铃是给那个塔的,不算)。
// 放行口子:留言之后回复里单独一行「不按门铃:理由」(只是告知、不用对方动手);拦过一次,原样再停也放行。
if (bell) {
  const pending = flagLines.filter((l) => l.startsWith("relay:")).map((l) => l.slice(6))
    .filter((id) => /^[a-z0-9+-]+:\d+$/.test(id) && !hasLine(`relay-ok:${id}`) && !hasLine(`relay-reminded:${id}`));
  const ev = pending.length ? transcriptEvents() : null;   // 快路:没有待核的留言就不读 transcript
  if (ev) {                                                 // transcript 读不了 → 放行(fail-open)
    const pool = bell.readPool();
    const sessOf = (x) => bell.bareSid(bell.poolSession(x, pool) ?? "");
    const taken = config().boards.map(sessOf).filter(Boolean);   // 活表认得出是哪个塔的会话
    const bells = bell.bellsOf(ev.calls, flags);
    const missed = [];
    for (const id of pending) {
      const ms = Number(id.slice(id.lastIndexOf(":") + 1));
      const targets = id.slice(0, id.lastIndexOf(":")).split("+");
      const after = bells.filter((b) => b.ts > ms);
      const known = new Set([...taken, ...targets.map(sessOf).filter(Boolean)]);
      const unrung = targets.filter((x) => sessOf(x) && !after.some((b) => b.sid === sessOf(x)));
      const blind = targets.filter((x) => !sessOf(x));
      const spare = new Set(after.filter((b) => !known.has(b.sid)).map((b, i) => b.sid || `?${i}`)).size;
      if (blind.length > spare) unrung.push(...blind);
      if (!unrung.length || bell.ringWaiver(ev.texts, ms) !== null) remember(`relay-ok:${id}`);
      else missed.push({ id, targets, unrung });
    }
    if (missed.length) {
      for (const m of missed) remember(`relay-reminded:${m.id}`);
      const towers = [...new Set(missed.flatMap((m) => m.unrung))];
      block("闸门14:本会话往 docs/BACKLOG.md 收件箱写了给别的塔的留言,**之后没按对应塔的门铃** —— 对方不会醒来读:\n" +
            missed.map((m) => `  · → ${m.targets.join(" + ")}` +
              (m.unrung.length < m.targets.length ? `(没按:${m.unrung.join("、")})` : "")).join("\n") +
            "\n\n只写留言板不按门铃 = 对方不知道(实测过:两条问题只写了收件箱,对方晚了约 7 小时才看到)。" +
            "\n配方:留言先 `ledger-push` 上 main,再 `create_trigger`(`persistent_session_id` = 对方塔当前会话," +
            "不给 cron 也不给 run_once_at)→ `fire_trigger`;门铃里只说去读收件箱哪一行。" +
            "\n对方塔当前会话(活表塔表「会话 ID」格的第一个,先核再按):\n" +
            towers.map((x) => `  · ${x}:${bell.poolSession(x, pool) ??
              "活表里没有 —— 去 origin/main 的 docs/session-pool.md 查;那个塔还没开就不用按"}`).join("\n") +
            "\n塔断开了照按新门铃,叫得醒,不用等用户去它窗口说话;已断开的工人叫不醒(platform-facts §1.1)。" +
            "\n按之前可以先 `get_session` 看一眼对方的 `connection_status`。" +
            "\n\n不用对方动手的(只是告知),回复里单独一行以「不按门铃:理由」开头,放行。" +
            "\n已经按过了(比如上一轮),原样再来一次就放行(本闸只拦这一次)。");
    }
  }
}

// ── 闸门15:门铃没送到(软闸,每个门铃提醒一次)──────────────────────────────
// 出处:装了框架的项目实测 —— 回执里的 cse_<Y> 跟门铃绑的 session_<X> 对不上,话就落进了平台新开的空会话:
//   同一个门铃按第二次是这样,往已断开的工人按新门铃也是这样(platform-facts §1.1)。按的人以为送到了,对方根本没收到。
// 判据:guard-mcp 在 PostToolUse 记下的回执(旗标 `bell:…`)里,绑的和落进的去掉前缀不相等。
// 已经善后的不提醒:之后又有一个门铃送到了同一个目标;或者之后没报错地归档 / 打断了落错的那个会话
//   (transcript 里的 archive_session / interrupt_session,要有结果:只有调用、没有结果的不算善后,跟闸门14「按过要有凭据」一样)。
//   —— 那个项目第一版不认善后,善后完了又被拦一次,冤。
// 回执认不出 = guard-mcp 没记,这道闸就不响(fail-open)。
if (bell) {
  const rings = bell.parseBells(flags);
  let lost = rings.filter((b) => b.want && b.got && b.want !== b.got && !hasLine(`lost-reminded:${b.key}`));
  if (lost.length) {
    const calls = transcriptEvents()?.calls ?? [];
    lost = lost.filter((b) =>
      !rings.some((o) => o.ms > b.ms && o.want === b.want && o.got === o.want) &&
      !calls.some((c) => c.ts > b.ms && !c.isError && c.result !== null &&
        (bell.isTool(c.name, "archive_session") || bell.isTool(c.name, "interrupt_session")) &&
        bell.bareSid(c.input?.session_id) === b.got));
  }
  if (lost.length) {
    for (const b of lost) remember(`lost-reminded:${b.key}`);
    block("闸门15:门铃**没送到** —— 回执里落进的会话跟门铃绑的对不上,话落进了平台新开的空会话,目标没收到:\n" +
          lost.map((b) => `  · ${b.trigger}:绑的 session_${b.want},落进 cse_${b.got}`).join("\n") +
          "\n\n送达判据:回执的 `cse_<Y>` 去掉前缀,跟门铃绑的 `session_<X>` 去掉前缀相等(platform-facts §1.1)。" +
          "\n先 `get_session` 看目标的 `connection_status`:" +
          "\n  · 目标是**塔**(断开的塔新门铃也叫得醒),或者没断开:**新建**一个门铃(`create_trigger` 绑目标会话)再按一次;" +
          "**别重按旧的** —— 同一个门铃按第二次会掉进新开的空会话;" +
          "\n  · 目标是 `disconnected` 的**工人**:别再按,新门铃也落空;要返工就派一个新工人到同一个分支。" +
          "\n落错的那个空会话顺手归档(`archive_session`);按错的门铃停用、别删(删例程会连它开出来的会话一起删)。" +
          "\n(每个门铃只提醒这一次,再 Stop 就放行。)");
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
// 末行可以写成列表项(「- 2026-…」「* 2026-…」),先剃掉列表记号再看日期 ——
// 第一版只认「日期打头」,用列表写 journal 的项目每次必误拦(是装了框架的项目报上来的)。
const journalWrittenToday = () => {
  try {
    const lines = readFileSync("docs/journal.md", "utf8").split(/\r?\n/)
      .map((s) => s.trim()).filter(Boolean);
    const last = (lines[lines.length - 1] ?? "").replace(/^[-*+]\s+/, "");
    if (!last.startsWith(ymd())) return false;
    return journalTouchedThisSession();
  } catch { return false; }
};
// 工人不拦:任务书规定工人不写台账(dispatch.md),拦它等于逼它违规。
// 认法 = 云会话、活表读得到、但活表里没有它的塔行(whoAmI)。认不出来(本机会话、活表缺)照旧拦。
const iAmWorker = (() => { try { const w = whoAmI(); return w.remote && w.pool && !w.board; } catch { return false; } })();
// 「改过文件」只认仓库内的(EDITED_IN_REPO,见闸门6 上面):只动了仓库外的临时文件不用写 journal。
if (!iAmWorker && EDITED_IN_REPO.test(flags) && !/^edit:docs\/journal\.md$/m.test(flags) &&
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
// ★ v3(2026-09-25,两层:自动压缩 30 万 + 定期深度重开 —— 当时每周,0.3.0 起每月、由巡检塔做):
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
