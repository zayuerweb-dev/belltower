#!/usr/bin/env node
// PreToolUse(Bash|PowerShell)。拦 = stderr 写原因 + exit 2。
// stdin 解析失败一律放行(fail-open)—— 闸门自身故障不该瘫痪正常工作。
//
// ★维护提示:这个文件里全是正则,**不要用 shell heredoc + sed/python 去改它**。
//   反斜杠会被 shell 和 python 两层转义吃掉,正则会静默失效(踩过:
//   一次改动把 33 绿变成 15 绿 19 红)。改它用文件编辑工具。
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, regex } from "./lib/config.mjs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const cmd = String(input.tool_input?.command ?? "");
const sid = String(input.session_id ?? "unknown");
const deny = (msg) => { process.stderr.write(msg); process.exit(2); };

// ── 正文段剥离:写在命令里但不会被执行的段落 ──────────────────────────
// **在文本里描述一个命令 ≠ 要执行它。** 这是个反向激励:越想在任务书或注释里
// 把「别做 X」写清楚,越会被当成「要执行 X」。heredoc 正文与 claude -p 的
// prompt 参数都是描述不是执行。★key 那道闸仍用原文 —— heredoc 里的 key 正是要拦的。
const stripHeredocs = (s) => {
  const open = /<<-?\s*(["']?)([A-Za-z_]\w*)\1/g;
  let out = "", last = 0, m;
  while ((m = open.exec(s))) {
    if (open.lastIndex < last) continue;
    const nl = s.indexOf("\n", open.lastIndex);
    if (nl < 0) break;
    const rest = s.slice(nl + 1);
    const end = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, "m").exec(rest);
    const bodyEnd = end ? nl + 1 + end.index : s.length;
    out += s.slice(last, nl + 1);
    last = bodyEnd;
    open.lastIndex = bodyEnd;
  }
  return out + s.slice(last);
};
const stripClaudePrompt = (s) => !/\bclaude\b/.test(s) ? s :
  s.replace(/(^|\s)(-p|--prompt|--system-prompt|--append-system-prompt)(\s+|=)(["'])[\s\S]*?\4/g,
            (_, a, flag, sep, q) => `${a}${flag}${sep}${q}${q}`);
const scan = stripClaudePrompt(stripHeredocs(cmd));

// 给 Stop 闸门用的旗标
const JOURNAL_WRITE =
  /(>>?|\btee\b|\bAdd-Content\b|\bSet-Content\b|\bOut-File\b)(\s+-\w+)*\s*["']?[\w.\\/-]*docs[\\/]journal\.md/i;
try {
  mkdirSync(".claude/.session-state", { recursive: true });
  if (JOURNAL_WRITE.test(scan))
    appendFileSync(join(".claude/.session-state", `${sid}.flags`), "edit:docs/journal.md\n");
} catch {}

const logGate = (gate, why) => {
  if (process.env.CLAUDE_HOOK_TEST === "1") return;
  try {
    mkdirSync("docs", { recursive: true });
    const d = new Date().toISOString().slice(0, 10);
    appendFileSync("docs/gate-log.md",
      `| ${d} | ${gate} | \`${cmd.slice(0, 100).replace(/\n/g, " ").replace(/\|/g, "\\|")}\` | 待判 | ${why} |\n`);
  } catch {}
};

// ── 闸门1:敏感数据不许拷进本仓库(铁律1)──────────────────────────
// 确认闸不是禁令 —— 要用先问用户。路径模式来自配置 sensitivePaths.bash(空 = 关掉)。
// 出处(2026-09-09):一整个外部数据目录被 git init 后推上 GitHub,里面是别人的真实名单和地址,
//   没人问过。所以默认不进,每一份都要用户点头。
const SENSITIVE = regex(config().sensitivePaths.bash);
const COPY = /(?<![\w-])(cp|copy|move|mv|robocopy|Copy-Item|Move-Item|xcopy)(?![\w-])/i;
if (SENSITIVE && COPY.test(scan) && SENSITIVE.test(scan)) {
  logGate("闸1 敏感数据入库", "拷贝动词 + 敏感数据路径");
  deny("闸门1:这条命令看起来要把**敏感数据**拷进本仓库(铁律1)。\n" +
       "默认不进。真要用:先跟用户确认「取哪一份 / 脱敏到什么程度 / 进不进版本库」。\n" +
       "模式在 .claude/belltower.json 的 sensitivePaths.bash;误伤记 docs/gate-log.md。");
}

// ── 闸门2:git add 不许点名敏感数据 / 不许 -f 绕过 ─────────────────────
if (/\bgit\s+add\b[^\n|;&]*\s(-f|--force)\b/.test(scan)) {
  logGate("闸2 git-add-force", "git add -f");
  deny("闸门2:`git add -f` 会绕过 .gitignore 的默认拒绝。要放行某一份先拿到用户确认,再改规则。");
}
// 只看 `git add` 自己的参数段(到 && / ; / | / 换行为止),不看整条命令 ——
// 否则「验证有没有漏网」的 grep 会被自己拦住。
for (const m of scan.matchAll(/\bgit\s+add\b([^\n;&|]*)/g)) {
  if (SENSITIVE && SENSITIVE.test(m[1] ?? "")) {
    logGate("闸2 git-add-敏感数据", "git add 参数里点名敏感数据");
    deny("闸门2:这条 `git add` 的参数里点名了敏感数据(铁律1)。先拿确认。");
  }
}

// ── 闸门3:别删系统 Temp ────────────────────────────────────────────────
// 出处:2026-08-11 一条 Remove-Item 删掉 580 项,Claude Code 自己的工作目录就在
// Temp\claude\ 下,软件当场闪退。词首用 (?<![\w-]) 不用 \b —— \b 挡不住 `docker run --rm`。
const DEL = /(?<![\w-])(Remove-Item|rmdir|del|rd|rm)(?![\w-])/i;
const OS_TEMP = /(AppData[\\/]+Local[\\/]+Temp|\$env:TEMP|%TEMP%|\$env:LOCALAPPDATA[\\/]+Temp|%LOCALAPPDATA%[\\/]+Temp)/i;
if (DEL.test(scan) && OS_TEMP.test(scan)) {
  logGate("闸3 del-temp", "删除动词 + 系统 Temp 路径");
  deny("闸门3:不许对系统 Temp 做删除。只删明确属于自己、且确认没有进程在用的子目录。");
}

// ── 闸门4:key 不落盘(用原文,不用 scan)────────────────────────────
if (/(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/.test(cmd)) {
  logGate("闸4 key-in-cmd", "命令文本里出现 key 形状");
  deny("闸门4:命令里出现 API key 形状,拒绝执行(命令会进转录和 shell 历史)。");
}

process.exit(0);
