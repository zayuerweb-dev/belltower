// 项目配置:读 `.claude/belltower.json`(相对当前工作目录 = 项目根),缺哪项用哪项的默认值。
// 全框架唯一的配置入口 —— hook 和脚本都从这里拿,别在别处再写一份默认值(两份一定分叉)。
// 读不了 / 解析不了一律用默认值:闸门自身故障不该瘫痪正常工作(fail-open)。
import { readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({
  project: "",                                   // 开局那行显示的项目名;空 = 用仓库目录名
  repo: "",                                      // "owner/name";空 = 从 git remote origin 现解析
  codeDirs: ["src"],                             // 「现数代码」和闸门11「代码 PR」看的目录
  codeExt: ["py", "ts", "tsx", "js", "jsx", "sql"], // 算「源文件」和收尾闸门6 看的扩展名
  boards: ["plan", "product", "dev", "data", "ops", "biz", "meta", "test"],
  // 各板块的任务号段(立号用;开局认出塔身份时打出来)。没列的板块 = 不提示号段。
  ranges: { plan: "Q1xx", product: "Q2xx", dev: "Q3xx", data: "Q4xx", ops: "Q5xx", biz: "Q6xx", meta: "Q7xx", test: "Q8xx" },
  timezone: "America/New_York",
  sensitiveReminder: "敏感数据默认不进本仓库;每要用一份,先问用户(铁律1)。",
  // 敏感数据路径(铁律1 的默认值)。bash = 拷贝命令里出现就拦;edit = 写进仓库的相对路径命中就拦。
  // 项目按自己的数据改;设成空字符串 = 关掉这道闸。
  sensitivePaths: {
    bash: String.raw`((^|[\s"'/\\])(sensitive|private-data)([/\\]|\s|$)|credentials?\.json|secrets?\.json|\.(pem|pfx|p12)(\s|$))`,
    edit: String.raw`((^|/)(sensitive|private-data)/|(^|/)credentials?\.json$|(^|/)secrets?\.json$|\.(pem|pfx|p12)$)`,
  },
});

let cached = null;
export function config() {
  if (cached) return cached;
  let raw = {};
  try { raw = JSON.parse(readFileSync(".claude/belltower.json", "utf8")) ?? {}; } catch {}
  const arr = (v, d) => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? v : d);
  const str = (v, d) => (typeof v === "string" ? v : d);
  const sp = raw.sensitivePaths && typeof raw.sensitivePaths === "object" ? raw.sensitivePaths : {};
  cached = {
    project: str(raw.project, DEFAULTS.project),
    repo: str(raw.repo, DEFAULTS.repo),
    codeDirs: arr(raw.codeDirs, DEFAULTS.codeDirs),
    codeExt: arr(raw.codeExt, DEFAULTS.codeExt),
    boards: arr(raw.boards, DEFAULTS.boards).filter((b) => /^[a-z][a-z0-9-]*$/.test(b)),
    ranges: raw.ranges && typeof raw.ranges === "object" && !Array.isArray(raw.ranges)
      ? Object.fromEntries(Object.entries(raw.ranges).filter(([, v]) => typeof v === "string"))
      : { ...DEFAULTS.ranges },
    timezone: str(raw.timezone, DEFAULTS.timezone),
    sensitiveReminder: str(raw.sensitiveReminder, DEFAULTS.sensitiveReminder),
    sensitivePaths: {
      bash: str(sp.bash, DEFAULTS.sensitivePaths.bash),
      edit: str(sp.edit, DEFAULTS.sensitivePaths.edit),
    },
  };
  if (!cached.boards.length) cached.boards = [...DEFAULTS.boards];
  return cached;
}

// 配置里的正则串 → RegExp;空串或写坏了 = null(这道闸关掉,不崩)。
export function regex(src, flags = "i") {
  if (!src) return null;
  try { return new RegExp(src, flags); } catch { return null; }
}

// skill 前缀固定,不做成可配置:身份锚、活表、文档引用全靠它对得上。
export const SKILL_PREFIX = "tower-";
