// 门铃(定向唤醒)的共用件:闸门14(要对方动手的留言,同一轮得按门铃)· 闸门15(门铃没送到)· 闸门16(一个门铃只按一次)。
// guard-edit 记留言 · guard-mcp 记回执、拦重按 · guard-stop 核门铃、核送达,都从这里拿。
// 从装了框架的项目里搬来,只留门铃要的那几样。认「我是哪个塔」用 config.mjs 的 whoAmI(),这里不另写一份;
// 活表的行格式也跟它一样:`| <板块> | \`tower-<板块>\` | 形态 | 会话 ID | 状态 |`。
// 所有函数失败都返回空值,不抛 —— 调用方一律 fail-open。
import { readFileSync } from "node:fs";
import { SKILL_PREFIX } from "./config.mjs";

// ── 会话 ID 与工具名 ────────────────────────────────────────────────────
// 同一个会话两种写法:建门铃时填 `session_<X>`,`fire_trigger` 回执里是 `cse_<X>`,后面的字符一样
// (platform-facts §1.1)。比之前先去前缀。
export const bareSid = (s) => String(s ?? "").replace(/^(cse_|session_)/, "");
// 工具名按后缀认:云会话里 MCP 服务器名可能是一串 ID,不一定是可读名。
export const isTool = (name, suffix) => new RegExp(`(^|__)${suffix}$`).test(String(name ?? ""));

// ── 活表:某个塔当前的会话 ───────────────────────────────────────────────
// 塔表那一行「会话 ID」格(第 4 列)里的**第一个** `session_…`:那格里可能顺带写着上一任或别的 ID,
// 第一个才是当前的(活表模板:塔被重开后换成新 ID)。没有这一行、那格还是「待开」→ null。
export function readPool() {
  try { return readFileSync("docs/session-pool.md", "utf8"); } catch { return ""; }
}
export function poolSession(board, poolText = readPool()) {
  const head = `| ${board} | \`${SKILL_PREFIX}${board}\``;
  const row = String(poolText ?? "").split("\n").find((l) => l.startsWith(head));
  return row?.split("|")[4]?.match(/session_\w+/)?.[0] ?? null;
}

// ── 收件箱留言 → 目标塔(闸门14 记账)──────────────────────────────────────
// 留言行照收件箱模板写:`- YYYY-MM-DD HH:MM · <源> → **<目标>** · 一句话 · 路径`。认法:
//   `- ` 开头、前 120 字里有日期、日期后面「源 → 目标」;源可以是 `a + b`。源 / 目标只认 boards 里的板块。
//   目标段到第一个 ` · ` / 括号 / 冒号为止(全角半角都认):`→ ops(抄 plan)` 只算 ops —— 只抄送 = 只告知,不用它动手;
//   冒号是 `**… dev → test**:…` 那种写法要的。几个目标用 `+ / 、 ,` 隔开(逗号全角半角都认)。
//   目标是源自己(自留)、是 me(本塔 —— 多半是在记别的塔发给自己的话)、不是板块(→ 用户 / → 各塔)都不算。
// 返回每条留言一个键:目标排好序用 `+` 连起来(`dev+ops`);一个目标都不剩的留言不返回。
// 只认这种行格式。收件箱写成别的样子(每个塔一个标题、条目写在标题下)的项目,这里一条都认不出,
// 闸门14 对它是瞎的 —— 要别的塔动手的那条照这个格式补一行(tower.md〈六条协议〉第 4 条)。
// 全角标点用码位拼(fromCharCode),不直接敲进正则:源码里看不出全角半角,敲错一个就悄悄只认一种。
const FW = (...cs) => String.fromCharCode(...cs);
const TARGET_END = new RegExp(` · |[(${FW(0xFF08)}:${FW(0xFF1A)}]`);   // 目标段到这儿为止:` · ` / 左括号 / 冒号(括号、冒号全角半角都认)
const TARGET_SEP = new RegExp(`[+/,${FW(0x3001, 0xFF0C)}]`);            // 几个目标之间:加号 / 斜杠 / 半角逗号 / 顿号 / 全角逗号
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function relayKeys(text, boards, me = null) {
  const names = (boards ?? []).filter((b) => /^[a-z][a-z0-9-]*$/.test(b));
  if (!names.length) return [];
  const B = names.map(esc).join("|");
  const RELAY = new RegExp(
    `^- (?=.{0,120}?20\\d\\d-\\d\\d-\\d\\d).{0,120}?20\\d\\d-\\d\\d-\\d\\d[^→\\n]*?` +
    `(?<![A-Za-z])((?:${B})(?:[\\s*]*\\+[\\s*]*(?:${B}))*)[\\s*]*→([^\\n]*)`, "gm");
  return [...String(text ?? "").matchAll(RELAY)].map((m) => {
    const src = m[1].split("+").map((s) => s.replace(/[\s*]/g, ""));
    const seg = m[2].split(TARGET_END)[0];
    return [...new Set(seg.split(TARGET_SEP)
      .map((s) => s.replace(/[\s*`]/g, "").replace(/塔$/, ""))
      .filter((s) => names.includes(s) && !src.includes(s) && s !== me))].sort().join("+");
  }).filter(Boolean);
}

// ── transcript ─────────────────────────────────────────────────────────
// 一行一条 JSON;坏行跳过(坏一行不该让整道闸瞎掉)。整份读不了 → null(调用方放行)。
export function readTranscript(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return null; }
}
const resultText = (c) => typeof c.content === "string" ? c.content
  : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? "").join("") : "";
// 工具调用(配上结果)和 assistant 的文字,各带时刻(毫秒;条目没写时刻 = 0)。
//   calls:{ id, name, input, ts, result(结果文本;还没结果 = null), isError } · texts:{ ts, text }
export function events(entries) {
  const calls = [], texts = [], results = new Map();
  for (const e of entries ?? []) {
    const ts = Date.parse(e?.timestamp ?? "") || 0;
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    for (const c of content) {
      if (c?.type === "tool_result") results.set(c.tool_use_id, { text: resultText(c), isError: !!c.is_error });
      if (e.type === "assistant" && c?.type === "tool_use")
        calls.push({ id: c.id, name: String(c.name ?? ""), input: c.input ?? {}, ts });
      if (e.type === "assistant" && typeof c?.text === "string") texts.push({ ts, text: c.text });
    }
  }
  for (const c of calls) { const r = results.get(c.id); c.result = r ? r.text : null; c.isError = !!r?.isError; }
  return { calls, texts };
}

// ── 回执 ───────────────────────────────────────────────────────────────
// fire_trigger 的回执:{"trigger":{"id":"trig_…","persistent_session_id":"session_<X>",…},"session_id":"cse_<Y>",…}
//   —— transcript 里的那份就是这个形状 [实测✅ 2026-10,装了框架的项目实测]。
// PostToolUse 拿到的 tool_response 包成什么样,框架没实测 [未实测]:可能直接是这个对象、可能是 JSON 串、
// 可能是 MCP 的内容块数组 [{type:"text",text:"{…}"}],也可能前后夹着别的字。所以一层层拆,拆不出来 → null(调用方就不记)。
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
export function receiptOf(x, depth = 0) {
  if (x == null || depth > 6) return null;
  if (typeof x === "string") {
    let j = tryJson(x);
    if (j === null) { const i = x.indexOf("{"), k = x.lastIndexOf("}"); if (i >= 0 && k > i) j = tryJson(x.slice(i, k + 1)); }
    return j === null ? null : receiptOf(j, depth + 1);
  }
  if (Array.isArray(x)) {
    // 内容块数组:先把文字拼起来整体认(一份 JSON 被拆成几块也认得出),再逐块认
    const joined = x.map((y) => (typeof y?.text === "string" ? y.text : "")).join("");
    const r = joined ? receiptOf(joined, depth + 1) : null;
    return r ?? x.reduce((acc, y) => acc ?? receiptOf(y, depth + 1), null);
  }
  if (typeof x !== "object") return null;
  const want = x.trigger?.persistent_session_id, got = x.session_id;
  if (typeof want === "string" && want && typeof got === "string" && got)
    return { trigger: typeof x.trigger.id === "string" ? x.trigger.id : "", want, got };
  for (const k of ["content", "text", "result", "structuredContent"]) {
    const r = receiptOf(x[k], depth + 1);
    if (r) return r;
  }
  return null;
}
// create_trigger 的结果里取新门铃的 id:{"trigger":{"id":"trig_…",…}};认不出就找第一个 trig_…
export function createdId(result) {
  const id = tryJson(String(result ?? ""))?.trigger?.id;
  return typeof id === "string" && id ? id : (String(result ?? "").match(/trig_\w+/)?.[0] ?? null);
}

// ── 旗标里的回执 ────────────────────────────────────────────────────────
// guard-mcp 在 PostToolUse 记一行:`bell:<门铃 id>:<绑的会话>:<落进的会话>:<毫秒>`(两个会话都去了前缀)。
// key = 门铃 id + 毫秒,同一个门铃按两次是两条。
export function parseBells(flagText) {
  return String(flagText ?? "").split("\n").map((l) => l.match(/^bell:([\w-]+):(\w*):(\w*):(\d+)$/))
    .filter(Boolean).map((m) => ({ key: `${m[1]}:${m[4]}`, trigger: m[1], want: m[2], got: m[3], ms: Number(m[4]) }));
}

// ── 本会话按过的门铃(闸门14 核)────────────────────────────────────────────
// [{ ts, sid }](sid 去了前缀;认不出绑的是谁 = "")。三个来源并起来,哪个单独坏了都还有别的:
//   ① transcript 里没报错的 fire_trigger:绑的会话取回执里的;回执认不出,取建它的那次 create_trigger 的
//      persistent_session_id(按门铃 id 对);再对不上,取它前面最近一次建的门铃绑的会话;
//   ② 带 run_once_at / cron_expression 的 create_trigger:到点自己响,不用 fire;
//   ③ 旗标里 guard-mcp 记的回执(PostToolUse)。
// 报错的不算(往已归档的会话建门铃当场报错,platform-facts §1.1);转录里只有调用、没有结果的也不算 ——
// 「按过」要有凭据。用户拒绝、钩子拦、中断,平台都会写一条报错的结果,剩下没结果的是转录缺了那条;
// 当它按过,闸门14 就没凭据放行了(装了框架的项目审查出来的)。①② 都照这条。
// 但没结果的 create_trigger 照样更新「最近想绑谁」(last):它自己不算按过、也不进 id 对照表,
// 只给后面回执认不出、id 也对不上的那次 fire 兜底。跳过它的话,那次 fire 会落回更早一个门铃绑的会话,
// 记到旧目标头上(v0.3.2 引入的倒退,装了框架的项目审查发现)。
export function bellsOf(calls, flagText = "") {
  const out = [], made = new Map();
  let last = "";
  for (const c of calls ?? []) {
    if (c.isError) continue;
    if (isTool(c.name, "create_trigger") && c.input?.persistent_session_id) {
      const psid = String(c.input.persistent_session_id);
      last = psid;                       // 没结果也记下「想绑谁」,给后面认不出的 fire 兜底
      if (c.result === null) continue;   // 没结果:不算按过,也不进 made
      const id = createdId(c.result);
      if (id) made.set(id, psid);
      if (c.input.run_once_at || c.input.cron_expression) out.push({ ts: c.ts, sid: bareSid(psid) });
    } else if (isTool(c.name, "fire_trigger")) {
      if (c.result === null) continue;   // 没结果的 fire 不算按过
      const psid = receiptOf(c.result)?.want ?? made.get(String(c.input?.trigger_id ?? "")) ?? last;
      out.push({ ts: c.ts, sid: bareSid(psid) });
    }
  }
  for (const b of parseBells(flagText)) out.push({ ts: b.ms, sid: b.want });
  return out;
}

// ── 「不按门铃:理由」(闸门14 的放行口子)──────────────────────────────────
// 留言之后(ts > since)本会话的回复里**单独一行**以它开头,冒号全角半角都认,冒号后面要有理由。
// 返回理由(有好几行取最后一行);没有 → null。
// 只认行首:先去掉 `**`,再去掉行首的空白和列表 / 引用记号(- * + > 1.)。按任意位置认的话,
//   行中引用(「闸门14 说可以写一行『不按门铃:理由』」)也会放行,半句引文还被当成了理由。
export const RING_WAIVE_RE = new RegExp(`^不按门铃\\s*[:${FW(0xFF1A)}]`);
export const ringLine = (l) => String(l ?? "").replace(/\*\*/g, "").replace(/^\s*(?:(?:[-*+>]|\d+[.)])\s*)*/, "");
export function ringWaiver(texts, since) {
  let reason = null;
  for (const x of texts ?? []) {
    if (!(x.ts > since)) continue;
    for (const l of String(x.text ?? "").split("\n")) {
      const t = ringLine(l);
      if (!RING_WAIVE_RE.test(t)) continue;
      const r = t.replace(RING_WAIVE_RE, "").trim();
      if (r) reason = r;
    }
  }
  return reason;
}
