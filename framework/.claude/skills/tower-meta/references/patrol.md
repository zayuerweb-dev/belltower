# 巡检塔 · 每日做法

> 巡检塔(板块 `patrol`,skill `tower-patrol`)每天照这份跑。改编自一个装了框架的项目里跑了一个多月的做法;
> 那边测出来的结论,搬到你的项目里要重新验(`CLAUDE.md` 铁律3)。证据标沿用框架写法:[实测✅ 日期] / [推断] / [未实测]。

每日例程的 prompt 只写一句「照 `.claude/skills/tower-meta/references/patrol.md` 做」(外加几条别忘),做法只在这里存一份。
**这份归 meta 改** —— 定规矩归 meta,查规矩归巡检塔。巡检塔觉得哪一步不对(判据误报、步骤跑不通、早报格式不顺手)
→ 收件箱给 meta 留一行 + 按门铃,写清哪一步、现象、建议;自己不动手。

| 多久一次 | 做什么 | 在哪 |
|---|---|---|
| 每天 | 第一件 归档跑完的工人 · 第二件 昨晚定时 CI · 第五件 刹车两查 · 派回与回查 | 本页 |
| 每天(装了才做) | 第三件 跟进巡检 · 第四件 文档写法巡检 | 本页,只留挂点 |
| 每周一 | 多看三件:「又说一遍」「又答一遍」两个数 · 闸门误伤 | 本页「周一」 |
| 每月 1 号 | 深度重开各塔(巡检塔自己除外) | `tower.md`「每月深度重开」,这里不抄 |

做完报用户一张小表(本页末尾),查出来的照「归谁」派回。

---

## 开跑前

1. **同步**:`git fetch origin main && git merge --no-edit origin/main`。
   下面读台账、活表一律读 `origin/main` 的(`git show origin/main:docs/…`),不读自己分支的。
2. **浅克隆先补全历史**(已经完整的也跑得过,退出码 0):

   ```
   if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch -q --unshallow origin main; fi
   ```

   不补的话,往回数提交会停在本地最早那一版:第二件数提交区间时,上一次绿的那个 sha 可能不在本地;
   装了跟进系统的,它往回看的窗口也被截短。
   别用 `--deepen=<N>` 估一个数:提交多的项目一天就有几百笔,估的数回溯不到 24 小时 [实测✅ 2026-10,装了框架的项目实测]。
3. **核工具**:`list_sessions` · `get_session` · `archive_session` · `create_trigger` · `fire_trigger` · `list_triggers` ·
   `update_trigger` · `send_later` · `create_session`。缺哪个 → 用到它的那件今天跳过,早报写「跳过:缺 X」,收件箱给 meta 一行。
   工具在、但报「不可用」→ 照 `tower.md`「会话工具断了:自己当闹钟重试」。

---

## 第一件:把跑完、产出已安全落地的工人会话归档掉

工人收完活,派它的塔就该当场归档(`dispatch.md` §6);这一件是兜底 —— 靠塔记得 = 必漏,侧栏会越积越长,容器也不释放。

**五条判据全中才动,缺一条就跳过**:

1. **是工人不是塔。** 先排除塔:`tags` 里有单独一个 `tower` 的,或会话 ID 就在 `origin/main` 活表塔表里的 ——
   **是塔,永远不许动**(巡检塔自己也在里面)。剩下的,`tags` 含 `worker`,或 `parent_session_id` 是活表塔表里某个塔的会话,才算工人。
   - 为什么先排除塔:代开的塔都是巡检塔开的(`tower.md`「谁来开塔:巡检塔是根」),它们的 `parent_session_id` 就是巡检塔 ——
     只看父会话,塔会被当成工人。
   - 项目自己给工人打的别的标(比如按塔名打的标),写进这一条才算数。
   - *出处:装了框架的项目里,有个塔派工人只打了自己的标、没打 `worker`,只认 `worker` 的判据永远不中,
     那批工人一直没人收 [实测✅ 2026-10]。所以加了「父会话是塔」这一路。*
   - **`tags` 里有 `keep` 或 `intake` 的,跳过** —— 那是塔要留着复用的会话(比如靠门铃反复叫醒同一个工人、
     或专门收件的会话),闲多久都不归档。标是派它的塔打的(`set_session_tags`),不再用了由那个塔自己摘标、自己归档。
     *出处:一个项目用门铃复用工人,闲过 24 小时就会被每日归档收走 —— 下一铃再按就进了只读会话。*
2. 状态**不是** `RUNNING`,也不是已经 `ARCHIVED`。
3. `updated_at` 距现在 **≥ 24 小时** —— 给派它的塔留一天收活。
4. **产出已在远端**:分支名先看 `session_context.outcomes`,**空的再看 `external_metadata.current_branches`** ——
   工人的 `outcomes` 常常是空的,分支只记在后者里 [实测✅ 2026-10,装了框架的项目实测;见 `platform-facts.md` §1.4]。
   拿到的分支名跑 `git ls-remote --heads origin <分支>`,**查到才算**;两处都没有分支(或只有 `main`)才算「压根没有分支」、通过。
   只看 `outcomes` 的话,没推的工人会被当成「没有分支」放过去,一归档就丢了。
5. **是本仓库的会话**:`session_context.sources` 里的仓库地址含本仓库的 `<owner>/<repo>` ——
   取 `.claude/belltower.json` 的 `repo`,空着就从 `git remote get-url origin` 现解析;**比时忽略大小写**(有的地址写成全小写)。
   为什么要这条:`mine: true` 会把用户别的项目的会话也列进来 [实测✅ 2026-10,装了框架的项目实测]。

**三条绝不**:
- 绝不删除,只用 `archive_session`(「不认工人自述、要能回查」,转录必须留)。
- 绝不动塔。
- 绝不动 `RUNNING` 的(**归档会释放容器,没 push 的东西就没了**)。

**步骤**:
1. `list_sessions`(`mine: true, limit: 100`),把上一页的 `last_id` 当 `after_id` 往后翻,**翻到 `has_more` 为 false**。
   只拿第一页会漏:新会话排在前面,闲够 24 小时的工人都在后面几页
   [实测✅ 2026-10,装了框架的项目实测:第一页三十个全是前一晚之后建的,翻了四页、两百多个才扫全]。
2. 先拿列表判 1–3 筛出候选;**候选逐个 `get_session`**,用它回的 `session_context` 判 4、5 ——
   列表行不带 `session_context` [实测✅ 2026-10,装了框架的项目实测]。全中的 `archive_session`。
   `session_context` 还是读不到就跳过、早报里记一句,别当通过。
3. 真归档了才记账:`docs/journal.md` 追一行(`- <日期> <时刻> · patrol · 每日归档 · 归档 N 个工人:…`)
   → `node scripts/ledger-push.mjs "每日归档:归档 N 个工人"`。

被归档的工人要是还在 `origin/main` 活表的任务会话表里挂着行,**并进给派它的塔那一行收件箱留言**(见「派回的规矩」)。
不要替它删行 —— 派发权归执行方。

---

## 第二件:昨晚定时跑的 CI

**项目有定时跑的 CI 才做**:`.github/workflows/` 里有带 `schedule:` 的 workflow。没有就跳过,早报写一句「昨晚 CI:没有定时跑的 CI,跳过」。

```
git grep -lE '^[[:space:]]*schedule:|^[^#]*[{,][[:space:]]*schedule:' origin/main -- .github/workflows/
```

只认真写成键的:块写法(行首缩进后是 `schedule:`)和行内写法(`on: { schedule: … }`);只在注释里提到 `schedule:` 的不算。
*出处:装了框架的项目里,一个工作流的注释写着「为什么没有 `schedule:`」,裸 `git grep 'schedule:'` 把它认成有定时 CI,
照下面的查法天天报「没跑」[实测✅ 2026-11-04:注释 / 块写法 / 行内写法三种,这条命令只认后两种]。*

定时 CI 是独立裁判:不管各塔怎么说,它按点在 `main` 上从头跑一遍。没人看结果,红了也没人知道,等于白跑。

**GitHub 的定时会晚排**:晚半小时是常态,实测最多晚了约 7.5 小时 [实测✅ 2026-10,装了框架的项目实测]。
下面「看哪几次」就是为这个写的。

**查法**。仓库取 `.claude/belltower.json` 的 `repo`(`<owner>/<repo>`;空着就从 `git remote get-url origin` 现解析)。优先用 GitHub MCP:

- 最近几次定时 run:`mcp__github__actions_list`,`method: "list_workflow_runs"`,
  `workflow_runs_filter: { event: "schedule", branch: "main" }`,`perPage: 5`(`resource_id` 填 workflow 文件名就只看那一个)。
- 某次 run 的各个 job:`mcp__github__actions_list`,`method: "list_workflow_jobs"`,`resource_id: <run id>` ——
  看每个 job 的 `conclusion`、`steps` 有几步。
- 单看一次 run:`mcp__github__actions_get`,`method: "get_workflow_run"`,`resource_id: <run id>`。
- workflow 停用没有:`mcp__github__actions_list`,`method: "list_workflows"`,看 `state`。

云会话里 MCP 服务器的名字常是一串 UUID,工具名前缀不一定是 `mcp__github__`,按后半截认。
MCP 用不了就用 `gh api`(`gh --jq` 不支持 `--arg`,要拼变量就在 shell 里拼):

```
gh api 'repos/<owner>/<repo>/actions/runs?event=schedule&branch=main&per_page=5' \
  --jq '.workflow_runs[] | [.id,.created_at,.updated_at,.status,.conclusion,.head_sha[:7],.html_url] | @tsv'
gh api repos/<owner>/<repo>/actions/runs/<run id>/jobs --jq '.jobs[] | [.name,.conclusion,(.steps|length)] | @tsv'
gh api repos/<owner>/<repo>/actions/workflows --jq '.workflows[] | [.name,.state] | @tsv'
```

**看哪几次 —— 两件事分开查**:

1. **要报的结果** = `status` 是 `completed`、且 `updated_at`(跑完的时刻)落在**过去 24 小时内**的定时 run,
   也就是上一份早报之后才跑完的。**每次 run 只在它跑完后的第一份早报里报一次。**
   通常就今天这一次;GitHub 晚排时会多一次前一天晚到的,**也要报**(写明晚了几小时)。
   每次都判成下面四态之一,早报以最新那次定红绿。
2. **最近该排的那次排出来没有** = 照 workflow 里的 cron(按 UTC)算出最近一次该排的时刻,看有没有 `created_at` 在它之后的定时 run。
   没有 → 走「— 没跑」;有但 `status` 还不是 `completed` → 报「在跑,明早报结果」(它跑完后自然落进明天的 24 小时窗)。

*为什么这么取 —— 装了框架的项目踩过两回 [实测✅ 2026-10]:
① 最早取「最近 26 小时内最新的那次」。有一天早报时当天的 run 还没排出来,前一晚那次离早报 25 个多小时,正好落进窗口 ——
把前一晚的当成了昨晚的,前一晚要是绿的就成了假绿。
② 当天改成「只认今天排定时刻之后建的」,结果那天的 run 晚了 7 个多小时才建、早报之后才出现,按这条它永远不会被报,红了也漏。
现在按「跑完的时刻在过去 24 小时内」取:旧的自然出窗,晚到的下一份早报补上。*

**判成四种之一**:

- **— 没跑**:最近该排的那次之后没有定时 run。按顺序查:
  1. `git show origin/main:.github/workflows/<文件>` 里还有没有 `schedule:`。没有 = 定时配置被改掉了,如实报。
  2. 有的话,查 workflow 停用没有(`list_workflows` 的 `state`)。不是 `active` 就报出来。
  3. 都正常:先当**晚排**,报「到早报时还没排出来,明早补报」;**连着两份早报都没等到**这一次,才算 GitHub 没触发,如实报。
  - **别自己补跑**:云会话触发不了 `workflow_dispatch`(`platform-facts.md` §5.10)。要补跑,早报里请用户在 GitHub 的 Actions 页手点。
- **⏸ 被额度拦了**:`conclusion` 是 `failure`,而且**每个 job 的 `steps` 都是 0**(没分到机器)[实测✅ 2026-10,装了框架的项目实测]。
  Actions 分钟数用完就是这样。加不加钱、等不等重置归用户定:早报一句话带过,不写 journal、不按门铃。
- **✅ 绿**:`conclusion` 是 `success`。附上 run 链接和那次的短 sha。
- **❌ 红**:有 job 真跑了(`steps` > 0)且失败。三件事:
  1. 点名哪个 job、哪一步挂的,附 run 链接。
  2. 写清提交区间:上一次绿的定时 run 的 `head_sha` 到这次的 `head_sha`,`git log --oneline <旧>..<新>` 数出几笔、各是哪个塔的提交。
  3. `docs/journal.md` 追一行,并且**给 dev 留言 + 按门铃告知**(没开 dev 塔就给管 CI 的那个塔)。
     照「派回的规矩」:这一下就是 dev 当天那一个门铃,跟别的给 dev 的项并成一行。
     - 门铃正文以「【告知,不是派活 —— 来自巡检塔早报】」开头,写 job、run 链接、提交区间。
     - **同一处红已经告知过**(上次告知后没绿过、挂的还是同一个 job)就不再按,早报写「仍红,第 N 天,<日期> 已告知 dev」。

---

## 第三件:跟进巡检 —— 挂点

**装了跟进系统才做**(用户的话落盘、登记、每天对一次账的那一套,框架后续版本才有);没装就跳过,早报不写这一行。
装了的照它自己的说明跑:只把例外报给用户,查出来的照「派回的规矩」派回,巡检塔一条不修。

## 第四件:文档写法巡检 —— 挂点

**装了文档写法检查才做**(框架后续版本才有);没装就跳过,早报不写这一行。
装了的照它的说明跑,例外照「归谁」并进那个塔当天那一行;巡检塔不改文档。

## 第五件:刹车两查

规矩见 `dispatch.md` §12「刹车」:轻缺陷攒批、同一家封顶几轮、推断会改行为的等用户。闸门17 只在派工那一刻拦,
**攒着没人修的**和**已经冲过上限合进去的**它看不见,这两样每天查一次。在仓库根跑(开跑前已经同步过 `origin/main`),输出原样贴进早报:

- **(a) 〔攒批〕开了超 48 小时** → 派回 dev(照「派回的规矩」并进 dev 当天那一行,每条带 `BACKLOG:<行号>` 当键):

```
node scripts/brake.mjs batch --older 48
```

- **(b) 过去 24 小时合进的交付里,轮次超过上限的家** → 报用户(这是「环里没停住」,归用户拍板,不派回):

```
node scripts/brake.mjs over --hours 24
```

两条都读 `origin/main`、不 fetch;退出码 0,查出东西也是 0。(b) 只按基号认家,不认任务书里的「返工自」(任务书不在 git 历史里)。
两条命令在框架自己的测试里原样抠出来、拿样例台账跑过(belltower 仓库的 `scripts/test.mjs`,假时钟钉住「现在」)。

---

## 派回的规矩

查出来的不自己修,派回给该管的塔。状态从台账现推,不另存一份。

1. **每个塔每天最多一行收件箱留言 + 一个门铃。** 那个塔当天新查出的全列在这一行里(CI 红也并进 dev 那一行)。
2. **留言格式**(写进 `docs/BACKLOG.md` 收件箱):

   ```
   - <日期> <时刻> patrol → <塔> · 巡检 · <项> … · <项> …
   ```

   每一项带一个**稳定的键**:项名 + `文件:行`,或单号 / PR 号 / run 链接。
   第二天靠这个键在 `origin/main` 的 `docs/BACKLOG.md` 里找回「哪天派过」。
3. **门铃**:`create_trigger`(`persistent_session_id` = `origin/main` 活表里那个塔「会话 ID」格写的 ID,**每次现查,别写死**;
   不给 cron 也不给 `run_once_at`)→ `fire_trigger`。要说的话全写进 `prompt`,`fire_trigger` **不带 `text`**(`platform-facts.md` §1.1)。
   - **送达要核**:回执里的 `cse_<Y>` 去掉前缀,跟目标 `session_<X>` 去掉前缀相等,才算送到。
     往已归档的会话按会当场报错;对方正忙时消息排队,不算没送到(`tower.md`「平台事实」门铃那几条)。
   - **门铃一次一个,别重按旧的** —— 同一个门铃按第二次会掉进新开的空会话。
   - 门铃正文末句:「修不修、怎么修、立不立号你定;改了在收件箱回一行,不改写理由」。
     **一次一轮,别跟对方来回** —— 夜里没人看着,来回转起来停不下。
4. **已经派过、对方还没改的,不再按门铃。** 从第一次派回那天起数,连着 3 份早报还在 → 早报「拖着的」一行报用户「拖了 N 天」(仍不按门铃)。
5. **只是告知、不用对方动手的,不按门铃**,回复里写「不按门铃:理由」。
   收尾的闸门14 认这一句:回复里单独一行以「不按门铃:」开头、后面写了理由,那条留言就放行。
6. **先留痕,后叫人**:留言写完 → `node scripts/ledger-push.mjs "巡检:派回 …"` → 再按门铃。

---

## 周一

- **(a)「又说一遍」次数**:用户原话里带「又忘了 / 我说过 / 再说一遍 / 怎么还是 / 为什么没 / 还是忘」的条数,本周(今天往前 7 天)对上周(再往前 7 天),
  按原话的日期算。原话由 `scripts/user-quotes.mjs` 从 `origin/main` 的台账现抽。在仓库根跑,输出原样贴进早报:

```
node scripts/user-quotes.mjs --json | node -e '
const fs = require("fs");
// 日子按项目时区算:读 .claude/belltower.json 的 timezone,读不到用 America/New_York(跟 config.mjs 的默认值一致)
let tz = "America/New_York";
try {
  const z = JSON.parse(fs.readFileSync(".claude/belltower.json", "utf8")).timezone;
  if (typeof z === "string" && z) { new Intl.DateTimeFormat("en-CA", { timeZone: z }); tz = z; }
} catch {}
// 今天(项目时区)往前数 n 天:按日历减,夏令时切换那天也不会差一天
const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());   // YYYY-MM-DD
const day = (n) => new Date(Date.parse(today + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
const re = /又忘了|我说过|再说一遍|怎么还是|为什么没|还是忘/;
const hit = JSON.parse(fs.readFileSync(0, "utf8")).quotes.filter((q) => re.test(q.text));
const pick = (a, b) => hit.filter((q) => q.date && q.date >= a && q.date <= b);
console.log(`又说一遍 · 本周 ${day(6)} 至 ${day(0)} · ${pick(day(6), day(0)).length} 条 · 上周 ${day(13)} 至 ${day(7)} · ${pick(day(13), day(7)).length} 条 · 没日期的 ${hit.filter((q) => !q.date).length} 条`);
for (const q of pick(day(6), day(0))) console.log(`  ${q.date} ${q.time ?? ""} ${q.tower ?? "?"} 「${q.text}」 ${q.sources.map((s) => s.path + ":" + s.line).join(" ")}`);
'
```

- **(a′)「又答一遍」次数**:用户把定过的事又答了一遍 —— 收到答复的塔核出「跟已定的一样」时,规格不改,journal 那行写
  `〔重申〕(原出处:…)`(`CLAUDE.md`〈板块路由〉顾问姿态「问之前先查已定的」)。本周对上周,按 journal 行首的日期算。
  **只数带「(原出处」的写法** —— 讲这个标记本身的行(比如「〔重申〕标照办」)不算;括号半角 / 全角都认:

```
git show origin/main:docs/journal.md | node -e '
const fs = require("fs");
// 日子按项目时区算:读 .claude/belltower.json 的 timezone,读不到用 America/New_York(跟 config.mjs 的默认值一致)
let tz = "America/New_York";
try {
  const z = JSON.parse(fs.readFileSync(".claude/belltower.json", "utf8")).timezone;
  if (typeof z === "string" && z) { new Intl.DateTimeFormat("en-CA", { timeZone: z }); tz = z; }
} catch {}
const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());   // YYYY-MM-DD
const day = (n) => new Date(Date.parse(today + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
// 全角括号写成 \uFF08:手打的「全角」常常其实是半角,写码位才保得住
const re = /〔重申〕[(\uFF08]原出处/;
const hit = fs.readFileSync(0, "utf8").split("\n").filter((l) => re.test(l))
  .map((l) => ({ d: (l.match(/^[\s>*-]*(20\d\d-\d\d-\d\d)/) || [])[1] || "", l: l.trim() }));
const pick = (a, b) => hit.filter((h) => h.d && h.d >= a && h.d <= b);
console.log(`又答一遍 · 本周 ${day(6)} 至 ${day(0)} · ${pick(day(6), day(0)).length} 条 · 上周 ${day(13)} 至 ${day(7)} · ${pick(day(13), day(7)).length} 条 · 行首没日期的 ${hit.filter((h) => !h.d).length} 条`);
for (const h of pick(day(6), day(0))) console.log("  " + h.l.slice(0, 200));
'
```

两个数是给架构找没接上的环,不是记谁抱怨;基线是本周,应往下走。(a′) 不为零,早报里把那几行的原出处列出来 ——
哪件事、原来定在哪,那是塔问之前没查到的地方。
两条命令在框架自己的测试里拿样例台账跑(belltower 仓库的 `scripts/test.mjs`,假时钟钉住「今天」):
时区读配置、读不到或写坏了用默认值、只数「(原出处」写法、半角 / 全角括号、夏令时切换那天不差一天。

- **(b) 闸门误伤**:`docs/gate-log.md` 过去 7 天按闸门计数,其中「冤」几条、「待判」几条。在仓库根跑,读 `origin/main`,输出原样贴进早报:

```
git show origin/main:docs/gate-log.md | node -e '
const fs = require("fs");
// 日子按项目时区算:读 .claude/belltower.json 的 timezone,读不到用 America/New_York(跟 config.mjs 的默认值一致)
let tz = "America/New_York";
try {
  const z = JSON.parse(fs.readFileSync(".claude/belltower.json", "utf8")).timezone;
  if (typeof z === "string" && z) { new Intl.DateTimeFormat("en-CA", { timeZone: z }); tz = z; }
} catch {}
const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);   // YYYY-MM-DD
const from = day(new Date(Date.now() - 6 * 864e5));
const m = {};
for (const l of fs.readFileSync(0, "utf8").split("\n")) {
  // 列序照模板:| 日期 | 闸门 | 触发内容 | 冤枉吗 | 处置 |。触发内容里的竖线记成 \|,切列时跳过它
  const c = l.split(/(?<!\\)\|/).map((s) => s.trim());
  if (!/^20\d\d-\d\d-\d\d/.test(c[1] || "") || c[1].slice(0, 10) < from) continue;
  const g = c[2] || "?", v = c[4] || "";
  m[g] ??= { n: 0, w: 0, p: 0 };
  m[g].n++;
  if (/冤/.test(v) && !/不冤/.test(v)) m[g].w++;
  else if (/待判/.test(v)) m[g].p++;
}
const e = Object.entries(m).sort((a, b) => b[1].n - a[1].n);
const sum = (k) => e.reduce((s, [, v]) => s + v[k], 0);
console.log(`闸门 · ${from} 起 · ${sum("n")} 次 · 冤 ${sum("w")} · 待判 ${sum("p")}`);
for (const [g, v] of e) console.log(`  ${g} · ${v.n} 次 · 冤 ${v.w} · 待判 ${v.p}`);
'
```

冤的给 meta 留一行(调判据归 meta),待判的条数一并写上;只告知、不按门铃。
命令拿模板列序的样例账跑过,含触发内容里带 `\|` 的行、项目时区跨天、`belltower.json` 缺 `timezone` 三种 [实测✅ 2026-11-03]。

---

## 每月 1 号

照 `tower.md`「每月深度重开」一节做,这里不抄。
巡检塔自己不在名单里 —— 它是开塔的根,不重开、不归档(`tower.md`「谁来开塔:巡检塔是根」)。

---

## 跑完必须报给用户:一张小表

用户看不见后台,**没事也报** —— 沉默会被当成「没在跑」。

```
巡检塔早报 · <日期>
扫了 N 个会话 · 归档 M 个 · 跳过 K 个
归档:Q3xx 某某任务(闲了 31 小时,分支在远端)· …
跳过:Q4xx(还在跑)· Q1xx(闲了 6 小时,不够 24)· …
昨晚 CI:✅ 绿(main <短 sha>,run 链接)/ ❌ 红(<job> · <哪一步>,自 <短 sha> 起 5 笔,已告知 dev)/ ⏸ 被额度拦了 / — 没跑(原因)/ 在跑(明早报)/ 没有定时跑的 CI,跳过
  (有前一天晚到的那次就补一句:「前一天那次晚了 X 小时才跑,结果 …」)
跟进巡检:……(装了跟进系统才有这一行)
文档写法:……(装了文档写法检查才有这一行)
刹车:〔攒批〕超 48 小时 n 条(已派回 dev)· 过去 24 小时超上限 m 笔(<号 · 第几轮>)/ 都没有
派回:product 2 条、meta 1 条 · 按了 2 个门铃(不按门铃:meta 那条只是告知)
拖着的:无 / <键> 拖了 N 天(<塔>)· …
(周一)闸门误伤:过去 7 天 n 次 · 冤 k · 待判 p(已告知 meta)
(周一)又说一遍:本周 a 条 · 上周 b 条 · 又答一遍:本周 c 条 · 上周 d 条(不为零的列出那几句 / 原出处)
跳过:缺 X(用到它的那件今天没做)
```

- **归档 0 个也要报**,写「今天没有够条件的,N 个工人里 K 个还在跑 / K 个不够 24 小时」。
- 一句话就够,别写长。
- **journal 只在有事时写**:真归档了、CI 红了、派回了(装了跟进 / 文档写法检查的,它们查出例外也算),`patrol` 打头;
  归档 0 个、CI 不红,不留台账噪音。但**跟用户的话每天都要说**。
- 缺工具跳过的那件,写「跳过:缺 X」(见「开跑前」第 3 条)。

> **为什么例程绑在巡检塔身上,而不是每天开个新会话**:`create_trigger` 的「开新会话」模式开出来的会话身上**没有仓库**
> (`session_context` 里没有 `sources`,`create_trigger` 也没有传仓库的参数),它 `git fetch` 不了、写不了台账 [实测✅ 2026-09-15]。
> 绑到已有的塔才有仓库,所以每日、每月两条例程都绑在巡检塔上。
> 巡检塔不重开、不归档,绑定不会烂;万一它的会话没了,用户在侧栏开一个新的,新巡检塔第一轮把绑在旧 ID 上的例程改绑到自己身上
> (`tower.md`「谁来开塔:巡检塔是根」)。
