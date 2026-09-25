#!/usr/bin/env node
// SessionStart 开局自检。任何一步失败都不许拖垮开局 —— 各自 try 包住,最差少一行。
// 项目相关的几项(项目名、代码目录、板块、敏感数据提醒)从 `.claude/belltower.json` 读。
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { stamp } from "./lib/now.mjs";
import { config, SKILL_PREFIX } from "./lib/config.mjs";

const cfg = config();
const out = [];
const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ★第一行永远是时刻:恢复的会话里 system 块是新鲜的、转录里的工具输出是陈的。
out.push(`现在:${stamp()}`);
out.push(`仓库:${cfg.project || basename(resolve("."))}`);

// ── 我是哪个塔:**现查的,不是记的** ─────────────────────────────────────
// 出处(2026-09-24):一个常驻塔跑着跑着忘了自己是塔,成品活全在塔里干,
//   两周没派过一个工人,上下文胖到五十多万。塔的身份原来只活在开局那句口令里;
//   压缩 / 恢复之后摘要未必还带着它。**身份靠记性 = 必丢** —— 所以每次开局 / 恢复 / 压缩后
//   都从会话 ID 现查活表:容器里 CLAUDE_CODE_REMOTE_SESSION_ID=cse_<X> ↔ 活表 session_<X>。
//   (本 hook 在 startup / resume / compact 都会跑;门铃唤醒 = resume,所以每次被叫醒都会重新认一次。)
// 活表行格式:`| <板块> | \`tower-<板块>\` | … session_<X> … |`,板块必须在配置的板块清单里。
try {
  const m = String(process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "").match(/^cse_(\w+)$/);
  if (m) {
    const boards = cfg.boards.map(esc).join("|");
    const rowRe = new RegExp(`^\\| (${boards}) \\| \`${esc(SKILL_PREFIX)}(${boards})\``);
    const row = readFileSync("docs/session-pool.md", "utf8").split("\n")
      .find((l) => rowRe.test(l) && l.includes(`session_${m[1]}`));
    const board = row?.match(rowRe)?.[1];
    if (board) {
      out.push(`★ 你是 **${board} 塔**(常驻)—— 会话 ID 对上活表那一行,现查的,不是凭记忆。`);
      out.push("  塔的本分:讨论 → 定 → 派工人 → 收活。**成品活派工人,别在塔里干** —— " +
        "塔的上下文大,在塔里每走一步都比工人贵几倍。见 tower.md「形态」。");
      if (cfg.ranges[board]) out.push(`  本塔号段:${cfg.ranges[board]}(立号前要有用户那句「做这个」落在台账上)。`);
    }
  }
} catch {}

try {
  const br = sh("git branch --show-current");
  const dirty = sh("git status --porcelain").split("\n").filter(Boolean).length;
  out.push(`工作区:分支 ${br}${dirty ? `,未提交 ${dirty} 项` : ",干净"}`);
} catch {}

// ── 代码现状:**数出来的,不是手写的** ──────────────────────────────────
// 出处(2026-09-10):CLAUDE.md 里手写着「零代码」,而 main 上已经有几十个源文件。
//   每个塔开局都读那句当真。**状态被存下来了,没人保证它跟事实同步**(派生 > 存储)。
//   所以这一行永远现数;数哪几个目录由配置 codeDirs 定。
try {
  const dirs = cfg.codeDirs.map((d) => `'${d.replace(/'/g, "")}'`).join(" ");
  const files = sh(`git ls-files ${dirs} 2>/dev/null || true`).split("\n").filter(Boolean);
  const extRe = new RegExp(`\\.(${cfg.codeExt.map(esc).join("|")})$`);
  const src = files.filter((f) => extRe.test(f)).length;
  out.push(src
    ? `代码:${files.length} 个文件、其中 ${src} 个源文件(现数的,别信文档里写死的数)`
    : "代码:还没有(现数的)");
} catch {}

try {
  const b = readFileSync("docs/BACKLOG.md", "utf8");
  const sec = b.split(/^## /m).find((s) => s.startsWith("一、"));
  const n = sec ? (sec.match(/^### /gm) || []).length : 0;
  if (n) out.push(`BACKLOG 红区(正在骗用户的):${n} 条`);
} catch {}

try {
  if (existsSync(".claude/frozen.txt")) {
    const n = readFileSync(".claude/frozen.txt", "utf8")
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).length;
    if (n) out.push(`冻结清单:${n} 份不许动(闸门1 会拦)`);
  }
} catch {}

out.push("");
out.push(`开局先声明:**板块=?(${cfg.boards.join(" / ")}) 任务=?** —— 一会话一任务。`);
if (cfg.sensitiveReminder) out.push(`★ ${cfg.sensitiveReminder}`);

console.log(out.join("\n"));
