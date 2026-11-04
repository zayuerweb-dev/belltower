#!/usr/bin/env node
// SessionStart(开局 / 压缩 / 恢复 / clear 都跑,所以注册时不带 matcher):给塔贴回「塔卡」—— 为什么见 lib/tower-card.mjs 头注释。
// 工人 / 本机 CLI / 认不出的会话 → 什么都不打。任何一步失败都不许拖垮开局:最差这张卡不出(fail-open)。
// 跟 session-start.mjs 分开:那份管「现在什么状态」,这份管「我是谁、照什么干、手上有什么」;
//   同一事件两个 hook 并行跑,一万字的注入上限也各算各的 —— 卡单独一个 hook,不跟开局自检抢字数。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { whoAmI } from "./lib/config.mjs";
import { buildCard, skillPathOf, TOWER_MD } from "./lib/tower-card.mjs";

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
// 台账读 origin/main(台账走 main,见 tower.md「塔的开局动作」);拿不到(不是 git 仓库、没有 origin)退回工作树。
// 不在这儿 fetch:网络慢会拖住开局,这里要快。路径前缀 `./` = 按当前目录(项目根)解析,不会读到外层别的仓库里去。
const onMain = (p) => {
  try {
    return execFileSync("git", ["show", `origin/main:./${p}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 64 << 20 });
  } catch { return read(p); }
};

try {
  // 认身份跟开局 hook、收尾闸门用同一个 whoAmI(会话 ID ↔ 活表塔表那一行),规矩只存一份
  const { board } = whoAmI();
  if (board) {
    let source = "";
    try { source = JSON.parse(readFileSync(0, "utf8")).source ?? ""; } catch {}
    const card = buildCard({
      board, source,
      skillText: read(skillPathOf(board)),
      towerMd: read(TOWER_MD),
      poolText: onMain("docs/session-pool.md"),
      backlogText: onMain("docs/BACKLOG.md"),
    });
    if (card) console.log(card);
  }
} catch {}
