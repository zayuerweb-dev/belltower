#!/usr/bin/env node
// 闸门回归测试。加/改任何闸门都必须在这里补「一红一绿」:
// 红 = 该拦的确实被拦(exit 2),绿 = 不该拦的确实放行(exit 0)。
// 跑法:在项目根(装了这套框架的目录)node scripts/test-hooks.mjs
// ★ 除了「仓库真配置」那一条,所有用例都在临时目录里跑,不读项目自己的台账和配置 ——
//   这套测试随框架分发,在任何项目里都得一样绿。项目配置(.claude/belltower.json)的
//   读取在沙箱里写一份假的来测。
//
// ★ 假 key 在运行时拼,不写字面量 —— 否则会被自己的 key 闸拦住(见 docs/gate-log.md)。
//
// ★ 2026-09-11 变异验证后补的断言标了「变异:Mxx」—— 那条断言是被哪次变异
//   逼出来的。判据是「一行被测代码都不改,只把这条断言对应的东西改坏,它会不会红」。
//   做法见 docs/testing.md「变异验证」。
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync,
         statSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE_KEY = ["sk", "ant", "abcdefghijklmnop"].join("-");

let pass = 0, fail = 0;
const results = [];

function runHook(script, payload, env = {}) {
  const r = spawnSync(process.execPath, [`.claude/hooks/${script}`], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_HOOK_TEST: "1", ...env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const bash = (command) => runHook("guard-bash.mjs", {
  session_id: "test", cwd: process.cwd(), tool_name: "Bash", tool_input: { command } });
const edit = (file_path, content = "") => runHook("guard-edit.mjs", {
  session_id: "test", cwd: process.cwd(), tool_name: "Write", tool_input: { file_path, content } });

function assert(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}
const denied = (r) => r.code === 2;
const allowed = (r) => r.code === 0;

// ── 沙箱:闸门读 cwd 下的 .claude/.session-state 和 docs/journal.md ──────
// journal.md 是台账,测试不许碰真的那一份;旗标也得是干净的。所以凡是要摆布
// 这两样的用例,整个在临时目录里跑 —— hook 用绝对路径调,它 import 的
// ./lib/now.mjs 按脚本自己的位置解析,不受 cwd 影响。
const HOOKS = resolve(".claude/hooks");
const SANDBOXES = [];
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), "tower-hook-"));
  mkdirSync(join(d, ".claude/.session-state"), { recursive: true });
  mkdirSync(join(d, "docs"), { recursive: true });
  SANDBOXES.push(d);
  return d;
}
function runIn(dir, script, payload, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    cwd: dir, input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, CLAUDE_HOOK_TEST: "1", ...env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
// 往沙箱里写一份项目配置(.claude/belltower.json)
const withCfg = (dir, cfg) => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/belltower.json"), JSON.stringify(cfg));
  return dir;
};
// 沙箱里建一个真 git 仓库(带 origin),给要跑 git 的闸门用
const gitq = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function gitSandbox() {
  const d = sandbox();
  const origin = join(d, ".origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  gitq(d, "init", "-q", "-b", "main");
  gitq(d, "config", "user.email", "t@example.com"); gitq(d, "config", "user.name", "t");
  gitq(d, "remote", "add", "origin", origin);
  return d;
}
const commitAll = (d, msg) => { gitq(d, "add", "-A"); gitq(d, "commit", "-qm", msg); };
const flagsIn = (dir, sid) => {
  try { return readFileSync(join(dir, ".claude/.session-state", `${sid}.flags`), "utf8"); }
  catch { return ""; }
};

// ★ 先钉时钟:hook 在测试模式下认 BELLTOWER_NOW(lib/now.mjs)。期望值和 hook 用同一个时刻,
//   整套测试跑过午夜也不会跨天误红。钉的是「现在」,不是写死的日期 —— 写死的日期第二天就过期。
process.env.BELLTOWER_NOW ||= new Date().toISOString();
const PINNED = new Date(process.env.BELLTOWER_NOW);
// ★ 今天的日期在这儿**自己算一遍**,不 import lib/now.mjs ——
//   否则 ymd() 被改坏时测试的期望值跟着一起坏,断言永远绿(变异:M37)。
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(PINNED);
// 「真时刻」的形状:年/月/日 … 时:分 (America/New_York)。占位串顶不上(变异:M36)。
const STAMP_SHAPE = /\d{4}\/\d{2}\/\d{2}\D*\d{2}:\d{2} \(America\/New_York\)/;

// Stop 闸门是「输出 JSON 说 block」,不是 exit 2 —— 判据跟 PreToolUse 不一样。
function stopHook({ flags = "", lastText = "", journal = null, journalDelta = 0,
                    stopHookActive = false, sid = "stoptest", ctxTokens = 0, bloat = 0,
                    settings = null, compactions = 0, cfg = null, pool = null, env = {} }) {
  const dir = sandbox();
  if (cfg) withCfg(dir, cfg);
  if (pool !== null) writeFileSync(join(dir, "docs/session-pool.md"), pool);
  const tp = join(dir, "transcript.jsonl");
  writeFileSync(tp, JSON.stringify(
    { type: "assistant", message: { content: [{ text: lastText }] } }) + "\n");
  // settings:写进沙盒的 .claude/settings.json(闸门9 从这里现读压缩窗口)。
  // compactions:转录里追加几条压缩边界(平台真实格式:type=system, subtype=compact_boundary)。
  if (settings) writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(settings));
  for (let i = 0; i < compactions; i++) appendFileSync(tp, JSON.stringify(
    { type: "system", subtype: "compact_boundary", content: "Conversation compacted" }) + "\n");
  // bloat:把转录**文件**撑大(只是注释行)。闸门9 读的是 usage 不是文件大小,
  //        所以这个参数是用来**证明它不再看文件大小**的 —— 第一版就栽在这。
  // ctxTokens:追加一条带 usage 的 assistant —— 闸门9 真正读的那条。
  if (bloat) appendFileSync(tp, "#".repeat(1024 * 1024).concat("\n").repeat(bloat));
  if (ctxTokens) appendFileSync(tp, JSON.stringify({ type: "assistant", message: {
    content: [{ text: lastText }], usage: { input_tokens: 2,
      cache_read_input_tokens: ctxTokens - 2, cache_creation_input_tokens: 0 } } }) + "\n");
  if (flags) writeFileSync(join(dir, ".claude/.session-state", `${sid}.flags`), flags);
  if (journal !== null) {
    const jp = join(dir, "docs/journal.md");
    writeFileSync(jp, journal);
    // journalDelta:journal 的 mtime 相对转录出生时刻的偏移(负 = 本会话之前就写好的)
    const t = (statSync(tp).birthtimeMs || Date.now()) + journalDelta;
    utimesSync(jp, t / 1000, t / 1000);
  }
  const r = runIn(dir, "guard-stop.mjs",
    { session_id: sid, transcript_path: tp, stop_hook_active: stopHookActive },
    { CLAUDE_CODE_REMOTE_SESSION_ID: "", ...env });   // 默认当本机会话:别让跑测试的云容器自己的会话 ID 漏进来
  let j = null; try { j = JSON.parse(r.out); } catch {}
  return { ...r, decision: j?.decision ?? null, reason: j?.reason ?? "" };
}
const blocked = (r) => r.decision === "block";
// 放行 = 无输出 + exit 0(guard-stop 自己的协议)。输出了别的东西也算没放行。
const stopOk = (r) => r.code === 0 && r.out.trim() === "";

// ── 敏感数据默认不进(铁律1)—— Bash 侧(默认模式,见 lib/config.mjs)────────
assert("红:拷敏感数据目录里的文件进仓库", denied(bash("cp ../other/private-data/users.csv ./data/")));
assert("红:拷凭据进仓库", denied(bash("copy ..\\other\\credentials.json .")));
assert("红:拷整个敏感目录进仓库", denied(bash("cp -r ../other/sensitive/ ./fixtures/")));
// robocopy / xcopy 的源目录不带尾斜杠 —— 只认斜杠会漏
assert("红:robocopy 不带尾斜杠的敏感目录", denied(bash("robocopy ..\\other\\sensitive .\\sensitive /E")));
assert("绿:拷自己的文档不拦", allowed(bash("cp docs/design/overview.md /tmp/x.md")));
assert("绿:heredoc 正文里描述这件事不算要做",
  allowed(bash("cat <<'EOF' > note.md\n别把 credentials.json 拷进来\nEOF")));
// ★ 上面那条正文里没有拷贝动词,闸1 本来就不会触发 —— 它绿不证明剥离在干活。
//   这条的正文是一条**真能触发闸1 的命令**,只有剥离真在干活才会绿(变异:M11)。
assert("绿:heredoc 正文里的真拷贝命令也不算要执行",
  allowed(bash("cat <<'EOF' > note.md\ncp ../other/private-data/users.csv ./data/\nEOF")));
assert("绿:claude -p 的 prompt 里的拷贝命令不算要执行",
  allowed(bash('claude -p "cp ../other/private-data/users.csv ./data/"')));

// ── 敏感数据模式从项目配置读 ─────────────────────────────────────────────
{
  const d = withCfg(sandbox(), { sensitivePaths: { bash: "vendor-dump", edit: "(^|/)vendor-dump/" } });
  const b = (command) => runIn(d, "guard-bash.mjs", { session_id: "c1", tool_name: "Bash", tool_input: { command } });
  const e = (file_path) => runIn(d, "guard-edit.mjs", { session_id: "c1", tool_name: "Write", tool_input: { file_path, content: "x" } });
  assert("红:配置里的 bash 模式生效(拷 vendor-dump 被拦)", denied(b("cp -r ../x/vendor-dump ./")));
  assert("绿:配置换了模式,默认模式就不再管(证明读的是配置)", allowed(b("cp ../x/credentials.json .")));
  assert("红:配置里的 edit 模式生效", denied(e("vendor-dump/a.csv")));
  assert("绿:配置换了 edit 模式,默认模式不再管", allowed(e("config/credentials.json")));
}
{
  const d = withCfg(sandbox(), { sensitivePaths: { bash: "", edit: "" } });
  assert("绿:模式设成空串 = 这道闸关掉",
    allowed(runIn(d, "guard-bash.mjs", { session_id: "c2", tool_name: "Bash",
      tool_input: { command: "cp ../x/credentials.json ." } })));
}
{
  const d = withCfg(sandbox(), { sensitivePaths: { bash: "([unclosed", edit: "([unclosed" } });
  assert("绿:模式写坏了不崩(fail-open)",
    allowed(runIn(d, "guard-bash.mjs", { session_id: "c3", tool_name: "Bash",
      tool_input: { command: "cp ../x/credentials.json ." } })));
}

// ── git add ────────────────────────────────────────────────────────────
assert("红:git add -f", denied(bash("git add -f fixtures/credentials.json")));
// ★ 上面那条路径里带敏感文件名,闸2b 也会拦 —— 把闸2a 整个掏空它照样绿。
//   这条用良性路径,只有闸2a(-f 本身)还在才会红(变异:M04)。
assert("红:git add -f 良性路径也拦(-f 本身就是绕过)",
  denied(bash("git add -f docs/design/overview.md")));
assert("红:git add 点名凭据", denied(bash("git add secrets.json")));
assert("绿:普通 git add", allowed(bash("git add docs/ CLAUDE.md")));
assert("绿:git add -A", allowed(bash("git add -A")));
assert("绿:add 之后另起命令提到敏感目录",
  allowed(bash("git add -A && ls ../other/sensitive | head -3")));

// ── 系统 Temp ──────────────────────────────────────────────────────────
assert("红:删系统 Temp", denied(bash("Remove-Item -Recurse $env:LOCALAPPDATA\\Temp\\foo")));
assert("绿:docker --rm 不误杀",
  allowed(bash("docker run --rm -v /c/Users/x/AppData/Local/Temp:/t img")));  // scan-public:ok(测试夹具)
assert("绿:--hard 里的 rd 不当删除动词", allowed(bash("git reset --hard")));
assert("绿:删项目内 build", allowed(bash("rm -rf ./build ./dist")));

// ── key 不落盘 ─────────────────────────────────────────────────────────
assert("红:命令里带 key", denied(bash(`export ANTHROPIC_API_KEY=${FAKE_KEY}`)));
assert("红:heredoc 正文里的 key 也拦",
  denied(bash(`cat <<'EOF' > k.json\n{"k":"${FAKE_KEY}"}\nEOF`)));
assert("绿:只提到 key 这个词", allowed(bash("echo 'read the api key from env'")));

// ── Edit 侧 ────────────────────────────────────────────────────────────
assert("红:写入内容含 key", denied(edit("notes.md", `key = ${FAKE_KEY}`)));
assert("红:在仓库里创建凭据文件", denied(edit("config/credentials.json", "{}")));
assert("红:在仓库里创建证书私钥", denied(edit("certs/server.pem", "x")));
assert("红:在仓库里创建敏感目录文件", denied(edit("private-data/FOO/rows.csv", "x")));
assert("绿:普通文档放行", allowed(edit("docs/notes.md", "2026-09-09 · meta · 测试")));
assert("绿:源码放行", allowed(edit("src/api/main.py", "print(1)")));
// 仓库外的路径不参与判定 —— 别的项目的目录不归本仓库管(铁律2),这道闸管的是
// 「别写进**本仓库**」,不是越界管人家的目录(变异:M21)。
assert("绿:仓库外路径不参与判定",
  allowed(edit("../other/credentials.json", "x")));

// ── 冻结清单 ───────────────────────────────────────────────────────────
{
  const d = sandbox();
  mkdirSync(join(d, ".claude"), { recursive: true });
  const ed = (fp) => runIn(d, "guard-edit.mjs", { session_id: "fz", tool_name: "Write",
    tool_input: { file_path: fp, content: "x" } });
  writeFileSync(join(d, ".claude/frozen.txt"), "# test\ndocs/design/overview.md\n");
  assert("红:冻结文件被拦", denied(ed("docs/design/overview.md")));
  assert("绿:没冻结的放行", allowed(ed("docs/notes.md")));
  // # 开头的是注释不是条目 —— 把某份「暂时解冻」的写法就是在前面加 #(变异:M38)。
  writeFileSync(join(d, ".claude/frozen.txt"), "# docs/notes.md\n");
  assert("绿:frozen.txt 里被 # 注释掉的不算冻结", allowed(ed("docs/notes.md")));
}

// ── 旗标:两道 PreToolUse 闸给 Stop 闸7 留的记号 ────────────────────────
// 这是闸7 的**唯一输入**。旗标不写,闸7 逻辑再对也永远不触发(变异:M13、M22)。
{
  const d = sandbox();
  runIn(d, "guard-edit.mjs", { session_id: "flagtest", tool_name: "Write",
    tool_input: { file_path: "docs/BACKLOG.md", content: "x" } });
  assert("guard-edit 把改动记成 edit: 旗标",
    /^edit:docs\/BACKLOG\.md$/m.test(flagsIn(d, "flagtest")),
    JSON.stringify(flagsIn(d, "flagtest")));
}
{
  const d = sandbox();
  runIn(d, "guard-bash.mjs", { session_id: "flagtest", tool_name: "Bash",
    tool_input: { command: "echo '2026-09-11 · meta · x' >> docs/journal.md" } });
  assert("guard-bash 给 journal 的重定向补同一旗标",
    /^edit:docs\/journal\.md$/m.test(flagsIn(d, "flagtest")),
    JSON.stringify(flagsIn(d, "flagtest")));
}

// ── Stop 闸门6:没证据不许说完成(铁律3、4)─────────────────────────────
const PY = "edit:src/x.py\n";
const TODAY_JOURNAL = `${TODAY} · meta · 今天写过\n`;
assert("红:改过 .py + 说完成 + 没有回归证据 → block",
  blocked(stopHook({ flags: PY, lastText: "修好了",
                     journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("绿:说完成但贴了回归证据 → 放行",
  stopOk(stopHook({ flags: PY, lastText: "修好了,回归全绿 34 PASS",
                    journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("绿:没说完成不拦",
  stopOk(stopHook({ flags: PY, lastText: "还在改,先不收尾",
                    journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("绿:闸6 只拦一次(第二次放行)",
  stopOk(stopHook({ flags: PY + "gatea-reminded\n", lastText: "修好了",
                    journal: TODAY_JOURNAL, journalDelta: 5000 })));
// 「源文件」的扩展名从配置 codeExt 读
assert("绿:配置 codeExt 不含 py → 改 .py 说完成不拦(证明读的是配置)",
  stopOk(stopHook({ flags: PY, lastText: "修好了", cfg: { codeExt: ["rb"] },
                    journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("红:配置 codeExt 含 rb → 改 .rb 说完成没证据 → block",
  blocked(stopHook({ flags: "edit:lib/x.rb\n", lastText: "修好了", cfg: { codeExt: ["rb"] },
                     journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("绿:改的是文档不是源文件 → 说完成不拦",
  stopOk(stopHook({ flags: "edit:docs/x.md\n", lastText: "修好了",
                    journal: TODAY_JOURNAL, journalDelta: 5000 })));
// ★ 只认仓库内的路径:guard-edit 对仓库外的文件记绝对路径(scratchpad、/tmp 里的一次性脚本),
//   那不算「改过代码」。四种写法各钉一条 —— 少排除哪一种,对应那条就红。
const OUTSIDE = ["/tmp/once.py", "C:/work/once.py", "D:\\work\\once.py", "../other/once.py"];
for (const p of OUTSIDE)
  assert(`绿:只改了仓库外的 ${p} + 说完成、没证据 → 不拦(一次性脚本不算改过代码)`,
    stopOk(stopHook({ flags: `edit:${p}\n`, lastText: "修好了",
                      journal: TODAY_JOURNAL, journalDelta: 5000 })));
// 配对的红:仓库外的改动不许把仓库内的盖掉(只看第一行、或「有仓库外的就整个放行」都会在这儿露馅)。
assert("红:改了仓库外的,也改了仓库内的 src/x.py + 说完成、没证据 → 照样拦",
  blocked(stopHook({ flags: OUTSIDE.map((p) => `edit:${p}\n`).join("") + PY, lastText: "修好了",
                     journal: TODAY_JOURNAL, journalDelta: 5000 })));

// ── Stop 闸门7:改了文件要写 journal ────────────────────────────────────
const EDITED = "edit:docs/foo.md\n";
const OLD_JOURNAL = "2020-01-01 · 旧条目\n";
assert("红:改过文件 + journal 末行不是今日 → block",
  blocked(stopHook({ flags: EDITED, journal: OLD_JOURNAL, journalDelta: 5000 })));
// ★ 末行是今日还不够:一天开好几个会话,第一条一落地就会对当天剩下的会话全天放行。
//   所以还要看 journal 的 mtime 晚于本会话转录的出生时刻(变异:M41)。
assert("红:末行是今日但本会话没动过它 → 照样 block",
  blocked(stopHook({ flags: EDITED, journal: TODAY_JOURNAL, journalDelta: -600000 })));
assert("绿:末行是今日且本会话动过 → 放行",
  stopOk(stopHook({ flags: EDITED, journal: TODAY_JOURNAL, journalDelta: 5000 })));
assert("绿:本会话直接写过 journal → 放行",
  stopOk(stopHook({ flags: "edit:docs/journal.md\n", journal: OLD_JOURNAL, journalDelta: 5000 })));
assert("绿:闸7 只拦一次(第二次放行)",
  stopOk(stopHook({ flags: EDITED + "journal-reminded\n",
                    journal: OLD_JOURNAL, journalDelta: 5000 })));
// 列表式 journal:末行「- 日期 · …」也算今日(第一版只认日期打头,用列表写的项目每次必误拦)
assert("绿:journal 末行是列表项「- 今日 · …」且本会话动过 → 放行",
  stopOk(stopHook({ flags: EDITED, journal: "- " + TODAY_JOURNAL.trim().split("\n").pop() + "\n", journalDelta: 5000 })));
assert("红:列表项但日期是旧的 → 照样 block",
  blocked(stopHook({ flags: EDITED, journal: "- " + OLD_JOURNAL, journalDelta: 5000 })));
// 工人不拦:任务书规定工人不写台账。认法 = 云会话 + 活表里没有它的塔行。
const POOL = "| 塔 | 板块 skill |\n|---|---|\n| dev | `tower-dev` | 云 | session_TOWERDEV0000000000001 | |\n";
assert("绿:工人(云会话,活表里没有它的塔行)改了文件不写 journal → 不拦",
  stopOk(stopHook({ flags: EDITED, journal: OLD_JOURNAL, journalDelta: 5000, pool: POOL,
                    env: { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_WORKER00000000000000001" } })));
assert("红:塔(会话 ID 对上活表塔行)改了文件不写 journal → 照样拦",
  blocked(stopHook({ flags: EDITED, journal: OLD_JOURNAL, journalDelta: 5000, pool: POOL,
                     env: { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_TOWERDEV0000000000001" } })));
assert("红:云会话但活表读不到(认不出是不是工人)→ 照样拦",
  blocked(stopHook({ flags: EDITED, journal: OLD_JOURNAL, journalDelta: 5000,
                     env: { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_WORKER00000000000000001" } })));
// ★ 「改过文件」也只认仓库内的:只动了仓库外的临时文件,不该被要 journal。
//   (这几条没说「完成」,闸6 不会插手 —— 红了就是闸7 自己的事。)
for (const p of OUTSIDE)
  assert(`绿:只改了仓库外的 ${p} → 闸7 不要 journal`,
    stopOk(stopHook({ flags: `edit:${p}\n`, journal: OLD_JOURNAL, journalDelta: 5000 })));
assert("红:改了仓库外的,也改了仓库内的文件 → 闸7 照样拦",
  blocked(stopHook({ flags: OUTSIDE.map((p) => `edit:${p}\n`).join("") + EDITED,
                     journal: OLD_JOURNAL, journalDelta: 5000 })));
assert("绿:stop_hook_active 时一律放行(防循环)",
  stopOk(stopHook({ flags: PY + EDITED, lastText: "修好了",
                    journal: OLD_JOURNAL, journalDelta: 5000, stopHookActive: true })));

// ── 闸门4:往执行队列加 Qn 行要先确认(禁止自主加 Q)────────────────────
// 软闸,靠 .claude/.session-state 里的旗标记「拦过一次了」,所以整个在沙箱里跑。
const QROW_OLD = "| 单号 | 板块 |\n|---|---|\n| Q701 | meta | 旧的 |\n";
const QROW_NEW = QROW_OLD + "| Q702 | meta | 新立的 |\n";
const editQ = (dir, sid, oldS, newS) => runIn(dir, "guard-edit.mjs", {
  session_id: sid, tool_name: "Edit",
  tool_input: { file_path: "docs/BACKLOG.md", old_string: oldS, new_string: newS },
});
{
  const d = sandbox();
  assert("红:往执行队列加一个新单号 → 先确认",
    denied(editQ(d, "q1", QROW_OLD, QROW_NEW)));
  // ★ 软闸只拦一次:用户点过头的立号是正常动作,不该被挡死(同一会话第二次放行)。
  assert("绿:闸4 只拦一次(第二次原样再来就放行)",
    allowed(editQ(d, "q1", QROW_OLD, QROW_NEW)));
}
// 删行是收活的正常动作,不能拦;改行内容也不是立号。
assert("绿:从队列删一行不拦", allowed(editQ(sandbox(), "q2", QROW_NEW, QROW_OLD)));
assert("绿:改队列行的内容不算立号",
  allowed(editQ(sandbox(), "q3", QROW_OLD, "| 单号 | 板块 |\n|---|---|\n| Q701 | meta | 改了描述 |\n")));
assert("绿:BACKLOG 里别处提到 Qnn 不算立号(要在行首才算队列行)",
  allowed(editQ(sandbox(), "q4", "正文\n", "正文\n见 Q701 那一单\n")));
// 只管 docs/BACKLOG.md —— 别的文件里写号是文档,不是立号。
assert("绿:别的文件里加 Qnn 行不拦",
  allowed(runIn(sandbox(), "guard-edit.mjs", { session_id: "q5", tool_name: "Edit",
    tool_input: { file_path: "docs/journal.md", old_string: "x\n", new_string: QROW_NEW } })));
// Write(整份覆盖)没有 old_string,得拿磁盘上那份当「之前」。
{
  const d = sandbox();
  writeFileSync(join(d, "docs/BACKLOG.md"), QROW_OLD);
  assert("红:Write 整份覆盖时也认得出多了一个号",
    denied(runIn(d, "guard-edit.mjs", { session_id: "q6", tool_name: "Write",
      tool_input: { file_path: "docs/BACKLOG.md", content: QROW_NEW } })));
}
{
  const d = sandbox();
  writeFileSync(join(d, "docs/BACKLOG.md"), QROW_NEW);
  assert("绿:Write 覆盖但号没多不拦",
    allowed(runIn(d, "guard-edit.mjs", { session_id: "q7", tool_name: "Write",
      tool_input: { file_path: "docs/BACKLOG.md", content: QROW_NEW } })));
}
// ★ 四位号:段的 x01–x99 用完接 x001–x999(dispatch.md §3),meta 段 Q799 之后是 Q7001。
//   QROW 只认到三位的话,`| Q7001 |` 根本不算队列行 —— 立号悄悄绕过这道闸;
//   认成截短的 Q700,Q7001 和 Q7002 就成了「同一个号」,第二个也绕过去。
{
  const d = sandbox();
  const Q4 = QROW_OLD + "| Q7001 | meta | 四位号 |\n";
  assert("红:往执行队列加四位号 | Q7001 | → 认成新号、拦", denied(editQ(d, "q8", QROW_OLD, Q4)));
  assert("绿:四位号也只拦一次(第二次原样再来就放行)", allowed(editQ(d, "q8", QROW_OLD, Q4)));
  assert("红:已有 Q7001 再加 Q7002 → 照样是新号(四位号不许截成三位当成同一个)",
    denied(editQ(sandbox(), "q9", Q4, Q4 + "| Q7002 | meta | 下一个 |\n")));
}

// ── 闸门5:授权词要带用户原话(塔不许给自己签字)────────────────────────
{
  const d = sandbox();
  const ed = (sid, oldS, newS) => runIn(d, "guard-edit.mjs", {
    session_id: sid, tool_name: "Edit",
    tool_input: { file_path: "docs/BACKLOG.md", old_string: oldS, new_string: newS },
  });
  assert("红:台账里写「开发解除阻塞」却没说谁批的",
    denied(ed("a1", "### T1 设计评审\n", "### T1 设计评审 —— 开发解除阻塞\n")));
  // ★ 软闸:用户真点过头是正常动作,拦一次就放行(同一会话第二次)。
  assert("绿:闸5 只拦一次(第二次原样再来就放行)",
    allowed(ed("a1", "### T1 设计评审\n", "### T1 设计评审 —— 开发解除阻塞\n")));
}
// 带上用户原话 + 时刻 = 有凭据,第一次就该放行(换一个干净会话,证明不是靠「只拦一次」)。
assert("绿:同一笔里写了用户原话和时刻就放行",
  allowed(runIn(sandbox(), "guard-edit.mjs", { session_id: "a2", tool_name: "Edit",
    tool_input: { file_path: "docs/BACKLOG.md", old_string: "### T1\n",
      new_string: "### T1 —— 开发解除阻塞\n用户 10:15 ET:「好,就这么定」\n" } })));
assert("绿:没新增授权词不拦(原文里本来就有)",
  allowed(runIn(sandbox(), "guard-edit.mjs", { session_id: "a3", tool_name: "Edit",
    tool_input: { file_path: "docs/BACKLOG.md", old_string: "已授权\n",
      new_string: "已授权\n加一行别的\n" } })));
assert("绿:授权词出现在非台账文件不拦",
  allowed(runIn(sandbox(), "guard-edit.mjs", { session_id: "a4", tool_name: "Edit",
    tool_input: { file_path: "docs/design/x.md", old_string: "x\n",
      new_string: "x\n开发解除阻塞\n" } })));

// ── 闸门6:写「PR 已合」之前自己去 main 上看一眼 ────────────────────────
// ★ 这道闸要真的跑 git,所以在**带 origin 的沙箱仓库**里跑(没有 .git 会 fail-open 放行)。
//   origin/main 上造一笔「… (#12)」的合并提交,#99999 铁定不存在。
{
  const d = gitSandbox();
  writeFileSync(join(d, "docs/BACKLOG.md"), "x\n");
  commitAll(d, "初版");
  writeFileSync(join(d, "docs/BACKLOG.md"), "x\ny\n");
  commitAll(d, "某个功能 (#12)");
  writeFileSync(join(d, "docs/BACKLOG.md"), "x\ny\nz\n");
  commitAll(d, "Merge pull request #34 from someone/topic");  // scan-public:ok(测试夹具:普通合并的标题)
  gitq(d, "push", "-q", "origin", "main");
  const ed = (sid, oldS, newS) => runIn(d, "guard-edit.mjs", {
    session_id: sid, tool_name: "Edit",
    tool_input: { file_path: "docs/BACKLOG.md", old_string: oldS, new_string: newS },
  });
  assert("红:写「PR #99999 已合」但 main 上找不到它",  // scan-public:ok(测试夹具)
    denied(ed("prm1", "x\n", "x\nPR #99999 已合\n")));  // scan-public:ok(测试夹具)
  assert("绿:闸6 只拦一次(第二次原样再来就放行)",
    allowed(ed("prm1", "x\n", "x\nPR #99999 已合\n")));  // scan-public:ok(测试夹具)
  assert("绿:写「PR #12 已合」而 main 上确实有它 → 放行(证明它查的是真历史)",  // scan-public:ok(测试夹具)
    allowed(ed("prm2", "x\n", "x\nPR #12 已合\n")));  // scan-public:ok(测试夹具)
  assert("绿:写「PR #34 已合」而 main 上是普通合并「Merge pull request #34 from …」→ 放行",  // scan-public:ok(测试夹具)
    allowed(ed("prm4", "x\n", "x\nPR #34 已合\n")));  // scan-public:ok(测试夹具)
  assert("红:写「PR #3 已合」,main 上只有 #34 / #12 → 不许把前缀当成命中",  // scan-public:ok(测试夹具)
    denied(ed("prm5", "x\n", "x\nPR #3 已合\n")));  // scan-public:ok(测试夹具)
  assert("绿:原文里本来就写着的不算新声称",
    allowed(ed("prm3", "PR #99999 已合\n", "PR #99999 已合\n别的\n")));  // scan-public:ok(测试夹具)
}

// ── 闸门14 记账半(guard-edit):往收件箱新增给别的塔的留言 → 旗标多一行 `relay:<目标们>:<毫秒>` ─────
// 只记不拦;收尾那半在下面「闸门14 核」。期望值写死在这儿(板块清单默认九个,换配置的那条单独测)。
// 全角标点用 fromCharCode 拼:源码里看不出全角半角,敲错一个就悄悄只测了一种。
{
  const FW = (c) => String.fromCharCode(c);
  const relayEdit = (sid, oldS, newS, { file = "docs/BACKLOG.md", dir = null, env = {} } = {}) => {
    const d = dir ?? sandbox();
    const r = runIn(d, "guard-edit.mjs", { session_id: sid, tool_name: "Edit",
      tool_input: { file_path: file, old_string: oldS, new_string: newS } }, { CLAUDE_CODE_REMOTE_SESSION_ID: "", ...env });
    return { ...r, dir: d, relays: flagsIn(d, sid).split("\n").filter((l) => l.startsWith("relay:")) };
  };
  const INBOX = "## 三、收件箱\n\n- 2026-01-05 10:00 · dev → **test** · 旧的一条\n";
  let r = relayEdit("r1", INBOX, INBOX + "- 2026-01-06 15:40 · meta → **product** · 回 x 那条 · docs/x.md\n");
  assert("闸14 记:收件箱新增 meta → product → 记一行 relay:product:<毫秒>,不拦",
    allowed(r) && r.relays.length === 1 && /^relay:product:\d+$/.test(r.relays[0]), r.relays.join(" | "));
  r = relayEdit("r2", INBOX, INBOX.replace("10:00", "10:05"));
  assert("闸14 记:只改旧留言的时刻(目标计数没变)→ 不记", r.relays.length === 0, r.relays.join(" | "));
  r = relayEdit("r3", INBOX, INBOX + "- 2026-01-06 01:40 · dev → dev(自留)· x\n- 2026-01-06 22:10 · dev → 用户 · 要你跑一条命令\n");
  assert("闸14 记:写给自己(自留)/ 写给用户 → 不记", r.relays.length === 0, r.relays.join(" | "));
  r = relayEdit("r4", INBOX, INBOX + "- 2026-01-06 15:15 · biz → ops / dev · x\n");
  assert("闸14 记:biz → ops / dev → 一行,目标排好序 dev+ops",
    r.relays.length === 1 && /^relay:dev\+ops:\d+$/.test(r.relays[0]), r.relays.join(" | "));
  r = relayEdit("r5", INBOX, INBOX + `- 2026-01-06 15:15 · biz → ops${FW(0xFF0C)}dev · x\n`);
  assert("闸14 记:几个目标用全角逗号隔开也认(dev+ops)",
    r.relays.length === 1 && /^relay:dev\+ops:\d+$/.test(r.relays[0]), r.relays.join(" | "));
  // ★ 只抄送 = 只告知:括号里的塔不用它动手,不算目标 —— 收尾也就不会要它的门铃
  r = relayEdit("r6", INBOX, INBOX + "- 2026-01-06 01:40 · dev → ops(抄 plan)· x\n" +
    `- 2026-01-06 01:41 · dev → ops${FW(0xFF08)}抄 meta${FW(0xFF09)} · y\n`);
  assert("闸14 记:只抄送的塔(半角 / 全角括号里)不算目标 → 两行都只记 ops",
    r.relays.length === 2 && r.relays.every((l) => /^relay:ops:\d+$/.test(l)), r.relays.join(" | "));
  r = relayEdit("r7", INBOX, INBOX + `- **2026-01-06 00:05 dev → test**${FW(0xFF1A)}两处已修\n` +
    "- 2026-01-06 21:35 · product + plan → meta · x\n");
  assert("闸14 记:整头加粗 + 全角冒号收尾 / 两个源 → test、meta 各一行",
    r.relays.map((l) => l.split(":")[1]).sort().join(",") === "meta,test", r.relays.join(" | "));
  r = relayEdit("r8", "x\n", "x\n- 2026-01-06 15:40 · meta → product · y\n", { file: "docs/journal.md" });
  assert("闸14 记:同样的行写进 journal.md → 不记(收件箱在 BACKLOG)", r.relays.length === 0, r.relays.join(" | "));
  {
    const d = sandbox();
    writeFileSync(join(d, "docs/BACKLOG.md"), INBOX + "- 2026-01-06 09:00 · product → dev · 已有\n");
    const w = runIn(d, "guard-edit.mjs", { session_id: "r9", tool_name: "Write",
      tool_input: { file_path: "docs/BACKLOG.md", content: INBOX +
        "- 2026-01-06 09:00 · product → dev · 已有\n- 2026-01-06 16:00 · product → dev · 新的\n" } });
    const rs = flagsIn(d, "r9").split("\n").filter((l) => l.startsWith("relay:"));
    assert("闸14 记:Write 整份覆盖,只比磁盘上那份多一条 → 只记一条",
      allowed(w) && rs.length === 1 && /^relay:dev:\d+$/.test(rs[0]), rs.join(" | "));
  }
  {
    const d = sandbox();
    const p = { session_id: "r10", tool_name: "Edit", tool_input: { file_path: "docs/BACKLOG.md",
      old_string: "| Q701 | x |\n", new_string: "| Q701 | x |\n| Q702 | y |\n- 2026-01-06 16:00 · meta → dev · z\n" } };
    const r1 = runIn(d, "guard-edit.mjs", p);
    const n1 = flagsIn(d, "r10").split("\n").filter((l) => l.startsWith("relay:")).length;
    assert("闸14 记:这一笔被闸门4 拒了(没落盘)→ 不记", denied(r1) && n1 === 0, `code=${r1.code} relay=${n1}`);
    const r2 = runIn(d, "guard-edit.mjs", p);
    const n2 = flagsIn(d, "r10").split("\n").filter((l) => l.startsWith("relay:")).length;
    assert("闸14 记:重试放行之后才记,只记一次", allowed(r2) && n2 === 1, `code=${r2.code} relay=${n2}`);
  }
  // 认「我是哪个塔」用 whoAmI(活表在沙箱里摆):本塔记下别的塔发给自己的话,不是要本塔去叫谁
  {
    const POOL_ME = "| dev | `tower-dev` | 云 | `session_DEVTOWER0000000001` | 在跑 |\n";
    const LINE = "- 2026-01-06 11:00 · plan → dev · plan 问的那件 dev 收到了\n";
    const mine = sandbox(), other = sandbox();
    for (const d of [mine, other]) writeFileSync(join(d, "docs/session-pool.md"), POOL_ME);
    const asDev = relayEdit("r11", INBOX, INBOX + LINE, { dir: mine, env: { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_DEVTOWER0000000001" } });
    assert("闸14 记:dev 塔(whoAmI 认出)记一条 plan → dev → 不记(目标是本塔)", asDev.relays.length === 0, asDev.relays.join(" | "));
    const asOther = relayEdit("r12", INBOX, INBOX + LINE, { dir: other, env: { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_OTHER00000000000000001" } });
    assert("闸14 记:同一行,认不出是 dev 塔的会话来写 → 照记 relay:dev(证明不记是因为认出了本塔)",
      asOther.relays.length === 1 && /^relay:dev:\d+$/.test(asOther.relays[0]), asOther.relays.join(" | "));
  }
  {
    const d = withCfg(sandbox(), { boards: ["alpha", "beta"] });
    const rc = relayEdit("r13", INBOX, INBOX + "- 2026-01-06 12:00 · alpha → beta · x\n- 2026-01-06 12:01 · meta → dev · y\n", { dir: d });
    assert("闸14 记:板块清单从配置读 —— 配了 alpha / beta,alpha → beta 记、meta → dev 不记",
      rc.relays.length === 1 && /^relay:beta:\d+$/.test(rc.relays[0]), rc.relays.join(" | "));
  }
}

// ── 闸门9:上下文过半 → 落盘先于压缩 ───────────────────────────────────
// 窗口 1M,半程 500K。读的是转录里最后一条 assistant 的 usage 真数,不是估的。
assert("红:上下文 600K(过半)→ 提醒落盘",
  blocked(stopHook({ sid: "ctx1", ctxTokens: 600_000 })));
assert("绿:上下文 400K 不拦", stopOk(stopHook({ sid: "ctx2", ctxTokens: 400_000 })));
assert("绿:闸9 只拦一次(第二次放行)",
  stopOk(stopHook({ sid: "ctx3", ctxTokens: 600_000, flags: "ctx-reminded\n" })));
// ★ 第一版拿转录**文件大小**估,7.7 MB 的累加转录被报成 80%、实际 42% —— 当天误伤作者自己。
//   这条钉死:文件再大,只要 usage 里的数不过半,就不许拦。
assert("绿:转录文件很大但 usage 没过半 → 不许拦(第一版就栽在这)",
  stopOk(stopHook({ sid: "ctx4", ctxTokens: 300_000, bloat: 6 })));
// ★ v3:窗口从设置里现读(例:自动压缩窗口设成 30 万)。有配置 → 70% 提醒。
const ACW = { autoCompactWindow: 300_000 };
assert("红:配了 30 万窗口,上下文 22 万(过 70%)→ 提醒落盘(没配的话 1M 的一半才拦,这条证明读了设置)",
  blocked(stopHook({ sid: "ctx5", ctxTokens: 220_000, settings: ACW })));
assert("绿:配了 30 万窗口,上下文 20 万(没到 70%)→ 不拦",
  stopOk(stopHook({ sid: "ctx6", ctxTokens: 200_000, settings: ACW })));
// ★ 每压缩一次重新提醒一次:旧版整个会话只拦一次,压过一轮之后再也不提醒。
assert("红:上一周期提醒过、之后压缩了一次、又涨过线 → 再提醒",
  blocked(stopHook({ sid: "ctx7", ctxTokens: 220_000, settings: ACW, compactions: 1, flags: "ctx-reminded\n" })));
assert("绿:这个压缩周期已经提醒过 → 放行",
  stopOk(stopHook({ sid: "ctx8", ctxTokens: 220_000, settings: ACW, compactions: 1, flags: "ctx-reminded@1\n" })));
// ★ 跟平台一样只认数字:"300k" 平台静默忽略(实测 2026-09-24),闸门也得当没配 —— 否则提醒跟真实压缩对不上。
assert("绿:设置写成字符串 \"300k\"(平台会忽略)→ 闸门也当没配,40 万不拦",
  stopOk(stopHook({ sid: "ctx9", ctxTokens: 400_000, settings: { autoCompactWindow: "300k" } })));
// ★ 框架自带的配置必须是数字 —— 写成 "300k" 平台不报错、静默不压,塔照样胖到七八十万。
{
  let w; try { w = JSON.parse(readFileSync(".claude/settings.json", "utf8")).autoCompactWindow; } catch {}
  assert("仓库 .claude/settings.json 的 autoCompactWindow 是 10 万–100 万之间的数字",
    typeof w === "number" && w >= 100_000 && w <= 1_000_000, `实际:${JSON.stringify(w)}`);
}

// ── 门铃的 transcript 夹具(闸门14 核、闸门15、闸门16 共用)──────────────────────
// 照平台的真形状摆:assistant 里的 tool_use,user 里的 tool_result(内容是文本块数组)。
// 时刻全按留言时刻 T14 摆;活表在沙箱里摆。期望值写死在这儿,不读 hook / lib 的实现。
const T14 = Date.parse("2026-01-06T15:00:00.000Z");
const at14 = (dt) => new Date(T14 + dt).toISOString();
let TU = 0;
const tuse = (dt, name, input, result = undefined, isErr = false) => {
  const id = `tu${++TU}`;
  const out = [{ type: "assistant", timestamp: at14(dt), message: { content: [{ type: "tool_use", id, name, input }] } }];
  if (result !== undefined) out.push({ type: "user", timestamp: at14(dt + 1), message: { content: [{ type: "tool_result",
    tool_use_id: id, is_error: isErr, content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] }] } });
  return out;
};
const SRV = "mcp__0a1b2c3d-4e5f-6789-abcd-ef0123456789__";   // 云会话里 MCP 服务器名可能是一串 ID
const mkBell = (dt, psid, tid, extra = {}) => tuse(dt, SRV + "create_trigger",
  { persistent_session_id: psid, prompt: "去读收件箱", ...extra }, { trigger: { id: tid, persistent_session_id: psid } });
const press = (dt, tid, psid, landed = psid.replace(/^session_/, "cse_")) => tuse(dt, SRV + "fire_trigger",
  { trigger_id: tid }, { trigger: { id: tid, persistent_session_id: psid }, session_id: landed, conversation_id: "" });
const say = (dt, text) => [{ type: "assistant", timestamp: at14(dt), message: { content: [{ type: "text", text }] } }];
const S_DEV = "session_DEVTOWER0000000001", S_OPS = "session_OPSTOWER0000000002", S_PLAN = "session_PLANTOWER000000003";
const S_OLDDEV = "session_OLDDEV00000000000009";
const POOL14 = ["| 塔 | 板块 skill | 形态 | 会话 ID / 链接 | 状态 |", "|---|---|---|---|---|",
  `| dev | \`tower-dev\` | 云 | \`${S_DEV}\`(上一任 \`${S_OLDDEV}\`) | 在跑 |`,
  `| ops | \`tower-ops\` | 云 | \`${S_OPS}\` | 在跑 |`,
  `| plan | \`tower-plan\` | 云 | \`${S_PLAN}\` | 在跑 |`,
  "| test | `tower-test` | 云 | ⬜ 待开 | |", ""].join("\n");
function stop14({ flags = `relay:dev:${T14}\n`, entries = [], pool = POOL14, dir = null, sid = "b14", tp = null }) {
  const d = dir ?? sandbox();
  if (pool !== null) writeFileSync(join(d, "docs/session-pool.md"), pool);
  const path = tp ?? join(d, "transcript.jsonl");
  if (!tp) writeFileSync(path, entries.flat().map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (!dir) writeFileSync(join(d, ".claude/.session-state", `${sid}.flags`), flags);
  const r = runIn(d, "guard-stop.mjs", { session_id: sid, transcript_path: path, stop_hook_active: false },
    { CLAUDE_CODE_REMOTE_SESSION_ID: "" });
  let j = null; try { j = JSON.parse(r.out); } catch {}
  return { ...r, dir: d, decision: j?.decision ?? null, reason: j?.reason ?? "" };
}

// ── 闸门14 核(guard-stop):留言之后,每个目标塔有没有一个门铃绑在它当前会话上 ───────────────
{
  let r = stop14({ entries: [tuse(-60000, "Edit", {})] });
  assert("红:闸14 留言之后没按门铃 → 拦,点名 dev、列出活表里 dev 的当前会话(那格的第一个)",
    blocked(r) && /闸门14/.test(r.reason) && /· → dev/.test(r.reason) && r.reason.includes(`dev:${S_DEV}`), r.reason.slice(0, 300));
  // ★ 断开的塔叫得醒(platform-facts §1.1):提示里要有这句,还要给「不按门铃:理由」的出路
  assert("闸14 的提示带「塔断开了照按新门铃」「已断开的工人叫不醒」「不按门铃:理由」",
    /塔断开了照按新门铃/.test(r.reason) && /已断开的工人叫不醒/.test(r.reason) && /不按门铃:理由/.test(r.reason), r.reason.slice(-400));
  const again = stop14({ dir: r.dir, tp: join(r.dir, "transcript.jsonl") });
  assert("绿:闸14 拦过一次,再 Stop → 放行", blocked(r) && stopOk(again), again.reason.slice(0, 120));

  r = stop14({ entries: [mkBell(60000, S_DEV, "trig_A1"), press(70000, "trig_A1", S_DEV)] });
  assert("绿:闸14 留言之后建门铃绑 dev 当前会话、按了 → 放行", stopOk(r), r.reason.slice(0, 160));
  assert("闸14 放行时记 relay-ok(这条留言以后不再核)",
    flagsIn(r.dir, "b14").split("\n").includes(`relay-ok:dev:${T14}`), flagsIn(r.dir, "b14"));
  // ★ 「对应的塔」:门铃按了,但绑的不是 dev 的当前会话 → 照拦
  r = stop14({ entries: [mkBell(60000, S_PLAN, "trig_A2"), press(70000, "trig_A2", S_PLAN)] });
  assert("红:闸14 门铃绑的是别的塔(plan)→ 照拦", blocked(r) && /· → dev/.test(r.reason), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(60000, S_OLDDEV, "trig_A3"), press(70000, "trig_A3", S_OLDDEV)] });
  assert("红:闸14 绑的是活表那格里顺带写着的上一任(不是第一个)→ 照拦", blocked(r), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(-60000, S_DEV, "trig_A4"), press(-50000, "trig_A4", S_DEV)] });
  assert("红:闸14 建门铃、按门铃都在留言之前 → 拦(先留痕后叫人)", blocked(r), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(60000, S_DEV, "trig_A5")] });
  assert("红:闸14 只建了门铃没按 → 拦", blocked(r), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(60000, S_DEV, "trig_A6", { run_once_at: "2026-01-06T16:00:00Z" })] });
  assert("绿:闸14 建的门铃带 run_once_at(到点自己响,不用按)→ 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(-60000, S_DEV, "trig_A7"), press(70000, "trig_A7", S_DEV)] });
  assert("绿:闸14 门铃留言之前就建好、留言之后才按(看回执里绑的会话)→ 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(60000, S_DEV, "trig_A8"), tuse(70000, SRV + "fire_trigger", { trigger_id: "trig_A8" }, "fired")] });
  assert("绿:闸14 回执认不出,按门铃 id 对回建它那次绑的 dev → 放行", stopOk(r), r.reason.slice(0, 160));
  // 建门铃报错(比如对方会话已归档)不算;后面那次按也没结果 —— 认不出绑的是谁,不能算 dev
  r = stop14({ entries: [tuse(60000, SRV + "create_trigger", { persistent_session_id: S_DEV, prompt: "去读收件箱" },
    "Session is archived; only active sessions can be bound to triggers", true),
    tuse(70000, SRV + "fire_trigger", { trigger_id: "trig_A9" })] });
  assert("红:闸14 建门铃报错了(is_error)不算 → 拦", blocked(r), r.reason.slice(0, 160));
  // ★ 「按过」要有凭据:转录里只有调用、没有结果的 fire_trigger 不算(门铃 id 对得上 dev 也不算)。装了框架的项目审查出来的
  r = stop14({ entries: [mkBell(60000, S_DEV, "trig_A11"), tuse(70000, SRV + "fire_trigger", { trigger_id: "trig_A11" })] });
  assert("红:闸14 按门铃那次转录里只有调用、没有结果 → 不算按过,照拦", blocked(r) && /· → dev/.test(r.reason), r.reason.slice(0, 160));
  r = stop14({ entries: [tuse(60000, SRV + "create_trigger",
    { persistent_session_id: S_DEV, prompt: "去读收件箱", run_once_at: "2026-01-06T16:00:00Z" })] });
  assert("红:闸14 带 run_once_at 的建门铃没有结果 → 不算,照拦", blocked(r) && /· → dev/.test(r.reason), r.reason.slice(0, 160));
  // ★ 没结果的建门铃也要更新「最近想绑谁」:后面回执认不出、id 也对不上的 fire 落到它想绑的会话,不落回更早那个门铃。
  //   v0.3.2 把没结果的 create_trigger 整条跳过,那次 fire 就记到了更早门铃绑的会话上(装了框架的项目审查发现)。
  r = stop14({ entries: [mkBell(-60000, S_DEV, "trig_X1"),
    tuse(60000, SRV + "create_trigger", { persistent_session_id: S_OPS, prompt: "去读收件箱" }),
    tuse(70000, SRV + "fire_trigger", { trigger_id: "trig_Y1" }, "ok")] });
  assert("红:闸14 先前建过绑 dev 的门铃,留言后建绑 ops 的没结果、再按一个认不出的 → 算按给 ops,dev 照拦",
    blocked(r) && /· → dev/.test(r.reason), r.reason.slice(0, 160));
  r = stop14({ entries: [mkBell(-60000, S_OPS, "trig_X2"),
    tuse(60000, SRV + "create_trigger", { persistent_session_id: S_DEV, prompt: "去读收件箱" }),
    tuse(70000, SRV + "fire_trigger", { trigger_id: "trig_Y2" }, "ok")] });
  assert("绿:闸14 先前建过绑 ops 的门铃,留言后建绑 dev 的没结果、再按一个认不出的 → 算按给 dev(取最近想绑的),放行",
    stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: `relay:dev:${T14}\nbell:trig_A10:DEVTOWER0000000001:DEVTOWER0000000001:${T14 + 5000}\n` });
  assert("绿:闸14 transcript 里没有、旗标里有 PostToolUse 记的回执,绑的是 dev → 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: `relay:dev:${T14}\nbell:trig_A10:DEVTOWER0000000001:DEVTOWER0000000001:${T14 - 5000}\n` });
  assert("红:闸14 旗标里那次回执在留言之前 → 拦", blocked(r), r.reason.slice(0, 160));

  r = stop14({ flags: `relay:dev+ops:${T14}\n`, entries: [mkBell(60000, S_DEV, "trig_B1"), press(61000, "trig_B1", S_DEV),
    mkBell(62000, S_OPS, "trig_B2"), press(63000, "trig_B2", S_OPS)] });
  assert("绿:闸14 两个目标、两个门铃都按了 → 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: `relay:dev+ops:${T14}\n`, entries: [mkBell(60000, S_DEV, "trig_B3"), press(61000, "trig_B3", S_DEV)] });
  assert("红:闸14 两个目标只按了 dev → 拦,写明没按 ops、列出 ops 的会话",
    blocked(r) && r.reason.includes("· → dev + ops(没按:ops)") && r.reason.includes(`ops:${S_OPS}`), r.reason.slice(0, 300));
  r = stop14({ flags: `relay:dev:${T14}\nrelay:ops:${T14 + 100000}\n`, entries: [mkBell(60000, S_DEV, "trig_B4"), press(70000, "trig_B4", S_DEV)] });
  assert("红:闸14 两条留言一条按了一条没按 → 拦,只列没按的 ops",
    blocked(r) && /· → ops/.test(r.reason) && !/· → dev/.test(r.reason), r.reason.slice(0, 200));
  // 活表里查不到会话的塔(待开 / 没这一行):核不了对不对,只看留言之后按没按过门铃
  r = stop14({ flags: `relay:test:${T14}\n` });
  assert("红:闸14 目标塔活表里没会话、留言之后一个门铃都没按 → 拦,写明去哪查",
    blocked(r) && /test:活表里没有/.test(r.reason), r.reason.slice(-400));
  r = stop14({ flags: `relay:test:${T14}\n`, entries: [mkBell(60000, "session_NEWTEST000000000004", "trig_B5"),
    press(70000, "trig_B5", "session_NEWTEST000000000004")] });
  assert("绿:闸14 目标塔活表里没会话、留言之后按过一个门铃 → 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: `relay:test:${T14}\n`, entries: [mkBell(60000, S_DEV, "trig_B6"), press(70000, "trig_B6", S_DEV)] });
  assert("红:闸14 目标塔活表里没会话、留言之后只按了 dev 的门铃 → 照拦(那个门铃是给 dev 的)",
    blocked(r) && /· → test/.test(r.reason), r.reason.slice(0, 200));

  // 放行口子:「不按门铃:理由」(只是告知、不用对方动手)
  r = stop14({ entries: [say(30000, "看过了。\n不按门铃" + String.fromCharCode(0xFF1A) + "只是告知,dev 不用动手")] });
  assert("绿:闸14 留言之后回复里单独一行「不按门铃(全角冒号)理由」→ 放行,记 relay-ok",
    stopOk(r) && flagsIn(r.dir, "b14").split("\n").includes(`relay-ok:dev:${T14}`), r.reason.slice(0, 160));
  r = stop14({ entries: [say(30000, "- **不按门铃**:dev 那边不用改")] });
  assert("绿:闸14 「- **不按门铃**:理由」(列表 + 加粗,半角冒号)→ 放行", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ entries: [say(-30000, "不按门铃:只是告知")] });
  assert("红:闸14 「不按门铃:」写在留言之前 → 照拦", blocked(r), r.reason.slice(0, 160));
  r = stop14({ entries: [say(30000, "闸门14 说可以写一行「不按门铃:理由」放行,我先查一下")] });
  assert("红:闸14 只是行中引用了「不按门铃:理由」→ 照拦(只认行首)", blocked(r), r.reason.slice(0, 160));
  r = stop14({ entries: [say(30000, "不按门铃:")] });
  assert("红:闸14 「不按门铃:」后面没写理由 → 照拦", blocked(r), r.reason.slice(0, 160));
  assert("绿:闸14 transcript 读不了 → 放行(fail-open)", stopOk(stop14({ tp: join(tmpdir(), "belltower-no-such-transcript.jsonl") })));
  assert("绿:闸14 没有留言旗标 → 放行", stopOk(stop14({ flags: "" })));
}

// ── 闸门15(guard-stop):PostToolUse 记下的回执里,绑的和落进的对不上 → 提醒一次 ─────────────
{
  const B = (tid, want, got, dt) => `bell:${tid}:${want}:${got}:${T14 + dt}\n`;
  const D = "DEVTOWER0000000001", EMPTY = "NEWEMPTY0000000000005";
  const ARCH = SRV + "archive_session", INTR = SRV + "interrupt_session";
  let r = stop14({ flags: B("trig_C1", D, D, 1000) });
  assert("绿:闸15 回执里落进的就是绑的会话 → 不提醒", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C2", D, EMPTY, 1000) });
  assert("红:闸15 回执对不上 → 提醒:点名门铃、落进的会话,叫新建一个再按、别重按旧的",
    blocked(r) && /闸门15/.test(r.reason) && /trig_C2/.test(r.reason) && r.reason.includes(`cse_${EMPTY}`) &&
    /新建/.test(r.reason) && /别重按旧的/.test(r.reason), r.reason.slice(0, 300));
  assert("闸15 的提示分清塔和工人:断开的塔叫得醒,disconnected 的工人别再按",
    /断开的塔新门铃也叫得醒/.test(r.reason) && /`disconnected` 的\*\*工人\*\*:别再按/.test(r.reason), r.reason.slice(-400));
  const again = stop14({ dir: r.dir, tp: join(r.dir, "transcript.jsonl") });
  assert("绿:闸15 每个门铃只提醒一次,再 Stop → 放行", stopOk(again), again.reason.slice(0, 160));
  // 已经善后的不提醒
  r = stop14({ flags: B("trig_C3", D, EMPTY, 1000) + B("trig_C4", D, D, 5000) });
  assert("绿:闸15 没送到,之后新门铃送到了同一个目标 → 不提醒", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C5", D, EMPTY, 1000) + B("trig_C6", "OPSTOWER0000000002", "OPSTOWER0000000002", 5000) });
  assert("红:闸15 之后送到的是别的目标 → 照提醒", blocked(r) && /trig_C5/.test(r.reason), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C7", D, EMPTY, 1000) + B("trig_C8", D, "NEWEMPTY0000000000006", 5000) });
  assert("红:闸15 之后对同一目标又按了一个、也没送到 → 不算善后,照提醒第一个", blocked(r) && /trig_C7/.test(r.reason), r.reason.slice(0, 200));
  r = stop14({ flags: B("trig_C9", D, EMPTY, 1000), entries: [tuse(3000, ARCH, { session_id: `session_${EMPTY}` }, "ok")] });
  assert("绿:闸15 没送到,之后归档了落错的那个会话 → 不提醒", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C10", D, EMPTY, 1000), entries: [tuse(3000, INTR, { session_id: `cse_${EMPTY}` }, "ok")] });
  assert("绿:闸15 没送到,之后打断了落错的那个会话 → 不提醒", stopOk(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C11", D, EMPTY, 1000), entries: [tuse(3000, ARCH, { session_id: "session_SOMEOTHER0000000007" }, "ok")] });
  assert("红:闸15 之后归档的是别的会话 → 照提醒", blocked(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C12", D, EMPTY, 5000), entries: [tuse(1000, ARCH, { session_id: `session_${EMPTY}` }, "ok")] });
  assert("红:闸15 归档发生在按门铃之前 → 照提醒", blocked(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C13", D, EMPTY, 1000), entries: [tuse(3000, ARCH, { session_id: `session_${EMPTY}` }, "boom", true)] });
  assert("红:闸15 归档那次报错了 → 照提醒", blocked(r), r.reason.slice(0, 160));
  r = stop14({ flags: B("trig_C14", D, EMPTY, 1000), entries: [tuse(3000, ARCH, { session_id: `session_${EMPTY}` })] });
  assert("红:闸15 归档那次转录里只有调用、没有结果 → 不算善后,照提醒", blocked(r) && /trig_C14/.test(r.reason), r.reason.slice(0, 160));
}
// ★ 派工人那道闸的接线:平台上 MCP 服务的名字因环境而异(有的是可读名,有的是一串 ID),
//   matcher 写死一个名字,换个环境闸门10 就整个不响。matcher 是正则,两种名字都要匹配得上。
{
  let ms = [];
  try { ms = JSON.parse(readFileSync(".claude/settings.json", "utf8")).hooks.PreToolUse
    .filter((h) => (h.hooks ?? []).some((x) => /guard-mcp/.test(x.command))).map((h) => h.matcher); } catch {}
  const hit = (name) => ms.some((m) => { try { return new RegExp(`^(?:${m})$`).test(name); } catch { return false; } });
  assert("settings 把 create_session 接到 guard-mcp(可读名)", hit("mcp__Claude_Code_Remote__create_session"));
  assert("settings 把 create_session 接到 guard-mcp(ID 名)", hit("mcp__0a1b2c3d-4e5f-6789-abcd-ef0123456789__create_session"));
  assert("settings 把 merge_pull_request 接到 guard-mcp", hit("mcp__github__merge_pull_request"));
  assert("settings 不把无关工具接到 guard-mcp", !hit("mcp__github__list_pull_requests"));
  // 闸门16 在 PreToolUse 拦重按;闸门15 要的回执在 PostToolUse 记 —— 两头都得接上,服务器名两种都要认
  assert("settings 把 fire_trigger 接到 guard-mcp(PreToolUse,可读名)", hit("mcp__Claude_Code_Remote__fire_trigger"));
  assert("settings 把 fire_trigger 接到 guard-mcp(PreToolUse,ID 名)", hit(SRV + "fire_trigger"));
  let post = [];
  try { post = JSON.parse(readFileSync(".claude/settings.json", "utf8")).hooks.PostToolUse
    .filter((h) => (h.hooks ?? []).some((x) => /guard-mcp/.test(x.command))).map((h) => h.matcher); } catch {}
  const hitPost = (name) => post.some((m) => { try { return new RegExp(`^(?:${m})$`).test(name); } catch { return false; } });
  assert("settings 把 fire_trigger 的回执接到 guard-mcp(PostToolUse,可读名 + ID 名)",
    hitPost("mcp__Claude_Code_Remote__fire_trigger") && hitPost(SRV + "fire_trigger"));
  assert("settings 的 PostToolUse 照旧接着 create_pull_request", hitPost("mcp__github__create_pull_request"));
}

// ── 闸门10 / 11:MCP 工具那两个口子 ────────────────────────────────────
const mcp = (dir, sid, tool_name, tool_input = {}) =>
  runIn(dir, "guard-mcp.mjs", { session_id: sid, tool_name, tool_input });
const seed0 = (dir, sid, txt) => {
  mkdirSync(join(dir, ".claude/.session-state"), { recursive: true });
  writeFileSync(join(dir, ".claude/.session-state", `${sid}.flags`), txt);
};
const SRC = { source_url: "https://example.com/r.git", source_revision: "main" };   // 闸门13 要的两个参数
{
  const d = sandbox();
  const r = mcp(d, "m1", "mcp__Claude_Code_Remote__create_session", { title: "Q301 · 某某", ...SRC });
  assert("红:派工人(create_session)先问铁律6 那两句", denied(r));
  // ★ 话术里那三问是这道闸的全部价值 —— 只查 exit code 等于什么都没查。
  //   ③「归档了吗」是 2026-09-15 加的:hook 调不了 archive_session,
  //   所以「每次开新 session 顺手归档旧的」只能靠这一问顶着。
  assert("闸10 问到「用户说过吗 + 写出处」", /写出处/.test(r.err), r.err.slice(0, 80));
  assert("闸10 问到「是不是你自己板块的」", /自己板块/.test(r.err), r.err.slice(0, 80));
  // ★ 第一版只查「归档」两个字 —— 把第三问整行删掉它照样绿(后面几行的解释里也有「归档」)。
  //   钉住问句本身。[实测✅ 2026-09-15 MUT-G10d 抓到这条假绿]
  assert("闸10 问到「上一个工人归档了吗」", /归档了吗/.test(r.err), r.err.slice(0, 80));
  assert("绿:闸10 只拦一次(第二次放行)",
    allowed(mcp(d, "m1", "mcp__Claude_Code_Remote__create_session", { title: "Q301 · 某某", ...SRC })));
}
{
  const d = sandbox();
  assert("红:合 PR 先问三句",
    denied(mcp(d, "m2", "mcp__github__merge_pull_request", { pullNumber: 42 })));
  assert("绿:闸11 只拦一次(第二次放行)",
    allowed(mcp(d, "m2", "mcp__github__merge_pull_request", { pullNumber: 42 })));
}
// 两道闸各管各的:派工人那道不该被合 PR 触发,反之亦然。
{
  const d = sandbox();
  assert("绿:闸10 拦过之后,合 PR 仍然由闸11 自己拦(旗标不串)",
    denied(mcp(d, "m3", "mcp__Claude_Code_Remote__create_session", SRC)) &&
    denied(mcp(d, "m3", "mcp__github__merge_pull_request", { pullNumber: 1 })));
}
assert("绿:别的 MCP 工具不拦",
  allowed(mcp(sandbox(), "m4", "mcp__github__list_pull_requests")));

// ── 闸门13:create_session 要带 source_url + source_revision ──────────────
{
  const d = sandbox();
  seed0(d, "s1", "dispatch-reminded\n");   // 闸门10 已经问过,这里只看闸门13
  const r = mcp(d, "s1", "mcp__Claude_Code_Remote__create_session", { title: "Q302 · 某某", source_url: "https://example.com/r.git" });
  assert("红:create_session 只带 source_url、没带 source_revision → 拦", denied(r) && /source_revision/.test(r.err), r.err.slice(0, 120));
  assert("绿:闸13 同一个标题原样再来一次放行(软闸)",
    allowed(mcp(d, "s1", "mcp__Claude_Code_Remote__create_session", { title: "Q302 · 某某", source_url: "https://example.com/r.git" })));
  assert("红:闸13 换一个标题要再拦一次(按标题记,不是一个会话只拦一次)",
    denied(mcp(d, "s1", "mcp__Claude_Code_Remote__create_session", { title: "Q303 · 别的", source_url: "https://example.com/r.git" })));
  assert("红:两个都没带 → 拦,两个都点名",
    ((x) => denied(x) && /source_url/.test(x.err) && /source_revision/.test(x.err))(
      mcp(d, "s1", "mcp__Claude_Code_Remote__create_session", { title: "Q304" })));
  assert("绿:两个都带了 → 闸13 不拦",
    allowed(mcp(d, "s1", "mcp__Claude_Code_Remote__create_session", { title: "Q305", ...SRC })));
}

// ── 门铃回执记账(guard-mcp PostToolUse fire_trigger):给闸门15 核送达、闸门16 认「按过」──────────
// tool_response 包成什么样框架没实测 —— 三种可能的样子各钉一条;认不出就不记。
{
  const RCPT = { trigger: { id: "trig_R1", persistent_session_id: S_DEV }, session_id: "cse_DEVTOWER0000000001" };
  const post = (sid, tool_response) => {
    const d = sandbox();
    const r = runIn(d, "guard-mcp.mjs", { session_id: sid, hook_event_name: "PostToolUse",
      tool_name: SRV + "fire_trigger", tool_input: { trigger_id: "trig_R1" }, tool_response });
    return { ...r, bells: flagsIn(d, sid).split("\n").filter((l) => l.startsWith("bell:")) };
  };
  const SAME = /^bell:trig_R1:DEVTOWER0000000001:DEVTOWER0000000001:\d+$/;
  let r = post("k1", [{ type: "text", text: JSON.stringify(RCPT) }]);
  assert("回执记账:MCP 内容块数组 → 记 bell:<门铃>:<绑的>:<落进的>:<毫秒>(会话去了前缀)",
    allowed(r) && r.bells.length === 1 && SAME.test(r.bells[0]), r.bells.join(" | "));
  r = post("k2", RCPT);
  assert("回执记账:直接是对象 → 一样记", r.bells.length === 1 && SAME.test(r.bells[0]), r.bells.join(" | "));
  r = post("k3", JSON.stringify(RCPT));
  assert("回执记账:是 JSON 串 → 一样记", r.bells.length === 1 && SAME.test(r.bells[0]), r.bells.join(" | "));
  r = post("k4", { ...RCPT, session_id: "cse_NEWEMPTY0000000000005" });
  assert("回执记账:落进的会话对不上也照记(闸门15 收尾时核)",
    r.bells.length === 1 && /^bell:trig_R1:DEVTOWER0000000001:NEWEMPTY0000000000005:\d+$/.test(r.bells[0]), r.bells.join(" | "));
  r = post("k5", [{ type: "text", text: "Error: trigger not found" }]);
  assert("回执记账:认不出回执(报错文字)→ 不记、放行", allowed(r) && r.bells.length === 0, r.bells.join(" | "));
}

// ── 闸门16:一个门铃只按一次(guard-mcp PreToolUse fire_trigger)────────────────────────────
{
  const FT = SRV + "fire_trigger";
  const pre = (dir, entries, tid, { tool = FT, sid = "f16", self = null } = {}) => {
    const tp = join(dir, "t16.jsonl");
    writeFileSync(tp, entries.flat().map((e) => JSON.stringify(e)).join("\n") + "\n");
    return runIn(dir, "guard-mcp.mjs", { session_id: sid, hook_event_name: "PreToolUse", transcript_path: tp,
      tool_name: tool, tool_input: { trigger_id: tid }, ...(self ? { tool_use_id: self } : {}) });
  };
  let d = sandbox();
  let r = pre(d, [press(1000, "trig_H", S_DEV)], "trig_H");
  assert("红:闸16 同一个门铃本会话按过一次(有结果、没报错)→ 再按之前拦,叫新建一个",
    denied(r) && /闸门16/.test(r.err) && /已经按过一次/.test(r.err) && /新建/.test(r.err), r.err.slice(0, 200));
  r = pre(d, [press(1000, "trig_H", S_DEV)], "trig_H");
  assert("绿:闸16 原样再来一次 → 放行", allowed(r), r.err.slice(0, 120));
  r = pre(sandbox(), [press(1000, "trig_H", S_DEV)], "trig_I");
  assert("绿:闸16 按的是别的门铃 → 不拦", allowed(r), r.err.slice(0, 120));
  r = pre(sandbox(), [tuse(1000, FT, { trigger_id: "trig_H" }, "Error: not found", true)], "trig_H");
  assert("绿:闸16 上一次按报错了(没按出去)→ 不拦", allowed(r), r.err.slice(0, 120));
  r = pre(sandbox(), [press(1000, "trig_J", S_DEV)], "trig_J", { tool: "mcp__Claude_Code_Remote__fire_trigger" });
  assert("红:闸16 服务器名是可读名也认(按后缀)", denied(r), r.err.slice(0, 120));
  // ★ 真 harness 的形状:PreToolUse 跑时,这次调用自己的 tool_use 已经在 transcript 里、还没结果;
  //   同一条消息并发按几个新门铃,兄弟几个也在里面、也没结果 —— 不许拿自己拦自己。
  //   这条故意不带 tool_use_id:只靠「没结果不算」挡住自己(带了 id 会被另一条判据先挡掉,测不到这一条)。
  const batch = (dt, tids) => [{ type: "assistant", timestamp: at14(dt),
    message: { content: tids.map((tid, i) => ({ type: "tool_use", id: `tb${dt}x${i}`, name: FT, input: { trigger_id: tid } })) } }];
  r = pre(sandbox(), [mkBell(500, S_DEV, "trig_K1"), mkBell(600, S_OPS, "trig_K2"), batch(1000, ["trig_K1", "trig_K2"])], "trig_K2");
  assert("绿:闸16 同一轮并发按两个新门铃,自己和兄弟都还没结果 → 不拦", allowed(r), r.err.slice(0, 160));
  r = pre(sandbox(), [press(1000, "trig_K3", S_DEV), batch(2000, ["trig_K3"])], "trig_K3", { self: "tb2000x0" });
  assert("红:闸16 上一次按完有结果 + 这次自己也在 transcript 里 → 照拦", denied(r), r.err.slice(0, 160));
  // 「按过」也认 PostToolUse 记下的回执;旗标里的 id 后面带冒号比 —— trig_K4 的旗标不许冒充 trig_K
  d = sandbox();
  seed0(d, "f16b", "bell:trig_K4:DEVTOWER0000000001:DEVTOWER0000000001:1767711600000\n");
  r = pre(d, [], "trig_K4", { sid: "f16b" });
  assert("红:闸16 transcript 里没有、旗标里有这个门铃的回执 → 拦", denied(r), r.err.slice(0, 160));
  r = pre(d, [], "trig_K", { sid: "f16b" });
  assert("绿:闸16 旗标里是 trig_K4,按的是 trig_K → 不拦(不许前缀误中)", allowed(r), r.err.slice(0, 160));
  // PostToolUse 那一趟只记账。★ 换干净的沙箱,旗标里只有「按过」那一行:沿用上面那个的话,里面已经有拦过一次留下的
  //   refire-reminded,闸门16 本来就不拦,这两条什么都测不到(变异验过:删掉记账之后那个 exit,沿用旧沙箱的写法照样绿)。
  const postOnly = (extra = {}) => {
    const p = sandbox();
    seed0(p, "f16c", "bell:trig_K4:DEVTOWER0000000001:DEVTOWER0000000001:1767711600000\n");
    return runIn(p, "guard-mcp.mjs", { session_id: "f16c", hook_event_name: "PostToolUse", tool_name: FT,
      tool_input: { trigger_id: "trig_K4" }, ...extra });
  };
  r = postOnly({ tool_response: [{ type: "text", text: "{}" }] });
  assert("绿:闸16 PostToolUse 那一趟只记账、不拦(哪怕旗标说按过)", allowed(r), r.err.slice(0, 160));
  r = postOnly();
  assert("绿:闸16 PostToolUse 没带 tool_response 也只记账、不拦(工具已经跑完了)", allowed(r), r.err.slice(0, 160));
}

// ── 旗标按整行比对:#42 的旗标不能冒充 #4 ─────────────────────────────────
{
  const d = sandbox();
  seed0(d, "p1", "readpr:42\n");
  assert("红:读过 #42 不等于读过 #4(旗标不许前缀匹配)",  // scan-public:ok(测试夹具)
    denied(mcp(d, "p1", "mcp__github__merge_pull_request", { pullNumber: 4 })));
  seed0(d, "p2", "openedcodepr:42\nreadpr:4\n");
  assert("绿:开过代码 PR #42、读过 #4 → 合 #4 放行(硬闸不许被 #42 误触)",  // scan-public:ok(测试夹具)
    allowed(mcp(d, "p2", "mcp__github__merge_pull_request", { pullNumber: 4 })));
}

// ── 闸门11 v2:代码 PR 不许自己开自己合(乙)────────────────────────────
const seed = (dir, sid, txt) =>
  writeFileSync(join(dir, ".claude/.session-state", `${sid}.flags`), txt);
{
  const d = sandbox();
  seed(d, "y1", "openedcodepr:77\nreadpr:77\n");
  assert("红:自己开的**代码** PR 不许自己合",
    denied(mcp(d, "y1", "mcp__github__merge_pull_request", { pullNumber: 77 })));
  // ★ 这是硬闸,**没有**「再来一次就放行」—— 其余各闸都有,这条故意没有。
  assert("红:硬闸没有第二次放行(再来一次照样拦)",
    denied(mcp(d, "y1", "mcp__github__merge_pull_request", { pullNumber: 77 })));
}
{
  const d = sandbox();
  seed(d, "y2", "openeddocpr:78\nreadpr:78\n");
  assert("绿:自己开的**文档/harness** PR 可以自己合(否则 harness 改动直接卡死)",
    allowed(mcp(d, "y2", "mcp__github__merge_pull_request", { pullNumber: 78 })));
}
{
  const d = sandbox();
  seed(d, "y3", "readpr:79\n");
  assert("绿:读过这个 PR 的实际状态就放行",
    allowed(mcp(d, "y3", "mcp__github__merge_pull_request", { pullNumber: 79 })));
}
{
  const d = sandbox();
  assert("红:没读过就合 → 先去 pull_request_read",
    denied(mcp(d, "y4", "mcp__github__merge_pull_request", { pullNumber: 80 })));
  assert("绿:这条是每个 PR 各拦一次,第二次放行",
    allowed(mcp(d, "y4", "mcp__github__merge_pull_request", { pullNumber: 80 })));
  // 每个 PR 各自记账 —— #80 问过了不代表 #81 也问过。
  assert("红:换一个 PR 号仍要先读(旗标是按 PR 记的,不是按会话)",
    denied(mcp(d, "y4", "mcp__github__merge_pull_request", { pullNumber: 81 })));
}
// 记账两条:开了哪个 PR(PostToolUse 才拿得到号)、读过哪个 PR。
{
  const d = sandbox();
  runIn(d, "guard-mcp.mjs", { session_id: "y5", tool_name: "mcp__github__create_pull_request",
    tool_input: {}, tool_response: { url: "https://github.com/o/r/pull/91" } });  // scan-public:ok(测试夹具)
  assert("create_pull_request 把 PR 号记进旗标",
    /^opened(code|doc)pr:91$/m.test(flagsIn(d, "y5")), JSON.stringify(flagsIn(d, "y5")));
}
{
  const d = sandbox();
  runIn(d, "guard-mcp.mjs", { session_id: "y6", tool_name: "mcp__github__pull_request_read",
    tool_input: { pullNumber: 92 } });
  assert("pull_request_read 把 PR 号记进旗标",
    /^readpr:92$/m.test(flagsIn(d, "y6")), JSON.stringify(flagsIn(d, "y6")));
}
// ★ 台账 PR 的 head 是脚本造的 ledger/* 分支,内容只有台账四件;而开 PR 那一刻
//   工作树还在塔自己的分支上。dev 塔那条分支带着代码 —— 按工作树算就会把台账 PR
//   判成代码 PR,硬闸一拦没有放行口子,**dev 塔以后每记一次账都得求别的塔来合**。
// (head=ledger/* 与 codeDirs 的判据要在**真仓库**里才测得出来,见 test-ledger-push.mjs F 组)
{
  const d = sandbox();
  seed(d, "y8", "openeddocpr:93\nreadpr:93\n");
  assert("绿:台账 PR 塔可以自己合(否则每记一次账都要求别的塔)",
    allowed(mcp(d, "y8", "mcp__github__merge_pull_request", { pullNumber: 93 })));
}

// ── 闸门12 跟 ledger-push 读同一份直推清单(scripts/lib/direct-push.mjs)──────────
// 台账四件都已在 origin/main 上,只有 directPush 配的那一件改了没进 main:配了就拦、没配不拦(红绿成对)。
// 这条要跑 git,所以在带 origin 的沙箱仓库里跑;端到端那组在 test-ledger-push.mjs 的 E 组。
{
  const d = gitSandbox();
  for (const n of ["journal", "BACKLOG", "session-pool", "gate-log", "notes"]) writeFileSync(join(d, `docs/${n}.md`), `# ${n}\n`);
  gitq(d, "add", "docs"); gitq(d, "commit", "-qm", "初版"); gitq(d, "push", "-q", "origin", "main");
  writeFileSync(join(d, "docs/notes.md"), "# notes\n本塔写的、还没进 main\n");
  const tp = join(d, "transcript.jsonl");
  writeFileSync(tp, JSON.stringify({ type: "assistant", message: { content: [{ text: "收尾" }] } }) + "\n");
  const stop12 = (sid) => {
    // 记号每次重摆:放行那次闸门会把它当「已合」自清理掉
    writeFileSync(join(d, ".claude/.session-state/ledger-pending.json"), JSON.stringify({ branch: "ledger/fake-tower-260101T0000" }));
    return runIn(d, "guard-stop.mjs", { session_id: sid, transcript_path: tp }, { CLAUDE_CODE_REMOTE_SESSION_ID: "" });
  };
  const off = stop12("g12a");
  assert("绿:闸12 没配 directPush → 只看台账四件(都已进 main),不拦", !/闸门12/.test(off.out), off.out.slice(0, 120));
  withCfg(d, { directPush: ["docs/notes.md"] });
  const on = stop12("g12b");
  assert("红:闸12 配了 directPush 的那件没进 main → 也拦(跟 ledger-push 读同一份清单)",
    /"decision":"block"/.test(on.out) && /闸门12/.test(on.out), on.out.slice(0, 120));
}

// ── ledger-push 的沙箱回归(scripts/test-ledger-push.mjs)────────────────
// 那套要建本地裸仓库 + pre-receive 钩子模拟分支保护,跟这里的沙箱不是一个量级,
// 所以单独一个文件;但入口只留 `node scripts/test-hooks.mjs` 一个,别人才不会漏跑。
{
  const r = spawnSync(process.execPath, ["scripts/test-ledger-push.mjs"],
    { encoding: "utf8", env: { ...process.env } });
  const m = (r.stdout ?? "").match(/ledger-push: (\d+) passed, (\d+) failed/);
  assert("ledger-push 沙箱回归全绿(含闸门12 端到端)",
    r.status === 0 && m && Number(m[2]) === 0,
    m ? `${m[1]} passed, ${m[2]} failed` : `code=${r.status} ${(r.stdout ?? "").slice(-200)}`);
  if (m) results.push(`        └─ 其中 ledger-push 沙箱 ${m[1]} 条`);
}
// 原话汇总(scripts/test-user-quotes.mjs)和假时钟(scripts/test-fake-clock.mjs)也各是一个文件,
// 理由同上:入口只留这一个。装进项目之后,项目里跑 `node scripts/test-hooks.mjs` 就连它俩一起跑了。
for (const [name, script, tag] of [["原话汇总", "scripts/test-user-quotes.mjs", "user-quotes"],
  ["假时钟", "scripts/test-fake-clock.mjs", "fake-clock"]]) {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env } });
  const m = (r.stdout ?? "").match(new RegExp(`${tag}: (\\d+) passed, (\\d+) failed`));
  assert(`${name}自测全绿(${script})`,
    r.status === 0 && m && Number(m[1]) > 0 && Number(m[2]) === 0,
    m ? `${m[1]} passed, ${m[2]} failed` : `code=${r.status} ${(r.stdout ?? "").slice(-200)} ${(r.stderr ?? "").slice(0, 200)}`);
  if (m) results.push(`        └─ 其中${name} ${m[1]} 条`);
}

// ── now.mjs / session-start.mjs ────────────────────────────────────────
{
  const r = runIn(sandbox(), "now.mjs", {});
  let ok = false;
  try {
    const j = JSON.parse(r.out);
    ok = j.hookSpecificOutput?.hookEventName === "UserPromptSubmit" &&
         String(j.hookSpecificOutput?.additionalContext).includes("本轮真实时刻");
  } catch {}
  assert("now.mjs 输出合法 JSON 且带时刻", ok, r.out.slice(0, 120));
  // ★ 上面只看「本轮真实时刻」这几个字在不在 —— stamp() 返回垃圾串它照样绿。
  //   这条看注进去的是不是**真时刻的形状**(变异:M36)。
  let real = false;
  try { real = STAMP_SHAPE.test(
    String(JSON.parse(r.out).hookSpecificOutput?.additionalContext)); } catch {}
  assert("now.mjs 注的是真时刻不是占位串", real, r.out.slice(0, 120));
}
{
  const r = runIn(withCfg(sandbox(), { timezone: "Asia/Tokyo" }), "now.mjs", {});
  assert("now.mjs 的时区从配置读",
    /\d{4}\/\d{2}\/\d{2}\D*\d{2}:\d{2} \(Asia\/Tokyo\)/.test(r.out), r.out.slice(0, 120));
}
// timezone 写坏了 → 用默认时区照常出,不许崩(测出来过:写成 Mars/Olympus,开局 hook 和每轮时刻行都退出 1)
const BAD_TZ = ["Mars/Olympus", "", "America/NewYork"];
for (const tz of BAD_TZ) {
  const r = runIn(withCfg(sandbox(), { timezone: tz }), "now.mjs", {});
  assert(`timezone 写坏了(${JSON.stringify(tz)})→ now.mjs 不崩,按默认时区出时刻`,
    r.code === 0 && STAMP_SHAPE.test(r.out), `code=${r.code} ${r.err.slice(0, 160)} ${r.out.slice(0, 120)}`);
}
// 钉时钟:测试模式认 BELLTOWER_NOW;不在测试模式时一律不认(生产里谁设了这个变量也改不了时刻)
{
  const r = runIn(sandbox(), "now.mjs", {}, { BELLTOWER_NOW: "2031-01-02T15:04:00Z" });
  assert("测试模式下 hook 认钉住的时刻(BELLTOWER_NOW)", /2031\/01\/02/.test(r.out), r.out.slice(0, 120));
  const p = runIn(sandbox(), "now.mjs", {}, { BELLTOWER_NOW: "2031-01-02T15:04:00Z", CLAUDE_HOOK_TEST: "0" });
  assert("不在测试模式时不认钉住的时刻", !/2031\/01\/02/.test(p.out) && STAMP_SHAPE.test(p.out), p.out.slice(0, 120));
}
const start = (dir, sid = "") => runIn(dir, "session-start.mjs", {}, { CLAUDE_CODE_REMOTE_SESSION_ID: sid });
for (const tz of BAD_TZ) {
  const r = start(withCfg(sandbox(), { timezone: tz }));
  assert(`timezone 写坏了(${JSON.stringify(tz)})→ session-start 不崩,第一行按默认时区出时刻`,
    r.code === 0 && STAMP_SHAPE.test(r.out.split("\n")[0] ?? ""), `code=${r.code} ${r.err.slice(0, 160)}`);
}
{
  const r = start(sandbox());
  assert("session-start 退出 0", r.code === 0, `code=${r.code} ${r.err.slice(0, 120)}`);
  assert("session-start 第一行是时刻", /^现在:/.test(r.out), r.out.slice(0, 60));
  assert("session-start 的时刻是真时刻不是占位串",
    STAMP_SHAPE.test(r.out.split("\n")[0] ?? ""), r.out.slice(0, 60));
  assert("session-start 提示声明板块", /板块=\?/.test(r.out));
  // ★ 板块清单是默认的九个(期望写死在这儿)。一板块一条,变异:从默认清单里删掉任一个名字,对应那条要红。
  for (const b of ["plan", "product", "dev", "data", "ops", "biz", "meta", "test", "patrol"])
    assert(`session-start 默认板块清单含 ${b}`,
      new RegExp(`板块=\\?\\([^)]*\\b${b}\\b[^)]*\\)`).test(r.out), r.out.split("\n").find((l) => /板块=/.test(l)));
  assert("session-start 默认提醒敏感数据要确认", /敏感数据默认不进本仓库/.test(r.out));
  assert("session-start 没配置时仓库名 = 目录名", r.out.split("\n")[1]?.startsWith("仓库:tower-hook-"), r.out.split("\n")[1]);
}
{
  const d = withCfg(sandbox(), { project: "Acme 内部工具", boards: ["alpha", "beta"],
    sensitiveReminder: "病历数据一律先问用户。" });
  const r = start(d);
  assert("session-start 项目名从配置读", r.out.includes("仓库:Acme 内部工具"), r.out.split("\n")[1]);
  assert("session-start 板块清单从配置读", /板块=\?\(alpha \/ beta\)/.test(r.out),
    r.out.split("\n").find((l) => /板块=/.test(l)));
  assert("session-start 敏感数据提醒从配置读", r.out.includes("病历数据一律先问用户"));
}
// ★ 代码现状必须是**现数的**。手写的数会烂掉 —— CLAUDE.md 写过「零代码」,
//   而那时 main 上已有几十个源文件(2026-09-10)。期望值在这里**自己摆出来**,
//   数哪几个目录由配置 codeDirs 定。
{
  const d = gitSandbox();
  for (const f of ["app/a.py", "app/b.md", "lib/c.ts", "other/d.py", "src/e.py"]) {
    mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), "x\n");
  }
  commitAll(d, "代码");
  const line = (r) => r.out.split("\n").find((l) => l.startsWith("代码:")) ?? "";
  const def = line(start(d));
  assert("session-start 没配置时数默认目录 src", /^代码:1 个文件、其中 1 个源文件/.test(def), def);
  withCfg(d, { codeDirs: ["app", "lib"] });
  const got = line(start(d));
  assert("session-start 按配置 codeDirs 现数代码(3 个文件、2 个源文件)",
    /^代码:3 个文件、其中 2 个源文件/.test(got), got);
  withCfg(d, { codeDirs: ["nothing-here"] });
  assert("session-start 配置目录里没代码 → 还没有", /^代码:还没有/.test(line(start(d))), line(start(d)));
}
// ★ 塔的身份要**现查**:会话 ID ↔ 活表。出处:2026-09-24 一个塔忘了自己是塔。
//   活表是沙箱里摆的,期望值写死在这儿(不读 hook 的实现)。
{
  const POOL = [
    "# 会话活表", "", "| 塔 | 板块 skill | 形态 | 会话 ID / 链接 | 状态 |", "|---|---|---|---|---|",
    "| plan | `tower-plan` | 云 | `session_PLAN0000000000000001` | 在跑 |",
    "| dev | `tower-dev` | 云 | `session_DEV00000000000000002` | 在跑 |",
    "| data | `other-data` | 云 | `session_DATA0000000000000003` | 前缀不对 |",
    "| alpha | `tower-alpha` | 云 | `session_ALPHA000000000000004` | 不在默认板块里 |",
    "| patrol | `tower-patrol` | 云 | `session_PATROL00000000000006` | 在跑 |",
    "", "| 单号 | 派发塔 | 任务 | 工人会话 | 分支 | 起跑 | 状态 |", "|---|---|---|---|---|---|---|",
    "| Q301 | dev | 某某 | `session_WORKER00000000000005` | x | x | 在跑 |", ""].join("\n");
  const d = sandbox();
  writeFileSync(join(d, "docs/session-pool.md"), POOL);
  for (const [board, id] of [["plan", "PLAN0000000000000001"], ["dev", "DEV00000000000000002"]]) {
    const r = start(d, `cse_${id}`);
    assert(`session-start 认得出自己是 ${board} 塔`, r.out.includes(`你是 **${board} 塔**`),
      r.out.split("\n").find((l) => /你是/.test(l)) ?? "(没有「你是」那行)");
    assert(`session-start 对 ${board} 塔提醒成品活派工人`, /成品活派工人/.test(r.out));
  }
  assert("session-start 报默认号段(dev → Q3xx)", /本塔号段:Q3xx/.test(start(d, "cse_DEV00000000000000002").out));
  // ★ 塔的本分按塔念(红绿成对):巡检塔不派工人,念「成品活派工人」会把它带歪;别的塔照旧念那套。
  //   期望值写死在这儿(不读 lib/config.mjs 的 DUTY)。变异:dutyOf 恒返回 default →「念巡检的本分」「不念成品活派工人」两条要红。
  {
    const p = start(d, "cse_PATROL00000000000006");
    const duty = p.out.split("\n").find((l) => /本分/.test(l)) ?? "(没有「本分」那行)";
    assert("session-start 认得出自己是 patrol 塔(默认板块清单里有它)", p.out.includes("你是 **patrol 塔**"),
      p.out.split("\n").find((l) => /你是/.test(l)) ?? "(没有「你是」那行)");
    assert("session-start 对巡检塔念巡检的本分(定期的活、不派工人、指向 tower-patrol)",
      duty.includes("巡检塔的本分") && duty.includes("不派工人") && duty.includes("不定规矩") && duty.includes(".claude/skills/tower-patrol/SKILL.md"), duty);
    assert("session-start 对巡检塔不念「成品活派工人」", !/成品活派工人/.test(p.out), duty);
    assert("session-start 巡检塔没有号段 → 不打「本塔号段」", !/本塔号段/.test(p.out), p.out.split("\n").find((l) => /号段/.test(l)));
    const v = start(d, "cse_DEV00000000000000002").out;
    assert("session-start 对 dev 塔照旧念「讨论 → 定 → 派工人 → 收活」,不念巡检的",
      /塔的本分:讨论 → 定 → 派工人 → 收活/.test(v) && !/巡检塔的本分/.test(v), v.split("\n").find((l) => /本分/.test(l)));
  }
  for (const [label, v] of [
    ["活表里没有的会话 ID", "cse_NOTREAL00000000000"],
    ["没有会话 ID(本机 / 测试)", ""],
    ["工人(任务会话表里的行)", "cse_WORKER00000000000005"],
    ["skill 前缀不是 tower- 的行", "cse_DATA0000000000000003"],
    ["板块不在清单里的行", "cse_ALPHA000000000000004"]]) {
    const r = start(d, v);
    assert(`session-start ${label}:不冒充任何塔`, !/你是 \*\*/.test(r.out) && r.code === 0,
      r.out.split("\n").find((l) => /你是/.test(l)) ?? `code=${r.code}`);
  }
  withCfg(d, { boards: ["alpha", "plan"], ranges: { alpha: "A9xx" } });
  assert("session-start 号段从配置读(alpha → A9xx)", /本塔号段:A9xx/.test(start(d, "cse_ALPHA000000000000004").out));
  assert("session-start 配置没给号段的板块不报号段", !/本塔号段/.test(start(d, "cse_PLAN0000000000000001").out));
  assert("session-start 板块清单从配置读:配了 alpha 就认得出 alpha 塔",
    start(d, "cse_ALPHA000000000000004").out.includes("你是 **alpha 塔**"));
  assert("session-start 板块清单从配置读:清单里没 dev 就不认 dev 塔",
    !/你是 \*\*/.test(start(d, "cse_DEV00000000000000002").out));
}

// ── 塔卡(tower-card.mjs)+ 每轮身份(now.mjs)────────────────────────────
// 出处:压缩之后,Skill 注入过的本塔技能全文不会补回来(docs/platform-facts.md §3);开局那两行身份只说
//   「你是谁」,不说「照什么干」。塔卡在开局 / 压缩 / 恢复后现读重贴:身份 + 本分 + 本塔 SKILL.md 全文 + 手上的工人。
// 活表、SKILL.md、tower.md、BACKLOG 全在沙箱里摆(不读本仓库的);期望值写死在这儿,不读 DUTY、不读卡的常量。
// ★ 一万字是平台对每个 hook 注入的硬上限(超了只剩文件路径 + 前约 2,000 字),长度断言写死 10000,不读实现里的封顶。
{
  const CAP = 10000;
  const END = "━━━━ 塔卡完 ━━━━";
  const ID = { plan: "cse_PLAN0000000000000001", dev: "cse_DEV00000000000000002",
    worker: "cse_WORKER00000000000005", patrol: "cse_PATROL00000000000006" };
  const towerRows = (devStatus = "常驻 · TOWER-STATUS-SENTINEL") => [
    "# 会话活表", "", "| 塔 | 板块 skill | 形态 | 会话 ID / 链接 | 状态 |", "|---|---|---|---|---|",
    "| plan | `tower-plan` | 云 | `session_PLAN0000000000000001` | 常驻 |",
    `| dev | \`tower-dev\` | 云 | \`session_DEV00000000000000002\` | ${devStatus} |`,
    "| patrol | `tower-patrol` | 云 | `session_PATROL00000000000006` | 常驻 |"];
  const wrow = (q, board, task, status) =>
    `| ${q} | ${board} | ${task} | \`session_WORKER00000000000005\` | \`claude/${q.toLowerCase()}\` | 2026-01-01 09:00 | ${status} |`;
  const poolOf = (rows, devStatus) => [...towerRows(devStatus), "",
    "| 单号 | 派发塔 | 任务 | 工人会话 | 分支 | 起跑 | 状态 |", "|---|---|---|---|---|---|---|", ...rows, ""].join("\n");
  const TASKS = [
    wrow("Q301", "dev", "夹具活甲", "在跑 · 回查 10:00"),
    wrow("Q302", "dev", "夹具活乙", "待收"),
    wrow("Q300", "dev", "夹具活旧", "收工 · 收完没删行"),
    wrow("Q201", "product", "别塔的活", "在跑")];
  const SKILL_DEV = "---\nname: tower-dev\ndescription: 夹具 FRONTMATTER-SENTINEL\n---\n\n# 夹具 dev 板块\n\n" +
    "## 边界\n\nSKILL-BODY-SENTINEL\n\n最后一行 SKILL-END-SENTINEL\n";
  const SKILL_PATROL = "---\nname: tower-patrol\ndescription: 夹具\n---\n\n# 夹具巡检板块\n\nPATROL-BODY-SENTINEL\n";
  const TOWER_MD = "# 塔协议\n\n## 形态\n\nSHAPE-SENTINEL\n\n## 六条协议\n\n1. **落盘即关** PROTO-SENTINEL\n\n" +
    "### 小节算这一节的\n\nPROTO-SUB-SENTINEL\n\n## 平台事实\n\nFACTS-SENTINEL\n";
  // 当前那版在第 5 行;前面两行一个是别的词里带 dev(devops),一个是「上一版」—— 认错哪个,行号就不是 5
  const BACKLOG = ["# BACKLOG", "", "### devops 塔 · 接手须知 DEVOPS-NOTE-SENTINEL",
    "### (上一版)dev 塔 · 接手须知 OLD-NOTE-SENTINEL", "### dev 塔 · 接手须知 CURRENT-NOTE-SENTINEL", ""].join("\n");
  const cardBox = ({ pool = poolOf(TASKS), skills = { dev: SKILL_DEV, patrol: SKILL_PATROL }, towerMd = TOWER_MD, dir = sandbox() } = {}) => {
    writeFileSync(join(dir, "docs/session-pool.md"), pool);
    writeFileSync(join(dir, "docs/BACKLOG.md"), BACKLOG);
    for (const [b, t] of Object.entries(skills)) {
      mkdirSync(join(dir, `.claude/skills/tower-${b}`), { recursive: true });
      writeFileSync(join(dir, `.claude/skills/tower-${b}/SKILL.md`), t);
    }
    if (towerMd !== null) {
      mkdirSync(join(dir, ".claude/skills/tower-meta/references"), { recursive: true });
      writeFileSync(join(dir, ".claude/skills/tower-meta/references/tower.md"), towerMd);
    }
    return dir;
  };
  const card = (dir, sid, source = "compact") =>
    runIn(dir, "tower-card.mjs", { session_id: "tc", source }, { CLAUDE_CODE_REMOTE_SESSION_ID: sid });

  const d = cardBox();
  const r = card(d, ID.dev);
  const c = r.out, L = c.trimEnd().split("\n");
  assert("塔卡:dev 塔出卡、退出 0", r.code === 0 && c.length > 0, `code=${r.code} ${r.err.slice(0, 120)}`);
  assert("塔卡:第一行点名 dev 塔、说「刚压缩过」", L[0].includes("塔卡 · dev 塔") && L[0].includes("刚压缩过"), L[0]);
  assert("塔卡:念身份 + dev 的本分(讨论 → 定 → 派工人 → 收活)",
    (L[1] ?? "").startsWith("★ 你是 **dev 塔**(常驻)。塔 = 讨论 → 定 → 派工人 → 收活。"), L[1]);
  assert("塔卡:第三行是压缩后的提醒(摘要让你直接接着干 → 成品活写任务书派工人)",
    (L[2] ?? "").includes("直接接着干") && L[2].includes("写任务书派工人"), L[2]);
  assert("塔卡:贴了本塔 SKILL.md 正文,从头到尾", c.includes("SKILL-BODY-SENTINEL") && c.includes("SKILL-END-SENTINEL"));
  assert("塔卡:去掉 SKILL.md 的 frontmatter", !c.includes("FRONTMATTER-SENTINEL"), L.slice(0, 6).join(" / "));
  assert("塔卡:点名技能文件路径", c.includes(".claude/skills/tower-dev/SKILL.md"));
  assert("塔卡:贴了 tower.md「六条协议」整节(含小节)", c.includes("PROTO-SENTINEL") && c.includes("PROTO-SUB-SENTINEL"));
  assert("塔卡:tower.md 别的节不贴", !c.includes("SHAPE-SENTINEL") && !c.includes("FACTS-SENTINEL"));
  assert("塔卡:带活表里本塔那一行的状态", c.includes("TOWER-STATUS-SENTINEL"));
  assert("塔卡:列本塔在跑的工人(Q301、Q302 两个,带任务和状态)",
    c.includes("在跑的工人 2 个") && c.includes("· Q301 · 夹具活甲 · ") && c.includes("在跑 · 回查 10:00") && c.includes("· Q302 · 夹具活乙 · "),
    L.filter((l) => /工人|· Q/.test(l)).join(" / "));
  assert("塔卡:不列别的塔派的工人", !c.includes("Q201") && !c.includes("别塔的活"));
  assert("塔卡:写着「收工」的只报单号、不列细节", c.includes("1 行写着「收工」(Q300)") && !c.includes("夹具活旧"));
  assert("塔卡:接手须知给当前那版的行号(不拿「上一版」、不认别的词里带 dev 的)",
    c.includes("第 5 行") && c.includes("CURRENT-NOTE-SENTINEL") && !c.includes("OLD-NOTE-SENTINEL") && !c.includes("DEVOPS-NOTE-SENTINEL"),
    L.find((l) => /接手须知/.test(l)));
  assert("塔卡:末行是「塔卡完」(转录里看得到它 = 整张进去了)", L.at(-1) === END, L.at(-1));
  assert("塔卡:平常的卡 < 10000 字", c.length < CAP, String(c.length));
  const s0 = card(d, ID.dev, "startup").out.split("\n")[0];
  assert("塔卡:开局 → 第一行说「开局」、不说「刚压缩过」", s0.includes("开局") && !s0.includes("刚压缩过"), s0);
  const s1 = card(d, ID.dev, "resume").out.split("\n")[0];
  assert("塔卡:恢复 → 第一行说「会话恢复」", s1.includes("会话恢复"), s1);
  {
    const g = spawnSync(process.execPath, [join(HOOKS, "tower-card.mjs")], { cwd: d, input: "not json", encoding: "utf8",
      env: { ...process.env, CLAUDE_HOOK_TEST: "1", CLAUDE_CODE_REMOTE_SESSION_ID: ID.dev } });
    assert("塔卡:stdin 不是 JSON → 照出卡(按开局说)",
      g.status === 0 && (g.stdout.split("\n")[0] ?? "").includes("开局") && g.stdout.trimEnd().endsWith(END), (g.stdout ?? "").slice(0, 120));
  }

  // 本分按塔念(红绿成对):巡检塔不派工人,它的卡念「派工人 → 收活」会把它带歪。变异:dutyOf 恒给 default → 这几条红。
  const p = card(d, ID.patrol).out, P = p.split("\n");
  assert("塔卡:巡检塔念巡检的本分(跑 → 报用户 → 派回 → 回查,不派工人)",
    (P[1] ?? "").startsWith("★ 你是 **patrol 塔**(常驻)。巡检塔 = 跑 → 报用户") && P[1].includes("不派工人"), P[1]);
  assert("塔卡:巡检塔的卡里没有「派工人 → 收活」", !p.includes("派工人 → 收活"), P.slice(0, 3).join(" / "));
  assert("塔卡:巡检塔压缩后的提醒说接着跑例程、别顺手替别的塔改",
    (P[2] ?? "").includes("例程") && P[2].includes("别顺手替"), P[2]);
  assert("塔卡:巡检塔贴的是自己的 SKILL.md", p.includes("PATROL-BODY-SENTINEL") && !p.includes("SKILL-BODY-SENTINEL"));

  for (const [label, sid] of [["工人(只在任务会话表里)", ID.worker], ["活表里没有的会话 ID", "cse_NOTREAL00000000000"],
    ["没有会话 ID(本机 CLI)", ""]]) {
    const x = card(d, sid);
    assert(`塔卡:${label} → 不出卡`, x.code === 0 && x.out.trim() === "", `code=${x.code} ${x.out.slice(0, 80)}`);
  }
  const m = card(d, ID.plan);
  assert("塔卡:SKILL.md 读不到 → 不崩、卡照出、叫它自己去读(fail-open)",
    m.code === 0 && m.out.includes("你是 **plan 塔**") && m.out.includes("读不到 .claude/skills/tower-plan/SKILL.md") &&
    m.out.trimEnd().endsWith(END), `code=${m.code} ${m.out.slice(0, 160)}`);
  const nt = card(cardBox({ towerMd: null }), ID.dev).out;
  assert("塔卡:tower.md 读不到 → 不贴协议节、技能照贴、卡照出",
    !nt.includes("六条协议") && nt.includes("SKILL-END-SENTINEL") && nt.trimEnd().endsWith(END), nt.slice(0, 160));

  // 状态格写成长篇(装了框架的项目真事:几行工人的状态把卡撑到一万多字,技能一个字都没进)。
  // 变异:不截状态格 → 「整张卡 < 10000」「状态截短」「在跑那个照列细节」至少一条红。
  {
    const long = "回查 " + "#1 自述还在改、没开分支 · ".repeat(900) + "STATUS-TAIL-SENTINEL";
    const rows = [1, 2, 3, 4, 5, 6].map((i) => wrow(`Q31${i}`, "dev", "夹具长活", `收工 · ${long}`))
      .concat(wrow("Q320", "dev", "夹具在跑", `在跑 · ${long}`));
    const x = card(cardBox({ pool: poolOf(rows, `常驻 · ${long}`) }), ID.dev).out;
    assert("塔卡:状态格写成长篇 → 整张卡仍 < 10000 字", x.length < CAP, String(x.length));
    assert("塔卡:状态格写成长篇 → SKILL.md 正文仍整份在", x.includes("SKILL-BODY-SENTINEL") && x.includes("SKILL-END-SENTINEL"));
    assert("塔卡:状态格写成长篇 → 状态只贴开头(本塔那行和工人那行都截短)",
      !x.includes("STATUS-TAIL-SENTINEL") && x.includes("常驻 · 回查 #1"), String(x.length));
    assert("塔卡:状态格写成长篇 → 在跑的那个照列细节", x.includes("· Q320 · 夹具在跑 · ") && x.includes("在跑 · 回查 #1"),
      x.split("\n").filter((l) => /Q320/.test(l)).join(" / ").slice(0, 200));
    assert("塔卡:状态格写成长篇 → 收工的 6 行只报单号", x.includes("6 行写着「收工」") && !x.includes("· Q311 ·"));
  }
  // SKILL.md 自己就超长:截尾巴、注明还差多少字去读原文件;身份、手上的工人、末行都还在。变异:不封顶 → 第一条红。
  {
    const big = "---\nname: tower-dev\ndescription: x\n---\n\n# 大技能 BIG-HEAD-SENTINEL\n" + "甲".repeat(20000) + "\nBIG-TAIL-SENTINEL\n";
    const x = card(cardBox({ skills: { dev: big } }), ID.dev).out;
    assert("塔卡:SKILL.md 超长 → 整张卡仍 < 10000 字", x.length < CAP, String(x.length));
    assert("塔卡:SKILL.md 超长 → 从头贴、注明后面还差多少字、去读原文件",
      x.includes("BIG-HEAD-SENTINEL") && !x.includes("BIG-TAIL-SENTINEL") && /后面还有 \d+ 字没贴,读 \.claude\/skills\/tower-dev\/SKILL\.md/.test(x));
    assert("塔卡:SKILL.md 超长 → 身份、在跑的工人、末行「塔卡完」都还在",
      x.includes("你是 **dev 塔**") && x.includes("在跑的工人 2 个:Q301 · Q302") && x.trimEnd().endsWith(END));
  }
  // 技能全文优先:技能 7000 字 + 10 个工人每格写满 + 协议整节 2000 字,一起放不下。
  // 让位的顺序:协议整节 → 一行指路;工人细节行一行行让;技能一个字不截。变异:细节行不让位 / 协议排在技能前 → 第一条红。
  {
    const mid = "---\nname: tower-dev\ndescription: x\n---\n\n# 中号技能\n" + "乙".repeat(7000) + "\nMID-TAIL-SENTINEL\n";
    const full = "满".repeat(200);
    const rows = Array.from({ length: 10 }, (_, i) => wrow(`Q33${i}`, "dev", full, `在跑 · ${full}`));
    const tm = "# 塔协议\n\n## 六条协议\n\nPROTO-SENTINEL " + "丙".repeat(2000) + "\n\n## 平台事实\n\nx\n";
    const x = card(cardBox({ skills: { dev: mid }, pool: poolOf(rows), towerMd: tm }), ID.dev).out;
    assert("塔卡:技能全文优先 —— 技能 7000 字 + 10 个工人写满,技能尾巴还在", x.includes("MID-TAIL-SENTINEL"), String(x.length));
    assert("塔卡:技能全文优先 —— 卡仍 < 10000 字", x.length < CAP, String(x.length));
    assert("塔卡:技能全文优先 —— 细节行让位,但 10 个单号一个不落、放得下的细节照列",
      x.includes("在跑的工人 10 个:") && Array.from({ length: 10 }, (_, i) => `Q33${i}`).every((q) => x.includes(q)) &&
      x.includes("· Q330 · 满") && /还有 \d+ 个的细节见活表/.test(x), x.split("\n").filter((l) => /工人|Q33/.test(l)).map((l) => l.slice(0, 40)).join(" / "));
    assert("塔卡:技能全文优先 —— 协议整节让位,只留一行指路", !x.includes("PROTO-SENTINEL") && /六条协议.*放不下|放不下.*六条协议/.test(x));
  }
  // 活表读 origin/main(台账走 main);工作树里没推上去的那份不算。没有 git 的沙箱退回工作树(上面那些用例走的就是这条)。
  {
    const g = gitSandbox();
    cardBox({ dir: g, pool: poolOf([wrow("Q303", "dev", "main 上的活", "在跑")]) });
    commitAll(g, "活表");
    gitq(g, "push", "-q", "origin", "main");
    writeFileSync(join(g, "docs/session-pool.md"), poolOf([wrow("Q309", "dev", "没推的活", "在跑")]));
    const x = card(g, ID.dev).out;
    assert("塔卡:活表读 origin/main 上的那份,不读工作树里没推上去的", x.includes("Q303") && !x.includes("Q309"),
      x.split("\n").filter((l) => /工人|· Q/.test(l)).join(" / "));
  }

  // now.mjs:每轮在时刻后面念一句身份,工人 / 认不出的不念
  const ctx = (sid) => {
    const x = runIn(d, "now.mjs", {}, { CLAUDE_CODE_REMOTE_SESSION_ID: sid });
    try { return String(JSON.parse(x.out).hookSpecificOutput?.additionalContext ?? ""); } catch { return `(不是合法 JSON:${x.out.slice(0, 80)})`; }
  };
  const dv = ctx(ID.dev);
  assert("now.mjs:dev 塔每轮念身份 + 本分",
    dv.includes("\n【你是 dev 塔(常驻)】讨论 → 定 → 派工人 → 收活;成品活写任务书派工人,别在塔里干。"), dv);
  assert("now.mjs:塔的时刻行照旧打头", dv.startsWith("【本轮真实时刻】") && STAMP_SHAPE.test(dv.split("\n")[0]), dv.split("\n")[0]);
  const pt = ctx(ID.patrol);
  assert("now.mjs:巡检塔念巡检的本分(派回、不派工人)",
    pt.includes("\n【你是 patrol 塔(常驻)】") && pt.includes("派回") && pt.includes("不派工人"), pt);
  assert("now.mjs:巡检塔不念「派工人 → 收活」", !pt.includes("派工人 → 收活"), pt);
  for (const [label, sid] of [["工人", ID.worker], ["没有会话 ID", ""], ["活表里没有的会话 ID", "cse_NOTREAL00000000000"]]) {
    const x = ctx(sid);
    assert(`now.mjs:${label} → 不念身份,只有时刻`, !x.includes("【你是") && x.startsWith("【本轮真实时刻】"), x);
  }

  // 接线:SessionStart 不带 matcher = 开局 / 压缩 / 恢复 / clear 都跑。带了 matcher(比如只写 startup),压缩后就不贴了。
  let ss = [];
  try { ss = JSON.parse(readFileSync(".claude/settings.json", "utf8")).hooks.SessionStart ?? []; } catch {}
  const tc = ss.filter((e) => (e.hooks ?? []).some((h) => h.command === "node .claude/hooks/tower-card.mjs"));
  assert("settings:SessionStart 挂了塔卡,而且不带 matcher(开局 / 压缩 / 恢复 / clear 都贴)",
    tc.length === 1 && !tc[0].matcher, JSON.stringify(ss));
}

// ── 闸门17 派工刹车 · 闸门14 记账豁免 · scripts/brake.mjs(规矩见 dispatch.md「刹车」)─────────────
// 沙箱里建带 origin 的仓库,造 squash 和普通合并两种合进提交,提交时刻钉死,期望值写死在这儿。
// 全角字用码位拼(FW):源码里看不出全角半角。
{
  const { pathToFileURL } = await import("node:url");
  const bk = await import(pathToFileURL(resolve(".claude/hooks/lib/brake.mjs")).href);
  const FW = (...c) => String.fromCharCode(...c);
  const L = FW(0x3014), R = FW(0x3015);                 // 〔 〕
  const BATCH = L + "攒批" + R, USER = L + "待用户" + R;
  const at = (dir, when, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  const BACKLOG = [
    "# BACKLOG", "", "## 三、收件箱", "",
    `- 2031-01-10 08:00 · test → dev ${BATCH} · 列表页按钮颜色偏浅`,
    `- 2031-01-10 09:30 · test → **dev** · ${FW(0x3010)}攒批${FW(0x3011)} · 详情页标题少一个空格`,
    `  ${L}已修 Q399${R}`,
    `- 2031-01-10 10:00 · test → dev ${BATCH} · 日期格式不统一`,
    `  ${L}dev 收到 · 不修:按规格就是这样${R}`,
    `- ~~2031-01-10 11:00 · test → dev ${BATCH} · 已作废的一条~~`,
    "- 2031-01-10 12:00 · test → dev [攒批] · 搜索框占位字太长",
    `  ~~${L}已修 Q398${R}~~`,
    `- 2031-01-10 13:00 · test → product ${BATCH} · 文案问题`,
    "- 2031-01-10 14:00 · test → dev · 页面报错(阻塞)", ""].join("\n");
  const JOURNAL = ["# journal", "",
    "- 2031-01-11 09:00 · dev · 用户 2031-01-11 08:50 原话「第四轮可以做,做完停」",
    `- 2031-01-11 09:10 · dev · 用户 2031-01-11 09:05 原话「再做一轮${FW(0xFF1A)}修好 API」`, ""].join("\n");
  // [时刻, 标题] —— 标题以 (#n) 结尾的是 squash;"merge:" 开头的造一个普通合并提交(正文第一行 = PR 标题)
  const MERGES = [
    ["2030-12-01T10:00:00Z", "Q304 · a (#1)"], ["2030-12-01T11:00:00Z", "Q304b · a (#2)"],
    ["2030-12-01T12:00:00Z", "Q304c · a (#3)"], ["2030-12-01T13:00:00Z", "Q304d · a (#4)"],
    ["2031-01-09T10:00:00Z", "Q36 · b (#5)"], ["2031-01-09T10:10:00Z", "Q36b · b (#6)"], ["2031-01-09T10:20:00Z", "Q36c · b (#7)"],
    ["2031-01-09T11:00:00Z", "Q3610 · c (#8)"], ["2031-01-09T11:10:00Z", "Q3610b · c (#9)"], ["2031-01-09T11:20:00Z", "Q3610c · c (#10)"],
    ["2031-01-10T07:00:00Z", "Q301 · 第一轮 (#11)"],
    ["2031-01-10T08:00:00Z", "dev Q301b: 第二轮 (#12)"],          // 号不在开头也认
    ["2031-01-10T09:00:00Z", "merge:13:Q301c · 第三轮"],          // 普通合并
    ["2031-01-10T09:30:00Z", "Q301 收尾 (#20) 补丁"],              // (#n) 不在结尾 → 不算交付
    ["2031-01-10T09:40:00Z", "Q301 · 再补一笔 (#21)"],             // 同一个号再合 → 不加轮
    ["2031-01-10T10:00:00Z", "Q302 · x (#14)"], ["2031-01-10T11:00:00Z", "Q302b · x (#15)"],
    ["2031-01-10T17:00:00Z", "Q303 · y (#16)"], ["2031-01-10T18:00:00Z", "Q303b · y (#17)"],
    ["2031-01-10T19:00:00Z", "Q303c · y (#18)"], ["2031-01-10T20:00:00Z", "Q303d · y (#19)"],
  ];
  const repo = gitSandbox();
  writeFileSync(join(repo, "docs/BACKLOG.md"), BACKLOG);
  writeFileSync(join(repo, "docs/journal.md"), JOURNAL);
  gitq(repo, "add", "docs"); at(repo, "2030-11-30T00:00:00Z", "commit", "-qm", "init");
  for (const [when, title] of MERGES) {
    const m = title.match(/^merge:(\d+):(.*)$/);
    if (!m) { at(repo, when, "commit", "--allow-empty", "-qm", title); continue; }
    gitq(repo, "checkout", "-qb", "feat");
    at(repo, when, "commit", "--allow-empty", "-qm", "分支上的一笔 Q399 (#99)");   // 分支自己的提交:--first-parent 不看
    gitq(repo, "checkout", "-q", "main");
    at(repo, when, "merge", "--no-ff", "-q", "feat", "-m", `Merge pull request #${m[1]} from o/feat`, "-m", m[2]);
    gitq(repo, "branch", "-qD", "feat");
  }
  gitq(repo, "push", "-q", "origin", "main");
  const POOL_DEV = "| dev | `tower-dev` | 云 | `session_DEVTOWER0000000001` | 在跑 |\n";
  writeFileSync(join(repo, "docs/session-pool.md"), POOL_DEV);   // 工作树里摆活表(whoAmI 读工作树),不进 origin/main
  let n = 0;
  const go = (prompt, { dir = repo, title = "", env = {}, sid = `bk${++n}` } = {}) => {
    seed0(dir, sid, "dispatch-reminded\n");
    const r = runIn(dir, "guard-mcp.mjs", { session_id: sid, tool_name: "mcp__Claude_Code_Remote__create_session",
      tool_input: { ...SRC, title, prompt } }, { CLAUDE_CODE_REMOTE_SESSION_ID: "", ...env });
    return { ...r, sid, dir, again: () => runIn(dir, "guard-mcp.mjs", { session_id: sid, tool_name: "mcp__Claude_Code_Remote__create_session",
      tool_input: { ...SRC, title, prompt } }, { CLAUDE_CODE_REMOTE_SESSION_ID: "", ...env }) };
  };
  const tb = (q, rest = "") => `# ${q} · 某件活\n\n板块=dev 任务=${q}\n${rest}`;

  // (a) 轮次
  let r = go(tb("Q302c"));
  assert("闸17 绿:Q302 家已合 2 个号,派 Q302c 是第 3 轮 → 放行", allowed(r), r.err.slice(0, 160));
  r = go(tb("Q301d"));
  assert("闸17 红:Q301 家已合 3 个号(squash 两种标题 + 普通合并),派 Q301d 是第 4 轮 → 拦", denied(r) && /第 4 轮/.test(r.err) && /上限 3/.test(r.err), r.err.slice(0, 200));
  assert("闸17 红:提示列出已合的号 · PR 号 · 合进时刻(项目时区),按合进顺序",
    /Q301 · #11 · 2031-01-10 02:00\n\s*· Q301b · #12 · 2031-01-10 03:00\n\s*· Q301c · #13 · 2031-01-10 04:00\n/.test(r.err), r.err);
  assert("闸17 红:提示写了放行办法(点头行)和「不是返工」原样再来", /用户点头:「原话」/.test(r.err) && /不是返工/.test(r.err) && /brake\.mjs rounds Q301d/.test(r.err), r.err);
  assert("闸17 红:(#n) 不在结尾的、同一个号再合的,都不多算一轮", !/#20|#21/.test(r.err), r.err);
  assert("闸17 绿:同一家第二次放行(每家拦一次)", allowed(r.again()));
  assert("闸17 记旗标 brake-rounds:Q301", flagsIn(repo, r.sid).split("\n").includes("brake-rounds:Q301"), flagsIn(repo, r.sid));
  r = go(tb("Q301c"));
  assert("闸17 绿:再派已合过的号 Q301c,不算新的一轮(第 3 轮)→ 放行", allowed(r), r.err.slice(0, 160));
  r = go("任务书没有标题行", { title: "Q301d · 从 title 取号" });
  assert("闸17 红:任务书没有 `# ` 行 → 用 title 取号", denied(r) && /第 4 轮/.test(r.err), r.err.slice(0, 160));

  // 返工自并家
  r = go(tb("Q305"));
  assert("闸17 绿:新号 Q305(家里一个都没合)→ 放行", allowed(r), r.err.slice(0, 160));
  r = go(tb("Q305", "返工自 Q301(上一轮没修完)\n"));
  assert("闸17 红:任务书写「返工自 Q301」→ 并进 Q301 家,第 4 轮 → 拦", denied(r) && /Q305 \+ Q301/.test(r.err) && /第 4 轮/.test(r.err), r.err.slice(0, 200));

  // 号边界
  r = go(tb("Q361"));
  assert("闸17 绿:Q36、Q3610 两家各合 3 个号,派 Q361 不算进任何一家 → 第 1 轮放行", allowed(r), r.err.slice(0, 160));
  r = go(tb("Q36d"));
  assert("闸17 红:派 Q36d → Q36 家第 4 轮(证明 Q36 那三笔认得出)", denied(r) && /第 4 轮/.test(r.err) && !/Q3610/.test(r.err), r.err.slice(0, 200));
  r = go(tb("Q3610d"));
  assert("闸17 红:派 Q3610d → Q3610 家第 4 轮,不混进 Q36", denied(r) && /第 4 轮/.test(r.err) && !/Q36 ·/.test(r.err), r.err.slice(0, 200));
  assert("刹车 lib:号边界 —— Q36 / Q361 / Q3610 各是各的基号;Q361c-2 ≠ Q361c-20;后面紧挨字母或 `-` 的不算号",
    JSON.stringify(bk.qNos("Q36 Q361 Q3610 Q361c-2 Q361c-20 xQ5 Q7X Q8- Q9c-").map((q) => q.no)) === JSON.stringify(["Q36", "Q361", "Q3610", "Q361c-2", "Q361c-20"]) &&
    bk.baseOf("Q361c-20") === "Q361",
    JSON.stringify(bk.qNos("Q36 Q361 Q3610 Q361c-2 Q361c-20 xQ5 Q7X Q8- Q9c-")));
  {
    const dels = [{ q: "Q361c-20", base: "Q361" }];
    assert("刹车 lib:Q361c-20 合过,再派 Q361c-2 是新号(第 2 轮);再派 Q361c-20 不加轮(第 1 轮)",
      bk.familyRounds("Q361c-2", [], dels).round === 2 && bk.familyRounds("Q361c-20", [], dels).round === 1);
  }

  // 派工塔号段优先
  const DEV_ENV = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_DEVTOWER0000000001" };
  r = go("# 修 Q201 提的那条 · Q301d\n", { env: DEV_ENV });
  assert("闸17 红:dev 塔(活表认出)派工,标题里先出现 Q201 —— 取本塔号段 Q3xx 的 Q301d → 第 4 轮拦", denied(r) && /Q301d/.test(r.err), r.err.slice(0, 160));
  r = go("# 修 Q201 提的那条 · Q301d\n");
  assert("闸17 绿:同一标题,认不出塔 → 取第一个号 Q201(第 1 轮)放行", allowed(r), r.err.slice(0, 160));
  assert("刹车 lib:号段首位从 ranges 读(Q3xx → 3);四位号也认本段;没配的板块 → null",
    bk.rangeDigit("dev", { dev: "Q3xx" }) === "3" && bk.rangeDigit("patrol", { dev: "Q3xx" }) === null &&
    bk.firstQ("Q201 Q3001", "3")?.no === "Q3001" && bk.firstQ("Q201 Q31", "3")?.no === "Q201");

  // 点头行
  r = go(tb("Q301d", "用户点头:「第四轮可以做,做完停」(2031-01-11 08:50,dev 塔)\n"));
  assert("闸17 绿:点头行的原话在 origin/main 的 journal 里查得到 → 放行", allowed(r), r.err.slice(0, 200));
  r = go(tb("Q301d", `- **用户点头${FW(0xFF1A)}**「再做一轮:修好API」(2031-01-11 09:05,dev 塔)\n`));
  assert("闸17 绿:点头行带列表记号 / 加粗 / 全角冒号,原话排版变体(半角冒号、英文前没空格)也认", allowed(r), r.err.slice(0, 200));
  r = go(tb("Q301d", "用户点头:「随便做吧我不管了」(2031-01-11 10:00,dev 塔)\n"));
  assert("闸17 红:点头行有,但原话台账里没有 → 照拦,写明「台账里没找到这句」",
    denied(r) && /台账里没找到这句/.test(r.err) && /随便做吧我不管了/.test(r.err), r.err.slice(0, 300));
  r = go(tb("Q301d", "上次说的用户点头:「第四轮可以做,做完停」\n"));
  assert("闸17 红:「用户点头」不在行首(只是引用)→ 不算点头行", denied(r) && !/台账里没找到/.test(r.err), r.err.slice(0, 200));

  // 配置
  withCfg(repo, { brakeRounds: 0 });
  r = go(tb("Q301d"));
  assert("闸17 绿:brakeRounds = 0 → 关掉轮次封顶,第 4 轮也放行", allowed(r), r.err.slice(0, 160));
  withCfg(repo, { brakeRounds: 2 });
  r = go(tb("Q302c"));
  assert("闸17 红:brakeRounds = 2 → Q302c 第 3 轮就拦(上限从配置读)", denied(r) && /上限 2/.test(r.err), r.err.slice(0, 160));
  withCfg(repo, { brakeRounds: -1 });
  r = go(tb("Q301d"));
  assert("闸17 红:brakeRounds 写坏了(-1)→ 用默认 3,第 4 轮拦", denied(r) && /上限 3/.test(r.err), r.err.slice(0, 160));
  rmSync(join(repo, ".claude/belltower.json"), { force: true });

  // 没有 origin/main
  {
    const bare = gitSandbox();
    writeFileSync(join(bare, "docs/journal.md"), "x\n");
    gitq(bare, "add", "docs"); gitq(bare, "commit", "-qm", "Q301d · x (#1)");
    r = go(tb("Q301d"), { dir: bare });
    assert("闸17 绿:没有 origin/main(没推过)→ 放行(fail-open)", allowed(r), r.err.slice(0, 160));
    r = go(tb("Q301d"), { dir: sandbox() });
    assert("闸17 绿:不是 git 仓库 → 放行(fail-open)", allowed(r), r.err.slice(0, 160));
  }

  // (b) 〔待用户〕
  r = go(tb("Q310", `- 列表默认按时间倒序 ${USER}\n`));
  assert("闸17 红:任务书带〔待用户〕→ 拦", denied(r) && /待用户/.test(r.err) && /用户点头:「原话」/.test(r.err), r.err.slice(0, 200));
  assert("闸17 绿:〔待用户〕只拦一次", allowed(r.again()));
  assert("闸17 记旗标 brake-pending-user", flagsIn(repo, r.sid).split("\n").includes("brake-pending-user"));
  r = go(tb("Q310", `- 列表默认按时间倒序 ${USER}\n用户点头:「第四轮可以做,做完停」(2031-01-11 08:50,dev 塔)\n`));
  assert("闸17 绿:〔待用户〕+ 查得到的点头行 → 放行", allowed(r), r.err.slice(0, 200));
  r = go(tb("Q310", `- 列表默认按时间倒序 ${USER}\n用户点头:「台账里根本没有这句」(2031-01-11 08:50,dev 塔)\n`));
  assert("闸17 红:〔待用户〕+ 查不到的点头行 → 拦,写明「台账里没找到」", denied(r) && /台账里没找到这句/.test(r.err), r.err.slice(0, 200));
  for (const [name, mark] of [["【】", FW(0x3010) + "待用户" + FW(0x3011)], ["［ ］带空白", FW(0xFF3B) + " 待用户 " + FW(0xFF3D)], ["半角 []", "[待用户]"]]) {
    r = go(tb("Q310", `- 某条 ${mark}\n`));
    assert(`闸17 红:〔待用户〕括号变体 ${name} 也认`, denied(r) && /待用户/.test(r.err), r.err.slice(0, 120));
  }
  r = go(tb("Q310", "- 某条 [推断] 待用户确认\n"));
  assert("闸17 绿:没带括号记号(只是「待用户」三个字)→ 不拦", allowed(r), r.err.slice(0, 120));

  // 闸门14 记账:带〔攒批〕/〔待用户〕的留言不记 relay
  {
    const INBOX = "## 三、收件箱\n\n- 2031-01-05 10:00 · dev → **test** · 旧的一条\n";
    const rel = (sid, add) => {
      const d = sandbox();
      const x = runIn(d, "guard-edit.mjs", { session_id: sid, tool_name: "Edit",
        tool_input: { file_path: "docs/BACKLOG.md", old_string: INBOX, new_string: INBOX + add } }, { CLAUDE_CODE_REMOTE_SESSION_ID: "" });
      return { ...x, relays: flagsIn(d, sid).split("\n").filter((l) => l.startsWith("relay:")) };
    };
    let e = rel("bz1", `- 2031-01-06 10:00 · test → dev ${BATCH} · 按钮颜色偏浅\n`);
    assert("闸14 记:带〔攒批〕的留言(记号在目标后)→ 不记 relay", allowed(e) && e.relays.length === 0, e.relays.join(" | "));
    e = rel("bz2", `- 2031-01-06 10:00 · product → dev · ${USER} · 列表默认排序改了\n`);
    assert("闸14 记:带〔待用户〕的留言(记号在 ` · ` 后)→ 不记 relay", e.relays.length === 0, e.relays.join(" | "));
    e = rel("bz3", `- 2031-01-06 10:00 · test → dev · ${FW(0x3010)} 攒批 ${FW(0x3011)} · x\n`);
    assert("闸14 记:括号变体【 攒批 】也认 → 不记", e.relays.length === 0, e.relays.join(" | "));
    e = rel("bz4", "- 2031-01-06 10:00 · test → dev · 页面报错,主流程走不通\n");
    assert("闸14 记:不带记号的同样一行 → 照记 relay:dev", e.relays.length === 1 && /^relay:dev:\d+$/.test(e.relays[0]), e.relays.join(" | "));
    e = rel("bz5", `- 2031-01-06 10:00 · test → dev ${BATCH} · 轻的\n- 2031-01-06 10:01 · test → dev · 阻塞的\n`);
    assert("闸14 记:一笔里一条带记号一条不带 → 只记一条", e.relays.length === 1, e.relays.join(" | "));
  }

  // scripts/brake.mjs
  const BRAKE = resolve("scripts/brake.mjs");
  const cli = (args, dir = repo) => {
    const x = spawnSync(process.execPath, [BRAKE, ...args], { cwd: dir, encoding: "utf8" });
    return { code: x.status, out: x.stdout ?? "", err: x.stderr ?? "" };
  };
  let c = cli(["rounds", "Q301d"]);
  assert("brake rounds Q301d:列已合号 · PR · 合进时刻,报第 4 轮、超过要点头",
    c.code === 0 && c.out.startsWith("Q301 · #11 · 合进 2031-01-10 02:00\nQ301b · #12 · 合进 2031-01-10 03:00\nQ301c · #13 · 合进 2031-01-10 04:00\n") &&
    /— Q301 这一家已合 3 个号 · 再派 Q301d 是第 4 轮,上限 3,超过要用户点头/.test(c.out), c.out + c.err);
  c = cli(["rounds", "Q302c"]);
  assert("brake rounds Q302c:第 3 轮,不提点头", c.code === 0 && /再派 Q302c 是第 3 轮,上限 3 ·/.test(c.out) && !/点头/.test(c.out), c.out);
  c = cli(["rounds", "Q305", "Q301", "--json"]);
  let j = null; try { j = JSON.parse(c.out); } catch {}
  assert("brake rounds Q305 Q301 --json:几个号并成一家,next_round 4、needs_nod",
    c.code === 0 && j && j.family.join() === "Q305,Q301" && j.next_round === 4 && j.needs_nod === true && j.merged.length === 3, c.out + c.err);
  assert("brake rounds:参数错(不是 Q 号 / 没给号)→ 退出 2", cli(["rounds", "abc"]).code === 2 && cli(["rounds"]).code === 2 && cli(["nope"]).code === 2);
  assert("brake rounds:读不到 ref → 退出 2", cli(["rounds", "Q301", "--ref", "origin/nope"]).code === 2);
  const NOW = ["--now", "2031-01-11T00:00:00Z"];   // 美东 2031-01-10 19:00
  c = cli(["batch", ...NOW]);
  const lines = c.out.trim().split("\n");
  assert("brake batch:列开着的〔攒批〕—— 已修 / 不修 / 头一行被划掉的不列,收口被划掉的照列;发给谁都列、标出目标",
    c.code === 0 && lines.length === 4 &&
    lines[0] === "2031-01-10 08:00 · test → dev · 列表页按钮颜色偏浅 · 开了 11 小时" &&
    lines[1] === "2031-01-10 12:00 · test → dev · 搜索框占位字太长 · 开了 7 小时" &&
    lines[2] === "2031-01-10 13:00 · test → product · 文案问题 · 开了 6 小时" &&
    lines[3].startsWith("— 开着的〔攒批〕3 条 · 其中发给 dev 的 2 条"), c.out + c.err);
  c = cli(["batch", "--older", "10", "--json", ...NOW]);
  j = null; try { j = JSON.parse(c.out); } catch {}
  assert("brake batch --older 10 --json:只剩开了 11 小时那条", c.code === 0 && j && j.length === 1 && j[0].hours === 11 && j[0].dsts.join() === "dev", c.out + c.err);
  c = cli(["over", ...NOW]);
  assert("brake over:过去 24 小时合进、让一家超过上限的 —— 只有 Q303d(Q304d 太早)",
    c.code === 0 && c.out.startsWith("Q303d · #19 · 合进 2031-01-10 15:00 · Q303 这一家第 4 轮(上限 3)\n— 过去 24 小时合进的交付里,超过上限的 1 笔"), c.out + c.err);
  c = cli(["over", "--hours", "2000", "--json", ...NOW]);
  j = null; try { j = JSON.parse(c.out); } catch {}
  assert("brake over --hours 2000:窗口放宽,Q304d 也进来", c.code === 0 && j && j.map((x) => x.q).join() === "Q304d,Q303d", c.out + c.err);
  assert("brake:不认识的参数 → 退出 2", cli(["batch", "--bogus"]).code === 2);
}

// ── 坏输入一律 fail-open ────────────────────────────────────────────────
for (const h of ["guard-bash.mjs", "guard-edit.mjs", "guard-stop.mjs"]) {
  const r = spawnSync(process.execPath, [join(HOOKS, h)],
    { input: "not json", encoding: "utf8", env: { ...process.env, CLAUDE_HOOK_TEST: "1" } });
  assert(`${h} 解析失败时放行`, r.status === 0, `code=${r.status}`);
}

for (const d of SANDBOXES) rmSync(d, { recursive: true, force: true });

// ── 报文与台账日期:不写死铁律编号、不用 UTC 日期 ───────────────────────
// 项目常在框架铁律前插自己的规矩,编号就对不上;gate-log 的日期要按项目时区(belltower.json 的 timezone)。
{
  const hooksDir = ".claude/hooks";   // 跟上面跑 hook 一样,以项目根为当前目录
  const files = ["guard-bash.mjs", "guard-edit.mjs", "guard-mcp.mjs", "guard-stop.mjs", "session-start.mjs", "lib/config.mjs",
    "lib/doorbell.mjs", "tower-card.mjs", "lib/tower-card.mjs", "lib/brake.mjs"];
  const code = (f) => readFileSync(join(hooksDir, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const numbered = files.filter((f) => /铁律\d/.test(code(f)));
  assert("闸门报文按规矩名引用铁律,不写编号", !numbered.length, numbered.join(", "));
  const utc = files.filter((f) => /toISOString\(\)\.slice\(0, ?10\)/.test(code(f)));
  assert("闸门写的日期走项目时区(不用 UTC 的 toISOString 截日期)", !utc.length, utc.join(", "));
}

// ── 全角 lint:本意「全角半角都认」的字符类,别写成两个相同的半角 ─────────────
// 模型常把全角敲成半角:任务书里写着「全角冒号」,字节却是半角,工人照抄,本意全角半角都认的字符类
// 就成了两个一样的半角 —— 全角那一半悄悄丢了,不报错也不红(装了框架的项目里一次丢过二十几处)。
// 工具参数里的「反斜杠 + u + 四位码」还会被解成字本身,写转义也保不住。所以:
//   任务书里的全角写码位名(U+FF1A);代码和夹具里用 String.fromCharCode(0xFF1A) 拼;这里按码位查。
// 判据(窄,零误伤):类体里只有标点 / 汉字 / 反斜杠转义(出现字母数字、空白、点、引号、$ 就不算类),
//   转义换成空格后有两个紧挨着的相同半角 : ; , ( ) 就算。别放宽:宽了会把 `[...new Set((x` 这种展开写法也算进去。
// 反例夹具在运行时拼,源码里不出现那个字面量(否则这一组扫到自己)。
{
  const { readdirSync } = await import("node:fs");
  const CLS = /\[\^?((?:\\.|[^\]\\\s\w.'"`$])+)\]/g;
  const DUP = /([:;,()])\1/;
  const dupHits = (text) => {
    const out = [];
    String(text).split("\n").forEach((l, i) => {
      for (const m of l.matchAll(CLS)) if (DUP.test(m[1].replace(/\\./g, " "))) out.push({ line: i + 1, cls: m[0] });
    });
    return out;
  };
  const colon = ":", lb = "[", rb = "]";
  const bad = "const R = /不落盘" + lb + colon + colon + rb + "/;\n";
  const good = "const R = /不落盘" + lb + colon + String.fromCharCode(0xFF1A) + rb + "/;\nconst a = [...new Set((x) => x)];\nconst b = /[\\s*`]/;\n";
  assert("全角 lint 夹具:两个相同半角的类命中;全角半角各一的类、`[...new Set((`、`[\\s*`]` 不命中",
    dupHits(bad).length === 1 && dupHits(good).length === 0, JSON.stringify([dupHits(bad), dupHits(good)]));
  // 扫 hook(含 lib/)和 scripts/ 下的 .mjs。按目录现列,不用 git ls-files —— 刚装好、还没提交的项目里 ls-files 是空的。
  const mjs = (dir, deep) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
        ? (deep ? mjs(join(dir, e.name), deep) : []) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []);
    } catch { return []; }
  };
  const files = [...mjs(".claude/hooks", true), ...mjs("scripts", false)];
  const hits = files.flatMap((f) => dupHits(readFileSync(f, "utf8")).map((h) => `${f}:${h.line} ${h.cls}`));
  assert(`hook / scripts 里没有「两个相同半角」的字符类(扫了 ${files.length} 个文件)`,
    ["guard-stop.mjs", "lib/config.mjs", "test-hooks.mjs"].every((n) => files.some((f) => f.endsWith(n))) && !hits.length,
    hits.join(" | ") || `该扫的没扫到:${files.join(", ")}`);
}

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
