#!/usr/bin/env node
// UserPromptSubmit:每轮往上下文注入「本轮真实时刻」。
//
// 为什么需要(2026-08-25 实测结论):会话恢复时 system 块按「现在」
// 重新渲染,而转录里的工具输出冻在它们跑的那一刻、且不带时刻 —— 模型分不出
// 哪块是今天的、哪块是三天前的。没有这一行,「刚才那批跑完了」这种判断就会错。
import { stamp } from "./lib/now.mjs";

const line =
  `【本轮真实时刻】${stamp()}。` +
  `转录里更早的工具输出可能是几天前跑的,别当成刚刚;` +
  `要算间隔用 git 提交时间或文件 mtime 这类机器时间戳。`;

console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line },
}));
