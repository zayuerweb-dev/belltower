// 全框架唯一的时刻实现。别在别的 hook 里重写一份 —— 吃过亏:
// 两份 Intl 实现当天就打架(2026-08-25)。时区从 `.claude/belltower.json` 的 timezone 读。
import { config } from "./config.mjs";

const TZ = () => config().timezone;

// 测试钉时钟:只在 CLAUDE_HOOK_TEST=1 时认 BELLTOWER_NOW(ISO 时刻),平时一律用真时刻。
// 为什么:整套测试跑过午夜,「当天」那几条会误红;写死日期的测试第二天全红(装了框架的项目踩过)。
// 测试入口先钉一个时刻,期望值和 hook 用同一个时刻算,就不会跨天。
const now = () => {
  const pin = process.env.CLAUDE_HOOK_TEST === "1" ? process.env.BELLTOWER_NOW : "";
  const d = pin ? new Date(pin) : new Date();
  return isNaN(d) ? new Date() : d;
};

export function stamp() {
  const d = now();
  const s = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).format(d);
  return `${s} (${TZ()})`;
}

export function ymd() {
  const d = now();
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return p; // YYYY-MM-DD
}
