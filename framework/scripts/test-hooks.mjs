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
  gitq(d, "config", "user.email", "t@t"); gitq(d, "config", "user.name", "t");
  gitq(d, "remote", "add", "origin", origin);
  return d;
}
const commitAll = (d, msg) => { gitq(d, "add", "-A"); gitq(d, "commit", "-qm", msg); };
const flagsIn = (dir, sid) => {
  try { return readFileSync(join(dir, ".claude/.session-state", `${sid}.flags`), "utf8"); }
  catch { return ""; }
};

// ★ 今天的日期在这儿**自己算一遍**,不 import lib/now.mjs ——
//   否则 ymd() 被改坏时测试的期望值跟着一起坏,断言永远绿(变异:M37)。
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
// 「真时刻」的形状:年/月/日 … 时:分 (America/New_York)。占位串顶不上(变异:M36)。
const STAMP_SHAPE = /\d{4}\/\d{2}\/\d{2}\D*\d{2}:\d{2} \(America\/New_York\)/;

// Stop 闸门是「输出 JSON 说 block」,不是 exit 2 —— 判据跟 PreToolUse 不一样。
function stopHook({ flags = "", lastText = "", journal = null, journalDelta = 0,
                    stopHookActive = false, sid = "stoptest", ctxTokens = 0, bloat = 0,
                    settings = null, compactions = 0, cfg = null }) {
  const dir = sandbox();
  if (cfg) withCfg(dir, cfg);
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
    { session_id: sid, transcript_path: tp, stop_hook_active: stopHookActive });
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
      new_string: "### T1 —— 开发解除阻塞\n用户 22:22 ET:「留着,补一句授权」\n" } })));
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
  assert("绿:原文里本来就写着的不算新声称",
    allowed(ed("prm3", "PR #99999 已合\n", "PR #99999 已合\n别的\n")));  // scan-public:ok(测试夹具)
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
// ★ v3:窗口从设置里现读(自动压缩 30 万,用户 2026-09-25「按这个来」)。有配置 → 70% 提醒。
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
}

// ── 闸门10 / 11:MCP 工具那两个口子 ────────────────────────────────────
const mcp = (dir, sid, tool_name, tool_input = {}) =>
  runIn(dir, "guard-mcp.mjs", { session_id: sid, tool_name, tool_input });
{
  const d = sandbox();
  const r = mcp(d, "m1", "mcp__Claude_Code_Remote__create_session", { title: "Q301 · 某某" });
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
    allowed(mcp(d, "m1", "mcp__Claude_Code_Remote__create_session", { title: "Q301 · 某某" })));
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
    denied(mcp(d, "m3", "mcp__Claude_Code_Remote__create_session")) &&
    denied(mcp(d, "m3", "mcp__github__merge_pull_request", { pullNumber: 1 })));
}
assert("绿:别的 MCP 工具不拦",
  allowed(mcp(sandbox(), "m4", "mcp__github__list_pull_requests")));

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
const start = (dir, sid = "") => runIn(dir, "session-start.mjs", {}, { CLAUDE_CODE_REMOTE_SESSION_ID: sid });
{
  const r = start(sandbox());
  assert("session-start 退出 0", r.code === 0, `code=${r.code} ${r.err.slice(0, 120)}`);
  assert("session-start 第一行是时刻", /^现在:/.test(r.out), r.out.slice(0, 60));
  assert("session-start 的时刻是真时刻不是占位串",
    STAMP_SHAPE.test(r.out.split("\n")[0] ?? ""), r.out.slice(0, 60));
  assert("session-start 提示声明板块", /板块=\?/.test(r.out));
  // ★ 板块清单是默认的八个。一板块一条,变异:从默认清单里删掉任一个名字,对应那条要红。
  for (const b of ["plan", "product", "dev", "data", "ops", "biz", "meta", "test"])
    assert(`session-start 默认板块清单含 ${b}`,
      new RegExp(`板块=\\?\\([^)]*\\b${b}\\b[^)]*\\)`).test(r.out), r.out.split("\n").find((l) => /板块=/.test(l)));
  assert("session-start 默认提醒敏感数据要确认", /铁律1/.test(r.out));
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

// ── 坏输入一律 fail-open ────────────────────────────────────────────────
for (const h of ["guard-bash.mjs", "guard-edit.mjs", "guard-stop.mjs"]) {
  const r = spawnSync(process.execPath, [join(HOOKS, h)],
    { input: "not json", encoding: "utf8", env: { ...process.env, CLAUDE_HOOK_TEST: "1" } });
  assert(`${h} 解析失败时放行`, r.status === 0, `code=${r.status}`);
}

for (const d of SANDBOXES) rmSync(d, { recursive: true, force: true });

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
