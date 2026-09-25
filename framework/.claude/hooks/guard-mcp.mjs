#!/usr/bin/env node
// PreToolUse,只管两个 MCP 工具 —— 它们是现有闸门够不着的两个口子。
// stdin 解析失败一律放行(fail-open)。两道都是**软闸,各拦一次**:
// 拦的是「你确认过了吗」,不是「不许干」。
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./lib/config.mjs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }

const tool = String(input.tool_name ?? "");
const sid = String(input.session_id ?? "unknown");
const stateFile = join(".claude/.session-state", `${sid}.flags`);
let flags = "";
try { flags = readFileSync(stateFile, "utf8"); } catch {}
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

// ── 闸门10:派工人也要过铁律6 ────────────────────────────────────────────
// 出处(2026-09-10):闸门4 只看 `docs/BACKLOG.md` 的队列行 ——
//   塔**直接 create_session 不写队列行就整条绕过去**。
//   规矩本身是铁律6:立号前必须有用户那句「做这个」;别的塔的活不许替它立号。
// ★ 这道闸补的是「动作」那一侧,闸门4 补的是「台账」那一侧,两边都要有。
if (/create_session$/.test(tool) && !flags.includes("dispatch-reminded")) {
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
  if (n && flags.includes(`openedcodepr:${n}`))
    deny(`闸门11:PR #${n} 是**你自己这个会话开的**,而且它动了代码目录里的真代码。\n` +
         `  规矩:**代码 PR 不许自己开自己合** —— 换一个塔核完 diff 再合。\n\n` +
         `  怎么换:把 PR 号发给另一个塔(create_trigger 带 persistent_session_id → fire_trigger,\n` +
         `  配方见 tower.md 的平台事实),让它自己 pull_request_read 看 diff 和 CI,由它来合。\n` +
         `  **这一条没有「再来一次就放行」** —— 你自己合不了这个 PR。`);

  // 每个 PR 各拦一次:合之前得真去读过它的实际状态,不许只读 PR 描述。
  if (n && !flags.includes(`readpr:${n}`) && !flags.includes(`mergeasked:${n}`)) {
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
