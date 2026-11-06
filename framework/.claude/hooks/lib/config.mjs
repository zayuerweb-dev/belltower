// 项目配置:读 `.claude/belltower.json`(相对当前工作目录 = 项目根),缺哪项用哪项的默认值。
// 全框架唯一的配置入口 —— hook 和脚本都从这里拿,别在别处再写一份默认值(两份一定分叉)。
// 读不了 / 解析不了一律用默认值:闸门自身故障不该瘫痪正常工作(fail-open)。
import { readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({
  project: "",                                   // 开局那行显示的项目名;空 = 用仓库目录名
  repo: "",                                      // "owner/name";空 = 从 git remote origin 现解析
  codeDirs: ["src"],                             // 「现数代码」和闸门11「代码 PR」看的目录
  codeExt: ["py", "ts", "tsx", "js", "jsx", "sql"], // 算「源文件」和收尾闸门6 看的扩展名
  boards: ["plan", "product", "dev", "data", "ops", "biz", "meta", "test", "patrol"],
  // 各板块的任务号段(立号用;开局认出塔身份时打出来)。没列的板块 = 不提示号段。
  // patrol(巡检塔)故意不列:它不派工人、不立号。
  ranges: { plan: "Q1xx", product: "Q2xx", dev: "Q3xx", data: "Q4xx", ops: "Q5xx", biz: "Q6xx", meta: "Q7xx", test: "Q8xx" },
  timezone: "America/New_York",
  sensitiveReminder: "敏感数据默认不进本仓库;每要用一份,先问用户(铁律「敏感数据默认不进本仓库」)。",
  // 敏感数据路径(铁律1 的默认值)。bash = 拷贝命令里出现就拦;edit = 写进仓库的相对路径命中就拦。
  // 项目按自己的数据改;设成空字符串 = 关掉这道闸。
  sensitivePaths: {
    bash: String.raw`((^|[\s"'/\\])(sensitive|private-data)([/\\]|\s|$)|credentials?\.json|secrets?\.json|\.(pem|pfx|p12)(\s|$))`,
    edit: String.raw`((^|/)(sensitive|private-data)/|(^|/)credentials?\.json$|(^|/)secrets?\.json$|\.(pem|pfx|p12)$)`,
  },
  // 台账四件以外、也许直推 main 的文件(ledger-push 和闸门12 都认,清单见 scripts/lib/direct-push.mjs)。
  // 默认空 = 口子只有台账四件。**要开口子先问用户**,问过了把文件路径写进来。
  directPush: [],
  // 刹车(闸门17):同一家号最多合几轮,再派要用户点头(dispatch.md「刹车」)。0 = 关掉轮次封顶;不是非负整数 = 用默认值。
  brakeRounds: 3,
  // 交付分档(dispatch.md「交付分档」):按改动大小定 dev / test 各验多少。档由 dev 判,scripts/tier.mjs 按文件给最低档:
  //   动到 big 里的路径 = 大;动到 mid 里的 = 最低中;都没碰 = 不兜底(还是 dev 判)。
  //   路径模式:`**/` 任意层目录、`*` 一段里任意字符;相对仓库根、整条对上。下面只是常见目录名的例子,**项目按自己的目录改**。
  //   fullTestCmd = 项目自己的全量回归命令(一单只跑一次,跑在收活的合并树上);空 = 没配。
  tiers: Object.freeze({
    mid: Object.freeze(["**/api/**", "**/auth/**"]),
    big: Object.freeze(["**/migrations/**", "**/security/**"]),
    fullTestCmd: "",
  }),
});

// directPush 的一项:仓库内的相对路径,一项一个文件,写成 git 自己打印的样子 ——
// `/` 分段,每段只用 ASCII 字母、数字和 `. _ -`,不许空段、`.`、`..`。
// 所以通配(* ? [)、绝对路径(/ 开头、盘符的冒号)、反斜杠、`..` 都进不来;
// 空格、中文这类字符 `git status --porcelain` 会加引号打印,配了也永远对不上,一并不收。
// 不合格的那一项丢掉;整个键不是数组 / 文件写坏了 = 当没配(空)。
const REPO_FILE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const repoFile = (p) => typeof p === "string" && REPO_FILE.test(p) &&
  p.split("/").every((s) => s !== "." && s !== "..");

// timezone 要是 Intl 认得的时区名;写坏了(拼错、不存在的区、空串)= 用默认时区。
// 不在这儿兜,lib/now.mjs 一抛错,开局 hook 和每轮时刻行就整个出不来(测出来过:写成 Mars/Olympus,两个都退出 1)。
const tzOk = (z) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } };

// tiers:mid / big 各是字符串数组(空数组 = 这一档不兜底);写坏了(不是数组、混进非字符串)用默认。fullTestCmd 是字符串。
const tierList = (v, d) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x) ? [...v] : [...d]);
function tiersOf(t) {
  const o = t && typeof t === "object" && !Array.isArray(t) ? t : {};
  return {
    mid: tierList(o.mid, DEFAULTS.tiers.mid),
    big: tierList(o.big, DEFAULTS.tiers.big),
    fullTestCmd: typeof o.fullTestCmd === "string" ? o.fullTestCmd : DEFAULTS.tiers.fullTestCmd,
  };
}

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
    timezone: typeof raw.timezone === "string" && raw.timezone && tzOk(raw.timezone) ? raw.timezone : DEFAULTS.timezone,
    sensitiveReminder: str(raw.sensitiveReminder, DEFAULTS.sensitiveReminder),
    sensitivePaths: {
      bash: str(sp.bash, DEFAULTS.sensitivePaths.bash),
      edit: str(sp.edit, DEFAULTS.sensitivePaths.edit),
    },
    directPush: Array.isArray(raw.directPush) ? [...new Set(raw.directPush.filter(repoFile))] : [],
    brakeRounds: Number.isInteger(raw.brakeRounds) && raw.brakeRounds >= 0 ? raw.brakeRounds : DEFAULTS.brakeRounds,
    tiers: tiersOf(raw.tiers),
  };
  if (!cached.boards.length) cached.boards = [...DEFAULTS.boards];
  // directPush 不收代码:codeDirs 底下的、codeExt 扩展名的一律丢掉。
  // 闸门11 把 ledger/* 分支一律当文档 PR(塔可以自己开自己合);口子里混进代码,就成了绕过「代码 PR 换人合」的后门。
  const isCode = (p) => cached.codeDirs.some((d) => { const x = d.replace(/\/+$/, ""); return p === x || p.startsWith(`${x}/`); }) ||
    cached.codeExt.some((e) => p.toLowerCase().endsWith(`.${e.toLowerCase()}`));
  cached.directPush = cached.directPush.filter((p) => !isCode(p));
  return cached;
}

// 配置里的正则串 → RegExp;空串或写坏了 = null(这道闸关掉,不崩)。
export function regex(src, flags = "i") {
  if (!src) return null;
  try { return new RegExp(src, flags); } catch { return null; }
}

// skill 前缀固定,不做成可配置:身份锚、活表、文档引用全靠它对得上。
export const SKILL_PREFIX = "tower-";

// ── 塔的本分:认出塔之后念哪几句,按塔分 ────────────────────────────────────
// 别的塔都念 default;巡检塔不派工人,照「讨论 → 定 → 派工人 → 收活」念会把它带歪,所以单给一套。
// 每套四句,各给谁用:
//   start   = 开局 hook(session-start.mjs)认出塔之后那行「塔的本分」;
//   turn    = 每轮身份行(now.mjs),跟在「【你是 X 塔(常驻)】」后面那句;
//   card    = 塔卡(tower-card.mjs)第二行,跟在「★ 你是 X 塔(常驻)。」后面那句;
//   compact = 塔卡第三行,压缩之后的提醒。
// 规矩只存一份:要改本分改这里,别在调用处另写一句。
const DUTY = Object.freeze({
  default: Object.freeze({
    turn: "讨论 → 定 → 派工人 → 收活;成品活写任务书派工人,别在塔里干。",
    card: "塔 = 讨论 → 定 → 派工人 → 收活。",
    compact: "★ 摘要会让你「直接接着干」—— 先看那件活该不该在塔里干:成品活(写代码、画板子、规格成稿、整份报告)写任务书派工人;塔里只留讨论、拍板、收活。",
    start: "塔的本分:讨论 → 定 → 派工人 → 收活。**成品活派工人,别在塔里干** —— " +
      "塔的上下文大,在塔里每走一步都比工人贵几倍。见 tower.md「形态」。",
  }),
  patrol: Object.freeze({
    turn: "定期的活:跑 → 报用户 → 照「归谁」派回那个塔 → 回查;不派工人、不定规矩、只写台账、不改别的塔的文件。",
    card: "巡检塔 = 跑 → 报用户 → 照「归谁」派回 → 回查;不派工人、不定规矩、只写台账四件。",
    compact: "★ 摘要会让你「直接接着干」—— 接着跑例程里没跑完的那一件;查出来的派回归谁的塔,别顺手替它改(别的塔的文件、meta 的规矩、本技能都不归你改)。",
    start: "巡检塔的本分:定期的活 —— 跑 → 报用户 → 照「归谁」派回那个塔 → 回查。" +
      "**不派工人、不定规矩、只写台账四件、不改别的塔的文件** —— 见 `.claude/skills/tower-patrol/SKILL.md`。",
  }),
});
// 板块 → 它那一套本分;没单给的板块念 default。只认 DUTY 自己的键(板块叫 constructor 之类也不会摸到原型链上去)。
export const dutyOf = (board) => (Object.hasOwn(DUTY, board) ? DUTY[board] : DUTY.default);

// ── 我是哪个塔:从会话 ID 现查活表(开局 hook 和收尾闸门共用,规矩只存一份)──────────
// 云会话的环境变量 CLAUDE_CODE_REMOTE_SESSION_ID=cse_<X> ↔ 活表 `docs/session-pool.md` 里写的 session_<X>。
// 活表行格式:`| <板块> | \`tower-<板块>\` | … session_<X> … |`,板块必须在配置的板块清单里。
// 返回 { remote: 是不是云会话, pool: 活表读到没有, board: 对上的板块或 null }。
//   remote && pool && !board = 活表里没有它的塔行 = 工人(或别的临时会话)。
export function whoAmI() {
  const m = String(process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "").match(/^cse_(\w+)$/);
  if (!m) return { remote: false, pool: false, board: null };
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boards = config().boards.map(esc).join("|");
  const rowRe = new RegExp(`^\\| (${boards}) \\| \`${esc(SKILL_PREFIX)}(${boards})\``);
  let text;
  try { text = readFileSync("docs/session-pool.md", "utf8"); } catch { return { remote: true, pool: false, board: null }; }
  const row = text.split("\n").find((l) => rowRe.test(l) && l.includes(`session_${m[1]}`));
  return { remote: true, pool: true, board: row?.match(rowRe)?.[1] ?? null };
}
