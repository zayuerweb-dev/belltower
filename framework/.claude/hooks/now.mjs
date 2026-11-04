#!/usr/bin/env node
// UserPromptSubmit:每轮往上下文注入「本轮真实时刻」;认出是塔,再多念一行身份。
//
// 为什么需要(2026-08-25 实测结论):会话恢复时 system 块按「现在」
// 重新渲染,而转录里的工具输出冻在它们跑的那一刻、且不带时刻 —— 模型分不出
// 哪块是今天的、哪块是三天前的。没有这一行,「刚才那批跑完了」这种判断就会错。
import { stamp } from "./lib/now.mjs";
import { whoAmI, dutyOf } from "./lib/config.mjs";

let line =
  `【本轮真实时刻】${stamp()}。` +
  `转录里更早的工具输出可能是几天前跑的,别当成刚刚;` +
  `要算间隔用 git 提交时间或文件 mtime 这类机器时间戳。`;

// 塔每轮念一句身份。出处:装了框架的项目里,塔聊久了、压缩过,又不知道自己是塔了 —— 同一个病犯第二次。
//   开局的身份行(session-start.mjs)和塔卡(tower-card.mjs)只在开局 / 压缩 / 恢复那一下贴,一段里聊久了照样被淹掉。
//   只对活表塔表里认得出的塔念(工人 / 本机 CLI / 认不出的不念),一行,便宜。
//   本分按塔拿(lib/config.mjs 的 dutyOf):巡检塔不派工人,念「派工人 → 收活」会把它带歪。
try {
  const { board } = whoAmI();
  if (board) line += `\n【你是 ${board} 塔(常驻)】${dutyOf(board).turn}`;
} catch {}

console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line },
}));
