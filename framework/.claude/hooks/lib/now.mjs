// 全框架唯一的时刻实现。别在别的 hook 里重写一份 —— 吃过亏:
// 两份 Intl 实现当天就打架(2026-08-25)。时区从 `.claude/belltower.json` 的 timezone 读。
import { config } from "./config.mjs";

const TZ = () => config().timezone;

export function stamp() {
  const d = new Date();
  const s = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).format(d);
  return `${s} (${TZ()})`;
}

export function ymd() {
  const d = new Date();
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return p; // YYYY-MM-DD
}
