#!/usr/bin/env node
// ledger-push 的沙箱回归。被 scripts/test-hooks.mjs 调用,也能单独跑:
//     node scripts/test-ledger-push.mjs
//
// 为什么要沙箱:脚本有一条**只有 main 上了分支保护才会走**的路(PR 模式)。那条路在真仓库上没法测 —— 保护要用户去点,
// 点之前又必须先证明脚本不会断。所以用本地裸仓库 + pre-receive 钩子模拟保护。
//
// ★ 四个场景里 C(抢跑)是**判据写反时唯一会红的**那个:
//   push 被拒有两种,一种重试能解决(别的塔抢先推了),一种重试一万次也没用
//   (被规则挡了)。脚本靠「origin/main 的 sha 动没动」分辨,不读 GitHub 的错误文字。
//   如果哪天有人把判据改成解析措辞、或者把两种失败混为一谈,C 会红。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync,
         readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/ledger-push.mjs");
const LEDGER = ["journal", "BACKLOG", "session-pool", "gate-log"];
const BOXES = [];

const g = (dir, ...a) =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .replace(/\s+$/, "");
const gd = (gitdir, ...a) => g(".", `--git-dir=${gitdir}`, ...a);

// protect: "none" 不拦 | "always" 永远拦 main(main 不动)| "race" 头一次拦并把 main 顶前进
function sandbox(protect) {
  const box = mkdtempSync(join(tmpdir(), "tower-ledger-"));
  BOXES.push(box);
  const origin = join(box, "origin.git"), work = join(box, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(work, "config", "user.email", "t@t"); g(work, "config", "user.name", "t");
  mkdirSync(join(work, "docs"), { recursive: true });
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, ".claude/.session-state"), { recursive: true });
  for (const f of LEDGER) writeFileSync(join(work, `docs/${f}.md`), `# ${f} 初版\n`);
  writeFileSync(join(work, "scripts/ledger-push.mjs"), readFileSync(SCRIPT));
  g(work, "add", "-A"); g(work, "commit", "-qm", "初版");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "-u", "origin", "main");

  // 「别的塔」的一笔台账,改的是另一个文件 —— 抢跑时它不能被冲掉
  g(work, "checkout", "-qb", "other");
  writeFileSync(join(work, "docs/BACKLOG.md"), "# BACKLOG 初版\n别的塔写的行\n");
  g(work, "commit", "-qam", "别的塔的台账"); g(work, "push", "-q", "origin", "other");
  g(work, "checkout", "-q", "main"); g(work, "branch", "-qD", "other");
  g(work, "checkout", "-qb", "claude/fake-tower");

  if (protect !== "none") {
    // quarantine 禁止 hook 里 update-ref,所以直接写松散 ref 绕过(松散优先于 packed）
    const bump = protect === "race"
      ? `      git --git-dir="${origin}" rev-parse other > "${origin}/refs/heads/main"\n` : "";
    writeFileSync(join(origin, "hooks/pre-receive"),
      `#!/bin/sh\nSTATE="${origin}/declined-once"\n` +
      `while read old new ref; do\n` +
      `  if [ "$ref" = "refs/heads/main" ]; then\n` +
      `    if [ "${protect}" = "always" ] || [ ! -f "$STATE" ]; then\n` +
      `      touch "$STATE"\n` + bump +
      `      echo "remote: error: GH006: Protected branch update failed." >&2\n` +
      `      exit 1\n    fi\n  fi\ndone\nexit 0\n`);
    chmodSync(join(origin, "hooks/pre-receive"), 0o755);
  }
  return { box, origin, work };
}

const run = (work, msg) => {
  const r = execFileSync(process.execPath, [join(work, "scripts/ledger-push.mjs"), msg],
    { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] , env: process.env});
  return r;
};
const runAllowFail = (work, msg) => {
  try { return { out: run(work, msg), code: 0 }; }
  catch (e) { return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: e.status ?? 1 }; }
};
const ledgerBranches = (origin) =>
  gd(origin, "branch", "--format=%(refname:short)").split("\n").filter((b) => b.startsWith("ledger/"));

let pass = 0, fail = 0; const lines = [];
// ★ 一组跑崩了只红这一组 —— 结果是在末尾一次性打印的,不兜住异常的话
//   进程一崩全部结果一起没,变异验证会把「该红」读成「没红」(MUT-L2 实测栽过)。
function group(name, fn) {
  try { fn(); }
  catch (e) { fail++; lines.push(`  FAIL  ${name} 这一组跑崩了 — ${String(e.message).split("\n")[0]}`); }
}
const check = (name, cond, detail = "") => {
  if (cond) { pass++; lines.push(`  PASS  ${name}`); }
  else { fail++; lines.push(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};

// ── A(绿):main 没保护 → 行为一个字不变,照旧直推 ────────────────────
group("A 直推", () => {
  const { origin, work } = sandbox("none");
  writeFileSync(join(work, "docs/journal.md"), "# journal 初版\n本塔的行\n");
  const { out, code } = runAllowFail(work, "A 直推");
  check("A 保护没开:退出码 0", code === 0, `code=${code}`);
  check("A 保护没开:台账真进了 main",
    gd(origin, "show", "main:docs/journal.md").includes("本塔的行"));
  check("A 保护没开:不产生 ledger/* 分支(变异:判据恒真会红)",
    ledgerBranches(origin).length === 0, ledgerBranches(origin).join(","));
  check("A 保护没开:不留 pending 记号",
    !existsSync(join(work, ".claude/.session-state/ledger-pending.json")));
  check("A 保护没开:输出里没有「还没进 main」", !out.includes("还没进 main"));
});

// ── B(红→PR):main 有保护 → 转 PR 模式,推分支不推 main ──────────────
group("B 转 PR", () => {
  const { origin, work } = sandbox("always");
  // ★ 塔分支上**已提交**的代码改动 —— 现实里就是这样(meta 分支带 harness,
  //   dev 分支带代码)。台账分支绝不能把它们捎进 main。没有这一笔,
  //   下面那条「不夹带」是假绿:无代码可夹带,判据写错也照样绿。
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src/wip.py"), "# 半成品,绝不能跟着台账上 main\n");
  // 顺带一份项目配置:开 PR 的命令里 owner/repo 要从它读
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude/belltower.json"), JSON.stringify({ repo: "acme/widgets" }));
  g(work, "add", "src/wip.py", ".claude/belltower.json"); g(work, "commit", "-qm", "本塔分支上的半成品代码");
  writeFileSync(join(work, "docs/journal.md"), "# journal 初版\n本塔的行\n");
  const { out, code } = runAllowFail(work, "B 转 PR");
  check("B 有保护:不算失败(退出码 0)", code === 0, `code=${code}`);
  check("B 有保护:明说了台账还没进 main", out.includes("还没进 main"));
  check("B 有保护:开 PR 的命令里 owner/repo 是从配置读的",
    out.includes("owner=acme repo=widgets"), (out.match(/owner=\S+ repo=\S+/) ?? ["(没有)"])[0]);
  const lb = ledgerBranches(origin);
  check("B 有保护:推出了一个 ledger/* 分支", lb.length === 1, lb.join(","));
  if (lb.length === 1) {
    // ★ 这条钉的是「别夹带」:ledger 分支只许比 main 多台账四件的改动
    const files = gd(origin, "diff", "--name-only", "main", lb[0]).split("\n").filter(Boolean);
    check("B 有保护:ledger 分支只动台账,一个别的文件都没夹带",
      files.length > 0 && files.every((f) => LEDGER.some((n) => f === `docs/${n}.md`)),
      files.join(","));
    check("B 有保护:分支上那笔半成品代码**没**跟着上去",
      !files.includes("src/wip.py") &&
      (() => { try { gd(origin, "show", `${lb[0]}:src/wip.py`); return false; } catch { return true; } })(),
      files.join(","));
    check("B 有保护:台账内容真在那个分支上",
      gd(origin, "show", `${lb[0]}:docs/journal.md`).includes("本塔的行"));
  }
  check("B 有保护:main 上没有(它被挡住了)",
    !gd(origin, "show", "main:docs/journal.md").includes("本塔的行"));
  const pend = join(work, ".claude/.session-state/ledger-pending.json");
  check("B 有保护:留下 pending 记号给收尾闸门", existsSync(pend));
  if (existsSync(pend)) {
    const p = JSON.parse(readFileSync(pend, "utf8"));
    check("B 有保护:记号里写着那个分支名", p.branch === lb[0], `${p.branch} vs ${lb[0]}`);
  }
  check("B 有保护:塔自己的分支也推上去了",
    gd(origin, "branch", "--format=%(refname:short)").split("\n").includes("claude/fake-tower"));
});

// ── C(抢跑):push 被拒但 main 动了 → 必须重试,**不许**当成保护 ────────
//    判据写反(改成读错误文字 / 两种失败混为一谈)时,这一组会红。
group("C 抢跑", () => {
  const { origin, work } = sandbox("race");
  writeFileSync(join(work, "docs/journal.md"), "# journal 初版\n本塔的行\n");
  const { out, code } = runAllowFail(work, "C 抢跑");
  check("C 抢跑:退出码 0", code === 0, `code=${code}`);
  check("C 抢跑:认出是别的塔抢先推了", out.includes("别的塔抢先推了"));
  check("C 抢跑:**没有**误判成保护", !out.includes("规则挡的"), out.slice(0, 200));
  check("C 抢跑:重试后台账真进了 main",
    gd(origin, "show", "main:docs/journal.md").includes("本塔的行"));
  check("C 抢跑:别的塔那一行没被冲掉",
    gd(origin, "show", "main:docs/BACKLOG.md").includes("别的塔写的行"));
  check("C 抢跑:不产生 ledger/* 分支", ledgerBranches(origin).length === 0);
  check("C 抢跑:不留 pending 记号",
    !existsSync(join(work, ".claude/.session-state/ledger-pending.json")));
});

// ── D:工作区有台账以外的改动 → 照旧拒绝跑(代码不许借这个口子上 main）──
group("D 夹带", () => {
  const { origin, work } = sandbox("none");
  writeFileSync(join(work, "docs/journal.md"), "# journal 初版\n本塔的行\n");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src/main.py"), "print('代码')\n");
  const { out, code } = runAllowFail(work, "D 夹带代码");
  check("D 夹带代码:拒绝跑(退出码非 0)", code !== 0, `code=${code}`);
  // git status --porcelain 把**未跟踪目录**折叠成目录名,不展开到文件 ——
  // 所以这里点名的是 `src/` 而不是 `src/main.py`。拦是拦住了,别当成洞。
  check("D 夹带代码:点名了那个越界路径", out.includes("src/"), out.slice(0, 200));
  check("D 夹带代码:台账没被推上去",
    !gd(origin, "show", "main:docs/journal.md").includes("本塔的行"));
});

// ── E:闸门12 端到端 —— 真脚本进 PR 模式,真收尾闸看得见、合掉之后自清理 ────
//    这组是唯一在**有 git 的环境**里跑 guard-stop 的测试;test-hooks.mjs 的沙箱
//    没有仓库,闸门12 在那儿只会 fail-open,钉不住任何东西。
group("E 闸门12", () => {
  const { origin, work } = sandbox("always");
  writeFileSync(join(work, "docs/journal.md"), "# journal 初版\n本塔的行\n");
  runAllowFail(work, "E 闸门12");
  const pend = join(work, ".claude/.session-state/ledger-pending.json");
  check("E 前置:PR 模式留下了 pending 记号", existsSync(pend));

  const tp = join(work, "transcript.jsonl");
  writeFileSync(tp, JSON.stringify({ type: "assistant", message: { content: [{ text: "收尾" }] } }) + "\n");
  const stop = () => {
    const r = spawnSync(process.execPath, [resolve(".claude/hooks/guard-stop.mjs")], {
      cwd: work, input: JSON.stringify({ session_id: "e2e", transcript_path: tp }),
      encoding: "utf8", env: { ...process.env, CLAUDE_HOOK_TEST: "1" } });
    let j = null; try { j = JSON.parse(r.stdout ?? ""); } catch {}
    return { code: r.status, out: r.stdout ?? "", decision: j?.decision ?? null, reason: j?.reason ?? "" };
  };

  const first = stop();
  check("E 没合:闸门12 拦下了", first.decision === "block", first.out.slice(0, 160));
  check("E 没合:拦的时候点名了那个分支",
    first.reason.includes("ledger/"), first.reason.slice(0, 120));
  check("E 没合:记号还在(没被误删)", existsSync(pend));

  // 模拟「PR 合了」:在裸仓库里把 ledger 分支合进 main
  const lb = ledgerBranches(origin)[0];
  check("E 前置:确实有 ledger/* 分支可合", !!lb);
  if (!lb) return;                       // 没有就别往下走,否则崩在 update-ref 上
  gd(origin, "update-ref", "refs/heads/main", `refs/heads/${lb}`);
  const second = stop();
  check("E 合了:闸门12 放行", second.code === 0 && second.out.trim() === "", second.out.slice(0, 160));
  // ★ 钉住「拦一次之后仍然自清理」:flags 里已经有 ledgerpr-reminded 了,
  //   要是把查和拦写在同一个 if 里,这条会红(记号永远留着,下个会话继续被绊)。
  check("E 合了:记号被自己清掉了(拦过一次也照样清)", !existsSync(pend));
});

// ── F:闸门11 认 PR 类型的判据 —— 必须在**真仓库**里测 ──────────────────
//    test-hooks.mjs 的沙箱不是 git 仓库,`git diff origin/main...HEAD` 直接失败、
//    一律算「没动代码」—— 在那儿测这条永远是绿的,什么也钉不住(第一版就是这样)。
group("F 闸门11 判 PR 类型", () => {
  const openPr = (work, sid, head, n) => {
    spawnSync(process.execPath, [resolve(".claude/hooks/guard-mcp.mjs")], {
      cwd: work, encoding: "utf8", env: { ...process.env, CLAUDE_HOOK_TEST: "1" },
      input: JSON.stringify({ session_id: sid, tool_name: "mcp__github__create_pull_request",
        tool_input: { head, base: "main" },
        tool_response: { url: `https://github.com/o/r/pull/${n}` } }) });
    try { return readFileSync(join(work, ".claude/.session-state", `${sid}.flags`), "utf8"); }
    catch { return ""; }
  };
  {
    const { work } = sandbox("none");
    // 塔分支上有真代码改动(默认代码目录 src)—— dev 塔的日常形态
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src/wip.py"), "# 真代码\n");
    g(work, "add", "src/wip.py"); g(work, "commit", "-qm", "本塔分支上的代码");
    // F1 先证明工作树判据是**活的** —— 没有这条,F2 是空的
    check("F1 普通 PR:分支上动了 src/ → 记成代码 PR(硬闸管得着)",
      /^openedcodepr:94$/m.test(openPr(work, "f1", "claude/fake-tower", 94)));
    // F2 要保护的行为:台账 PR 的 head 是脚本造的 ledger/*,工作树上那笔代码跟它无关
    check("F2 台账 PR:head=ledger/* → 记成文档 PR,塔自己合得了",
      /^openeddocpr:95$/m.test(openPr(work, "f2", "ledger/fake-tower-260911T0330", 95)));
    // F3 代码目录从配置读:配成 api/ 之后,src/ 的改动就不算代码
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(join(work, ".claude/belltower.json"), JSON.stringify({ codeDirs: ["api"] }));
    check("F3 配置 codeDirs=[api]:src/ 的改动 → 记成文档 PR(证明读的是配置)",
      /^openeddocpr:96$/m.test(openPr(work, "f3", "claude/fake-tower", 96)));
  }
  {
    const { work } = sandbox("none");
    mkdirSync(join(work, "api"), { recursive: true });
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(join(work, ".claude/belltower.json"), JSON.stringify({ codeDirs: ["api"] }));
    writeFileSync(join(work, "api/wip.py"), "# 真代码\n");
    g(work, "add", "api/wip.py"); g(work, "commit", "-qm", "本塔分支上的代码");
    check("F4 配置 codeDirs=[api]:api/ 的改动 → 记成代码 PR",
      /^openedcodepr:97$/m.test(openPr(work, "f4", "claude/fake-tower", 97)));
  }
});

for (const b of BOXES) { try { rmSync(b, { recursive: true, force: true }); } catch {} }

console.log(lines.join("\n"));
console.log(`\nledger-push: ${pass} passed, ${fail} failed`);
export default { pass, fail };
if (import.meta.url === `file://${process.argv[1]}`) process.exit(fail ? 1 : 0);
