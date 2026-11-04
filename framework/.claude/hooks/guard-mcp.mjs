#!/usr/bin/env node
// 管几个 MCP 工具 —— 它们是别的闸门够不着的口子(.claude/settings.json 里 grep guard-mcp 看挂在哪):
//   PreToolUse:create_session(闸门13、10、17)· merge_pull_request(闸门11)· pull_request_read(记账)· fire_trigger(闸门16);
//   PostToolUse:create_pull_request · fire_trigger(只记账:开过哪个 PR、门铃回执 —— 回执给 guard-stop 的闸门15 核送达)。
// stdin 解析失败一律放行(fail-open)。除闸门11 的「自己开的代码 PR 不许自己合」,都是**软闸,各拦一次**:
// 拦的是「你确认过了吗」,不是「不许干」。
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config, whoAmI } from "./lib/config.mjs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }

const tool = String(input.tool_name ?? "");
const sid = String(input.session_id ?? "unknown");
const stateFile = join(".claude/.session-state", `${sid}.flags`);
let flags = "";
try { flags = readFileSync(stateFile, "utf8"); } catch {}
// 按整行比对。带编号的旗标(readpr:4)不能用 includes:它会命中 readpr:42 ——
// 读过 #42 就当读过 #4(软闸漏放),开过 #42 就把合 #4 硬拦住(硬闸误拦)。是装了框架的项目报上来的。
const has = (k) => flags.split("\n").includes(k);
const remember = (k) => {
  try { mkdirSync(".claude/.session-state", { recursive: true }); appendFileSync(stateFile, k + "\n"); } catch {}
};
const deny = (m) => { process.stderr.write(m); process.exit(2); };

// ── 记账:这个会话开过哪个 PR、读过哪个 PR ──────────────────────────────
// 闸门11 要的是「代码 PR 不许自己开自己合」。要认出「自己开的」就得记下来 ——
// PreToolUse 拿不到返回值(那时 PR 号还不存在),所以开 PR 这条走 PostToolUse。
const prNo = (t) => { const m = String(t).match(/\/pull\/(\d+)/); return m ? m[1] : null; };
if (/create_pull_request$/.test(tool) && input.tool_response !== undefined) {
  const n = prNo(JSON.stringify(input.tool_response));
  if (n) {
    // 动没动真代码,现在就算 —— 合并的时候工作树可能已经不在这个分支上了
    //
    // ★ 但「当前工作树」只在 head 就是当前分支时才等于 PR 的内容。**台账 PR 不是**:
    //   main 上了分支保护之后 ledger-push 推的是一个 ledger/* 分支,而开 PR 那一刻
    //   工作树还在塔自己的分支上 —— dev 塔那条分支带着代码,照旧算下去会把台账 PR
    //   判成代码 PR;硬闸一拦没有放行口子,**dev 塔以后每记一次账都得求别的塔来合**。
    //   ledger/* 是脚本造的,内容只可能是台账四件(scripts/test-ledger-push.mjs B 组钉着)。
    //   ⚠ 残留:手工造一个叫 ledger/ 的分支塞代码能绕过这条。挡它的是同一道闸的软闸
    //   (合之前必须真 pull_request_read),以及台账 PR 一样要过 CI。
    const head = String(input.tool_input?.head ?? "");
    let code = false;
    if (!/^ledger\//.test(head)) {
      // 「真代码」= 配置 codeDirs 里的目录(默认 src)
      const dirs = config().codeDirs.map((d) => d.replace(/\/+$/, "") + "/");
      try {
        code = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .split("\n").some((f) => dirs.some((d) => f.startsWith(d)));
      } catch {}
    }
    remember(`${code ? "openedcodepr" : "openeddocpr"}:${n}`);
  }
  process.exit(0);
}
if (/pull_request_read$/.test(tool)) {
  const n = input.tool_input?.pullNumber ?? input.tool_input?.pull_number;
  if (n) remember(`readpr:${n}`);
  process.exit(0);
}

// ── 记账:门铃回执(闸门15 核送达、闸门16 认「按过」)────────────────────────
// fire_trigger 的回执里有两样:门铃绑的会话(trigger.persistent_session_id)和实际落进的会话(session_id)。
// PreToolUse 拿不到回执,所以这条走 PostToolUse(跟开 PR 记号一个道理)。
// 记成 `bell:<门铃 id>:<绑的>:<落进的>:<毫秒>`(会话去了前缀)。回执认不出就不记(fail-open)——
// tool_response 包成什么样没实测,拆法见 lib/doorbell.mjs 的 receiptOf。
// 认 PostToolUse 两样都看:事件名,或者带了 tool_response —— 哪样缺了都不许掉进下面拦人的那段(工具已经跑完了)。
const FIRE = /(^|__)fire_trigger$/;
const POST = input.hook_event_name === "PostToolUse" || input.tool_response !== undefined;
const cleanId = (s) => String(s ?? "").replace(/[^\w-]/g, "");   // 旗标用冒号分段,id 里只留字母数字 _ -
if (FIRE.test(tool) && POST) {
  try {
    const { receiptOf, bareSid } = await import("./lib/doorbell.mjs");
    const r = receiptOf(input.tool_response);
    const tid = cleanId(input.tool_input?.trigger_id) || cleanId(r?.trigger);
    if (r && tid) remember(`bell:${tid}:${cleanId(bareSid(r.want))}:${cleanId(bareSid(r.got))}:${Date.now()}`);
  } catch {}
  process.exit(0);
}

// ── 闸门16:一个门铃只按一次 ───────────────────────────────────────────────
// 出处:装了框架的项目实测 —— 同一个门铃第二次按,话不进目标会话,平台另开一个没挂仓库的空会话(platform-facts §1.1);
//   那边有一次交接就写着合完再去按之前建好的两个门铃 —— 重按旧门铃,两个塔都没收到。
// 判据:这个门铃本会话已经按过一次 → 按之前拦一次;原样再来放行。「按过」两处认,哪处有都算:
//   ① PostToolUse 记下的回执(旗标 `bell:<id>:…`,后面带冒号,`trig_1` 不会冒充 `trig_12`);
//   ② transcript 里同一个 id 的 fire_trigger,**有结果、没报错**,而且不是这一次自己。
// ★ ② 为什么只认有结果的:PreToolUse 跑的时候,这次调用自己的 tool_use 已经在 transcript 里、还没结果;
//   同一条消息并发按几个新门铃,兄弟几个也在里面、也没结果。把「没结果」当「没报错」就是拿自己拦自己 ——
//   那个项目第一版就这样误拦过(同一轮并发按三个新建的门铃,后两个被拦,其实一次都没按出去)。
// matcher 写 `mcp__.*__fire_trigger`:云会话里 MCP 服务器名可能是一串 ID,不写死。
if (FIRE.test(tool)) {
  const tid = String(input.tool_input?.trigger_id ?? "");
  if (tid && !has(`refire-reminded:${tid}`)) {
    let pressed = flags.split("\n").some((l) => l.startsWith(`bell:${cleanId(tid)}:`));
    if (!pressed) {
      try {
        const { readTranscript, events, isTool } = await import("./lib/doorbell.mjs");
        pressed = events(readTranscript(input.transcript_path) ?? []).calls.some((c) =>
          isTool(c.name, "fire_trigger") && String(c.input?.trigger_id ?? "") === tid &&
          c.id !== input.tool_use_id && c.result !== null && !c.isError);
      } catch {}
    }
    if (pressed) {
      remember(`refire-reminded:${tid}`);
      deny(`闸门16:门铃 ${tid} 本会话**已经按过一次**了。\n` +
           `  同一个门铃按第二次,话不进目标会话,平台会另开一个没挂仓库的空会话(platform-facts §1.1)。\n` +
           `  要再说一句话:**新建**一个门铃(create_trigger 带 persistent_session_id = 目标会话)再按;\n` +
           `  按完核回执:cse_<Y> 去掉前缀跟 session_<X> 去掉前缀相等才算送到(闸门15 收尾时也核)。\n\n` +
           `  确实要重按这一个,原样再来一次放行。`);
    }
  }
}

// ── 闸门13:开会话要带 source_url + source_revision ─────────────────────────
// 出处(2026-09-26):只传 source_url、不传 source_revision,会话拿得到仓库,但在桌面 App 侧栏里
//   落进「Other」,用户找不到。配方(dispatch.md §4)改了也传不到常驻塔:闸门10 一个会话只拦一次,
//   塔早读过旧配方,不会回去重读 —— 一个项目改完配方后现数,工人里仍有四成没带 revision。
// ★ 软闸:每个标题拦一次,原样再来就放行 —— 平台哪天改了参数名,不至于把派发卡死(fail-open 精神)。
if (/create_session$/.test(tool)) {
  const ti = input.tool_input ?? {};
  const miss = ["source_url", "source_revision"].filter((k) => !ti[k]);
  const key = `srcrev-reminded:${String(ti.title ?? "").slice(0, 60).replace(/\n/g, " ")}`;
  if (miss.length && !has(key)) {
    remember(key);
    deny(`闸门13:这次 create_session 没带 ${miss.map((k) => "`" + k + "`").join("、")}。\n` +
         `  只传 source_url、不传 source_revision 的会话拿得到仓库,但在桌面 App 侧栏里落进「Other」,\n` +
         `  不进项目那一组,用户找不到它(platform-facts §4.1)。两个都写上:\n` +
         `    source_url: <本仓库的 https 地址>   source_revision: "main"\n` +
         `  确实不需要(或者平台改了参数名),原样再来一次就放行。`);
  }
}

// ── 闸门10:派工人也要过铁律6 ────────────────────────────────────────────
// 出处(2026-09-10):闸门4 只看 `docs/BACKLOG.md` 的队列行 ——
//   塔**直接 create_session 不写队列行就整条绕过去**。
//   规矩本身是铁律6:立号前必须有用户那句「做这个」;别的塔的活不许替它立号。
// ★ 这道闸补的是「动作」那一侧,闸门4 补的是「台账」那一侧,两边都要有。
if (/create_session$/.test(tool) && !has("dispatch-reminded")) {
  const t = String(input.tool_input?.title ?? input.tool_input?.prompt ?? "").slice(0, 60);
  remember("dispatch-reminded");
  deny(`闸门10:要派一个工人出去${t ? `(「${t}…」)` : ""}。派之前两句必须答得上来:\n` +
       `  ① **用户说过要做这件活吗?写出处。** —— 台账哪一行、用户原话 + 时刻。\n` +
       `     ★ 不必是对你说的:用户在别的塔说的、原话已落进台账的,一样算;\n` +
       `     找不到那句原话的「转告」不算,先让它落盘(配方 dispatch.md §11)。\n` +
       `  ② **这活是你自己板块的吗?** 派发权归执行方,别的塔的活不许替它派。\n` +
       `  ③ **上一个跑完的工人,归档了吗?** 收了活(PR 合了)就 archive_session ——\n` +
       `     只读保留、释放容器、侧边栏干净。**不是删除**:我们的规矩是「不认工人自述、\n` +
       `     要能回查」,删了转录就查不回去了。判据绑在协议上 —— **活表那行删了就该归档**。\n\n` +
       `  已经发生过两次:塔自己挑了一件活就派了工人,用户事后问「这是什么、我说过吗」。\n` +
       `  两单都真做出了东西、真花了钱 —— 做得对不算数,没人要才是问题。\n\n` +
       `  两条都过了,原样再来一次就放行(本闸只拦这一次)。\n` +
       `  ★ 顺手:派完同一轮排一个 10 分钟回查(dispatch.md §10),别等用户来问。`);
}

// ── 闸门17:派工刹车 —— 同一家号封顶几轮 · 任务书带〔待用户〕先等用户 ──────────────────
// 出处:装了框架的项目里,一夜之间 test 的门铃响了几十次、同一件东西一夜合了 8 轮 —— 环里没有「停」。
//   规矩三条(dispatch.md「刹车」):轻缺陷攒批 · 同一家封顶 · 推断会改行为的等用户。这道闸守后两条的「派」那一刻。
// 判据(共用件 lib/brake.mjs):
//   这次派的号 = 任务书第一个 `# ` 行(没有就用 title)里,优先取派工塔自己号段的号,认不出塔就取第一个;
//   轮次 = 这一家(基号相同 + 任务书「返工自 Qnnn」并进来的家)在 origin/main 已合的不同号 ∪ 这次的号;
//   (a) 轮次 > 上限(配置 brakeRounds,默认 3;0 = 关掉这一半),任务书没有查得到的点头行 → 软拦,每家一次(旗标 brake-rounds:<基号>);
//   (b) 任务书带〔待用户〕,没有查得到的点头行 → 软拦一次(旗标 brake-pending-user)。
//   点头行 = `用户点头:「原话」(日期 时刻,哪个塔)`,原话要在 origin/main 的 BACKLOG / journal 里查得到。
// 只读 `git show / git log origin/main`,不 fetch(钩子里不碰网络);(a)(b) 各自 try,任何一步出错放行(fail-open)。
// ⚠ 已知的洞:点头行只证明「台账里有这句话」,证明不了是用户说的 —— 塔自己往台账写一句再引用,闸就过了。
//   〔待用户〕也一样:product 不标,闸就看不见。
if (/create_session$/.test(tool)) {
  try {
    const bk = await import("./lib/brake.mjs");
    const cfg = config();
    const prompt = String(input.tool_input?.prompt ?? "");
    const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    const show = (f) => { try { return git("show", `origin/main:${f}`); } catch { return ""; } };
    let ledger = null;
    const ledgerText = () => {
      if (ledger === null) {
        git("rev-parse", "--verify", "-q", "origin/main");          // 没有 origin/main → 抛,调用方放行
        ledger = ["docs/BACKLOG.md", "docs/journal.md"].map(show).join("\n");
      }
      return ledger;
    };
    const nods = bk.nodQuotes(prompt);
    const nodOk = () => nods.some((q) => bk.quoteInLedger(q, ledgerText()));
    const nodNote = () => nods.length
      ? `\n  ★ 任务书里有「用户点头:」,但**台账里没找到这句**(${nods.map((q) => `「${q}」`).join(" ")})—— 先让原话落进 origin/main 的 BACKLOG / journal。\n`
      : "";
    const nodHow = `      用户点头:「原话」(日期 时刻,哪个塔)\n`;

    // (a) 同一家封顶
    const cap = cfg.brakeRounds;
    if (cap > 0) try {
      const title = prompt.split("\n").find((l) => /^# /.test(l)) ?? String(input.tool_input?.title ?? "");
      let board = null;
      try { board = whoAmI().board; } catch {}
      const q = bk.firstQ(title, bk.rangeDigit(board, cfg.ranges));
      if (q) {
        const { family, merged, round } = bk.familyRounds(q.no, bk.reworkBases(prompt), bk.deliveries(git(...bk.LOG_ARGS, "origin/main")));
        const key = `brake-rounds:${q.base}`;
        if (round > cap && !has(key) && !nodOk()) {
          remember(key);
          deny(`闸门17 派工刹车:${q.no} 是 ${family.join(" + ")} 这一家的**第 ${round} 轮**(上限 ${cap},再派要用户点头)。已合进 main 的:\n` +
               merged.map((d) => `  · ${d.q} · #${d.pr} · ${bk.fmtTime(d.at, cfg.timezone)}`).join("\n") + "\n" + nodNote() +
               `\n  规矩:同一件东西改到第 ${cap} 轮就停下等用户看(dispatch.md「刹车」)—— 环里得有「停」。\n` +
               `  先写给用户:还剩什么、这几轮花了多少(各工人会话 get_session 的 external_metadata.usage.cost_usd 加起来)、选项、推荐。\n\n` +
               `  放行:用户点了头、原话落进台账之后,任务书加一行\n` + nodHow +
               `  一次点头管一轮。**不是返工、只是号撞了家**,就原样再来一次(每家拦一次)。\n` +
               `  现数:node scripts/brake.mjs rounds ${q.no}`);
        }
      }
    } catch {}

    // (b) 〔待用户〕:不用读台账就判得了(没点头行时);有点头行、台账读不到 → 放行(fail-open)
    try {
      if (bk.hasMark(prompt, bk.MARK_USER) && !has("brake-pending-user")) {
        let nodPass = false;
        try { nodPass = nodOk(); } catch { nodPass = nods.length > 0; }
        if (!nodPass) {
          remember("brake-pending-user");
          deny(`闸门17 派工刹车:任务书里有〔待用户〕—— product 标了「推断会改行为,等用户点头」的东西,dev 不开工(dispatch.md「刹车」)。\n` + nodNote() +
               `  放行:用户点了头、原话落进台账之后,任务书加一行\n` + nodHow +
               `  任务书只是**提到**这个记号(不是在派那件活),原样再来一次(只拦这一次)。`);
        }
      }
    } catch {}
  } catch {}
}

// ── 闸门11 v2:代码 PR 不许自己开自己合(2026-09-10 用户定)──────────────
// 出处:有一晚 main 上十几个 PR **每一个都是开它的那个会话自己合的**,其中包括
//   第一批代码 —— 零独立评审。
// 规矩 = 代码类 PR 换一个塔核 diff 再合。这一段把它变成机器判据:
//   本会话开过 #n 且那笔动了代码目录(配置 codeDirs)→ **硬拦,不放行**,只能换个塔合。
//   文档 / harness 类 PR 不受这条管(自己开自己合可以),否则 harness 改动会直接卡死。
// ⚠ 仍然补不了「独立的第二个人」—— 所有塔同一个 GitHub 身份。它挡住的是
//   **同一个会话既当作者又当合并人**,那是最常见的形态。
if (/merge_pull_request$/.test(tool)) {
  const n = String(input.tool_input?.pullNumber ?? input.tool_input?.pull_number ?? "");
  if (n && has(`openedcodepr:${n}`))
    deny(`闸门11:PR #${n} 是**你自己这个会话开的**,而且它动了代码目录里的真代码。\n` +
         `  规矩:**代码 PR 不许自己开自己合** —— 换一个塔核完 diff 再合。\n\n` +
         `  怎么换:把 PR 号发给另一个塔(create_trigger 带 persistent_session_id → fire_trigger,\n` +
         `  配方见 tower.md 的平台事实),让它自己 pull_request_read 看 diff 和 CI,由它来合。\n` +
         `  **这一条没有「再来一次就放行」** —— 你自己合不了这个 PR。`);

  // 每个 PR 各拦一次:合之前得真去读过它的实际状态,不许只读 PR 描述。
  if (n && !has(`readpr:${n}`) && !has(`mergeasked:${n}`)) {
    remember(`mergeasked:${n}`);
    deny(`闸门11:要合 PR #${n},但本会话**没有读过它的实际状态**。\n` +
         `  先 mcp__github__pull_request_read 看三样,再回来合:\n` +
         `  ① **diff 本身** —— 不是 PR 描述,描述是写 PR 的人写的;\n` +
         `  ② 动了代码就看 **CI 的实际结论**,不是正文里贴的那段输出;\n` +
         `  ③ 验收判据逐条对,尤其「没做到的那条」有没有被含糊过去。\n\n` +
         `  读过之后再来一次就放行(每个 PR 各拦一次)。`);
  }
}

process.exit(0);
