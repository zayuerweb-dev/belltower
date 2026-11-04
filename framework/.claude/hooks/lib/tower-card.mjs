// 塔卡:开局 / 压缩 / 恢复 / clear 之后,把「我是哪个塔、照什么干、手上有什么」现读一遍,整份贴回上下文。
// 这里只放纯函数(拼卡、切节、解析活表和 BACKLOG);认身份、读文件在 ../tower-card.mjs。
//
// 为什么要它(平台事实见 docs/platform-facts.md §3):
//   - 压缩之后,Skill 注入过的本塔技能全文**不会补回来** [实测✅ 2026-10,装了框架的项目实测:数过几十次压缩,
//     一次都没补回 —— 补回的是 CLAUDE.md、摘要、最近读过的文件、开局 hook 的输出]。
//   - 开局 hook 那两行身份(session-start.mjs)一直都在,可它只说「你是 X 塔」,不说 X 塔该照什么干;摘要又让它
//     「直接接着干」—— 成品活就全在塔里干了。tower.md「每次唤醒先读本板块 SKILL.md」那句也跟着压没了,
//     几十段里回头重读过本塔技能的只有少数几段。**靠记性重读 = 必漏**,所以由 hook 每次现读、整份贴回。
//   - 派生 > 存储:全文从文件现读,技能改了卡跟着变,不存第二份。
// 头两行的本分按塔从 lib/config.mjs 的 dutyOf 拿(巡检塔不派工人,别照「派工人 → 收活」念)。
import { dutyOf, SKILL_PREFIX } from "./config.mjs";

// ── 封顶 ─────────────────────────────────────────────────────────────────
// 每个 hook 注入的上下文上限 10,000 字符,按字符、每个 hook 单算 [文档✅,docs/platform-facts.md §3]。
//   超了**不是截尾**:整段写进文件,模型只拿到路径和前约 2,000 字 —— 超一个字,卡就只剩两千字。
//   封顶 9500,留 500 字余量(console.log 还要补一个换行)。
// 一万字怎么分,按先后:
//   1. 卡头(身份 + 本分)和「③ 本塔手上」的摘要行 —— 必进;每一格都截短,长度有上界;
//   2. 本塔技能全文 —— 这张卡要补回来的就是它;
//   3. 在跑工人的细节行 —— 放不下就一行一行让给技能(摘要行里单号照列,人不会被忘);
//   4. 塔的协议(tower.md「六条协议」整节)—— 最后进;放不下就只留一行指路。
//   技能全文自己就放不下,才截技能的尾巴,并注明还差多少字、去读哪个文件。
// 卡末尾有「塔卡完」一行 —— 转录里看得到它 = 整张进去了。
export const CARD_MAX = 9500;
export const CARD_END = "━━━━ 塔卡完 ━━━━";

export const skillPathOf = (board) => `.claude/skills/${SKILL_PREFIX}${board}/SKILL.md`;
export const TOWER_MD = `.claude/skills/${SKILL_PREFIX}meta/references/tower.md`;

// 开场白按 SessionStart 输入里的 source 分;startup(开局)和认不出的都按开局说。
const WHY = Object.freeze({
  compact: "刚压缩过 —— 开局注进来的本塔技能全文已经不在上下文里了,也不会自己回来",
  resume: "会话恢复 —— 上一段注进来的本塔技能未必还在",
  clear: "刚 /clear —— 上下文是空的",
});

export function stripFrontmatter(md) {
  return String(md ?? "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}

// 取 `## 标题` 那一节的正文(到下一个 `## ` 为止,里面的 `### ` 小节算这一节的),不含标题行。
export function section(md, title) {
  const lines = String(md ?? "").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`## ${title}`));
  if (i < 0) return "";
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  return lines.slice(i + 1, j).join("\n").trim();
}

// 活表「任务会话(短命)」表:| 单号 | 派发塔 | 任务 | 工人会话 | 分支 | 起跑 | 状态 |。
// 收活时整行删掉,所以还在表里的都算手上的;只拿本塔派的(第二格 = 本塔板块名)。
export function myWorkers(board, poolText) {
  return String(poolText ?? "").split("\n")
    .filter((l) => /^\| *Q\w* *\|/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((s) => s.trim()))
    .filter((c) => c[1] === board)
    .map((c) => ({ q: c[0], task: c[2] ?? "", sid: (c[3] ?? "").replace(/`/g, ""), started: c[5] ?? "", status: c[6] ?? "" }));
}

// 活表塔表里本塔那一行的状态格。行格式跟 whoAmI 认身份用的是同一个:| <板块> | `tower-<板块>` | …;
// 模板的表头是「塔 | 板块 skill | 形态 | 会话 ID / 链接 | 状态」,状态是第 5 格(表被删窄了就没有,不硬凑)。
export function towerStatus(board, poolText) {
  const row = String(poolText ?? "").split("\n").find((l) => l.startsWith(`| ${board} | \`${SKILL_PREFIX}${board}\` |`));
  return row ? row.split("|").slice(1, -1).map((s) => s.trim())[4] ?? "" : "";
}

// 本塔的接手须知(BACKLOG 模板里那种「<板块> 塔 · 接手须知」标题)。只要当前那版:标题里写着「上一版」的不算。
export function handoffNote(board, backlogText) {
  const b = String(board).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^#{2,5} (?!.*上一版).*\\b${b}\\b[^\\n]*接手须知`);
  const lines = String(backlogText ?? "").split("\n");
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : { line: i + 1, text: lines[i].replace(/^#+\s*|\*\*/g, "").trim() };
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
// 单号清单:最多列 20 个,单号自己也截短 —— 活表写坏了也撑不爆卡
const qList = (ws) => ws.slice(0, 20).map((w) => cut(w.q, 16)).join(" · ") + (ws.length > 20 ? ` 等 ${ws.length} 个` : "");
const len = (lines) => lines.join("\n").length;

export function buildCard({ board, source = "", skillText = "", towerMd = "", poolText = "", backlogText = "" }) {
  if (!board) return "";
  const duty = dutyOf(board);
  const skillPath = skillPathOf(board);
  const why = Object.hasOwn(WHY, source) ? WHY[source] : "开局";
  const head = [
    `━━━━ 塔卡 · ${board} 塔 ━━━━(${why};hook 现读重贴,不是凭记忆)`,
    `★ 你是 **${board} 塔**(常驻)。${duty.card}**下面是现读的,先读完再接着干。**`,
    duty.compact,
  ];

  // ③ 本塔手上。状态格只贴开头:塔往这一格续写回查记录,一格能到几千字,整格照贴会把技能正文挤出卡
  //   (装了框架的项目实测:一个塔几行工人的状态把卡撑到一万多字,技能全文一个字都没进)。
  //   截多少:状态 120、任务 40、起跑 20、工人会话 60;细节行最多 10 个;写着「收工」的(收完没删行)只报单号。
  const workers = myWorkers(board, poolText);
  const done = workers.filter((w) => /^收工/.test(w.status));
  const live = workers.filter((w) => !/^收工/.test(w.status));
  const mine = towerStatus(board, poolText);
  const note = handoffNote(board, backlogText);
  const top = ["", "── ③ 本塔手上(活表 docs/session-pool.md 现读)──"];
  if (mine) top.push(`活表里本塔那一行的状态:${cut(mine, 120)}`);
  top.push(live.length ? `在跑的工人 ${live.length} 个:${qList(live)} —— 收活 / 回查是你的事,别忘了它们。` : "在跑的工人:0 个。");
  const detail = live.slice(0, 10).map((w) =>
    `  · ${cut(w.q, 16)} · ${cut(w.task, 40)} · ${cut(w.sid, 60)} · ${cut(w.status, 120)}(起跑 ${cut(w.started, 20)})`);
  const bottom = [];
  if (done.length) bottom.push(`活表里还有 ${done.length} 行写着「收工」(${qList(done)})—— 收完了就删掉那行。`);
  if (note) bottom.push(`接手须知:docs/BACKLOG.md 第 ${note.line} 行「${cut(note.text, 60)}」—— 看标题里的日期,旧了就以台账最新几行为准。`);
  bottom.push("收件箱:origin/main 的 docs/BACKLOG.md 里写给本塔的留言(`→` 后面有本塔的),醒来先扫一遍。", CARD_END);
  const tail = (k) => [...top, ...detail.slice(0, k),
    ...(live.length > k ? [`  · 还有 ${live.length - k} 个的细节见活表`] : []), ...bottom];

  // ① 本塔技能
  const skill = stripFrontmatter(skillText);
  const title1 = `── ① 本塔技能(${skillPath} 全文现读)──`;
  let mid1 = skill ? ["", title1, skill] : ["", `── ① 本塔技能:读不到 ${skillPath},自己去读 ──`];

  // ② 塔的协议:先按「一行指路」占位;细节行和技能都排完还有地方,才换成整节。
  const proto = section(towerMd, "六条协议");
  const protoFull = proto ? ["", `── ② 塔的协议(${TOWER_MD}「六条协议」现读;开局动作、门铃、派发配方在那份和 dispatch.md)──`, proto] : [];
  const protoPtr = proto ? ["", `── ② 塔的协议:卡里放不下,要用时切 ${TOWER_MD}「六条协议」那一节 ──`] : [];

  // 细节行让位给技能全文
  let k = detail.length;
  while (k > 0 && len([...head, ...mid1, ...protoPtr, ...tail(k)]) > CARD_MAX) k--;
  // 细节行全让了技能还放不下:截技能的尾巴,注明还差多少字、去读原文件
  const room = CARD_MAX - len([...head, "", title1, "", ...protoPtr, ...tail(k)]);
  if (skill.length > room) {
    const more = (n) => `\n…(后面还有 ${n} 字没贴,读 ${skillPath})`;
    const keep = Math.max(0, room - more(skill.length).length);
    mid1 = ["", title1, skill.slice(0, keep) + more(skill.length - keep)];
  }
  const mid2 = len([...head, ...mid1, ...protoFull, ...tail(k)]) <= CARD_MAX ? protoFull : protoPtr;
  return [...head, ...mid1, ...mid2, ...tail(k)].join("\n");
}
