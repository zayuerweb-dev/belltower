# belltower

A harness built on Claude Code for running one project with many sessions. Each area of the project gets a long-lived **tower** session. Towers wake each other with a **doorbell** and hand off through a shared **git ledger**. The finished work is done by short-lived **workers** that a tower dispatches. **Gates** (hooks) stop the mistakes that kept coming back.

[English](#english) · [中文](#中文)

---

## English

### Why this exists

belltower grew out of one person running a whole project (product, code, operations, business) with Claude Code. That person only knows one or two of those jobs well. Doing it all in one long session broke in the same ways again and again:

- **The context gets fat.** Every turn re-reads everything said so far, so each step costs more than the last. A session that has been auto-compacted a few times starts to drift. In one case a tower forgot it was a tower and did the work itself for two weeks.
- **Sessions report what they meant to do, not what they did.** "Merged" turned out to be "opened a PR". "Done" turned out to be "not pushed".
- **Chat is not memory.** A decision made in one window is invisible to the next. Anything that depends on someone remembering the second half of a step eventually gets skipped.
- **The user became a messenger** who carried words between windows and signed off on things they couldn't judge.

So the harness splits the project by function, and it keeps the parts in sync with a few habits:
- every handoff goes through files in git;
- the heavy work goes to throwaway sessions;
- anything that must happen every time is a gate;
- the user approves decisions and stops relaying messages.

Every rule here comes with the lesson that produced it (`docs/principles.md`). Every platform claim is either marked tested with a date, or marked untested (`docs/platform-facts.md`).

### What's in the box

| Piece | What it does |
|---|---|
| **Towers** | One long-lived session per area. A tower discusses, decides, dispatches and reviews. It does not do the finished work itself. |
| **Workers** | Short-lived sessions a tower spawns for one numbered task. They push a branch or open a PR, and are archived once done. |
| **Doorbell** | A trigger bound to another session. Firing it wakes that session within seconds, across repos too (same account). The message only says "go read the ledger"; the details live in git. |
| **Ledger** | Four markdown files on `main`: `docs/BACKLOG.md`, `docs/journal.md`, `docs/session-pool.md` and `docs/gate-log.md`. `scripts/ledger-push.mjs` pushes them straight to `main`, and falls back to a PR when branch protection blocks the push. |
| **Gates** | Claude Code hooks (`.claude/hooks/`) that stop the known failure modes. Examples: sensitive data copied into the repo, a tower creating a task no user asked for, a "merged" claim not found on `main`, a ledger left on a branch, a context past its budget. Every gate fails open. |
| **Routines** | Prompts for a daily worker cleanup, a weekly deep restart, and a 10-minute check-in after dispatching (`docs/routines.md`). |

### The eight towers

Each tower is one skill file, `.claude/skills/tower-<board>/SKILL.md` (templates in `framework/.claude/skills/`). The file says what the board owns, what it doesn't, and what it must ask the user. A board can exist as a skill without a running tower. Open a tower only when there is material and ongoing discussion.

| Board | Owns |
|---|---|
| `plan` | Roadmap, milestones, scope and effort trade-offs, proposals, pricing strategy, priorities |
| `product` | Who the users are, what to build, what it looks like, when it's done: interviews, specs, wireframes, acceptance criteria, metrics |
| `dev` | Building the product. No spec, no start |
| `data` | Validation data, gold sets, regression, migration checks, cost measurements |
| `test` | Accepting what dev delivers: runs it, clicks it, reports bugs with repro steps. Writes no product code |
| `ops` | Running *our* product in production: deploys, backup and restore drills, monitoring, secrets, cutover |
| `biz` | Sales, customer success, contracts and billing, company affairs |
| `meta` | The session machine itself: context economy, dispatch, the ledger, gates, tower protocol, toolboxes |

### Presets

Not every project needs eight towers. `--preset` installs only the boards a project type needs, and fills in when to open each tower (see `presets.json`):

| Preset | Boards | For |
|---|---|---|
| `web-product` | plan · product · biz · meta · dev · data · test · ops | Web product you sell |
| `web-app` | product · meta · dev · test · ops | Web app for your own use |
| `devtool` | plan · meta · dev · test | Developer tool or library |
| `minimal` | meta · dev | Minimal |

Boards are listed in the order you usually open them. For `web-product`: plan, product, biz and meta first; dev after the spec review; data alongside dev; test split off from dev once there is real code; ops before the first launch.

### Context economy

A tower lives for weeks, so what sits in its context is the main cost. The harness attacks it in layers:

1. **Towers talk, workers work.** A task that would burn hundreds of thousands of tokens runs in a worker. Only the result comes back to the tower.
2. **Six habits** (`tower-meta`): no images in the main session; no full reads of big files (grep a slice); truncate long output; don't re-read; one session, one task; write to disk before compaction.
3. **Earlier auto-compaction.** The framework `.claude/settings.json` sets `"autoCompactWindow": 300000`. It must be a number: a string like `"150k"` is silently ignored.
4. **Gate 9** reads the real context size from the transcript and asks the tower to save its state to disk at 70%.
5. **Weekly deep restart.** Once a week, each busy tower hands off to the ledger, is archived, and reopens fresh. This clears the drift that builds up in compaction summaries.

What is and isn't proven (details in `docs/platform-facts.md` §3 and `tower.md`):
- **Tested** (2026-09-24/25):
  - the compaction setting takes effect, and old sessions switch over after their next wake-up or compaction;
  - the gate's context measure is within 2% of what the platform reports;
  - reopening a tower costs about $0.6 and ~100k tokens of starting context.
- **Not measured:** the total saving from all of this compared with a harness that doesn't use it. Nobody has run that comparison yet.

### Install into a project

```bash
git clone https://github.com/zayuerweb-dev/belltower
node belltower/scripts/belltower-init.mjs path/to/your-project --preset web-app   # omit --preset for all eight
cd path/to/your-project
$EDITOR .claude/belltower.json      # repo, codeDirs, sensitivePaths, timezone
node scripts/test-hooks.mjs         # must be green
```

`--preset` with no value lists the presets. Then fill the `<!-- 项目填写 -->` placeholders in `CLAUDE.md` and in each `.claude/skills/tower-*/SKILL.md`.

### Update later

```bash
node scripts/belltower-sync.mjs --ref v0.2.0            # dry run: lists what would change
node scripts/belltower-sync.mjs --ref v0.2.0 --apply    # write, then re-run the tests
```

`belltower.manifest.json` splits the files into two groups:
- **framework** files (hooks, settings, ledger script, tests, tower/dispatch references) are overwritten by sync;
- **init** files (your `CLAUDE.md`, `belltower.json`, the four ledgers, board skills, frozen list) are copied once and never touched again.

### Configuration (`.claude/belltower.json`)

| Key | Default | Used by |
|---|---|---|
| `project` | repo dir name | session-start banner |
| `repo` | parsed from `origin` | ledger-push PR hint |
| `codeDirs` / `codeExt` | `["src"]` / py ts tsx js jsx sql | code count at session start; gate 6 (tests before stop); gate 11 (code PR) |
| `boards` | the eight above, or the preset's | identity check (session ID ↔ pool row `tower-<board>`) |
| `ranges` | `Q1xx` … `Q8xx` | shown when a tower is recognized |
| `sensitivePaths.bash` / `.edit` | `sensitive/`, `private-data/`, key files | gates 1–3; empty string turns a gate off |
| `sensitiveReminder` | iron rule 1 | session-start banner |
| `timezone` | `America/New_York` | every timestamp |

The skill prefix is fixed at `tower-`.

### Docs

The protocol docs are written in Chinese:
- `docs/principles.md`: the principles behind the rules, each with its lesson;
- `docs/architecture.md`: boards, handoffs, towers vs workers, toolboxes;
- `docs/platform-facts.md`: what the platform can and cannot do, each item marked tested or untested;
- `docs/routines.md`: routine prompts;
- `docs/testing.md`: tests and mutation checks;
- `docs/vendor-skills.md`: pulling third-party skills;
- `framework/.claude/skills/tower-meta/references/`: `tower.md` (how a tower runs) and `dispatch.md` (how to dispatch a worker).

### Requirements

Node 18+ and git. It is built for Claude Code cloud sessions with the remote-session MCP tools (`create_session`, `create_trigger`, `send_later`…). The hooks also run locally, but the doorbell and workers need the cloud tools.

### License

MIT — see `LICENSE`.

---

## 中文

**belltower** 是一套跑在 Claude Code 上的多会话协作框架:项目的每个职能一个**常驻塔**(长寿会话),
塔之间**按门铃**叫醒对方,细节写在**共享的 git 台账**里;成品活**派短命工人**去做;反复出过的错由**闸门**(hook)拦。

### 为什么做这个

起因是一个人用 Claude Code 把一整个项目跑起来:产品、代码、运维、生意都要做,可这个人真正懂的只有其中一两样。
全塞在一个长会话里,同样几个问题反复出现:

- **上下文越来越胖。** 每一轮都要把之前说过的全部重读一遍,越往后每一步越贵。自动压缩几次之后,会话开始跑偏:
  有一个塔压着压着忘了自己是塔,自己埋头干活干了两周。
- **会话报的是「打算做的」,不是「做了的」。** 说「合了」,其实只开了 PR;说「完成」,其实没推。
- **聊天不是记忆。** 一个窗口里定的事,另一个窗口看不见。凡是靠人记得做「后半步」的,早晚会漏。
- **用户成了传话筒。** 在窗口之间搬话,还得替自己不懂的职能签字。

所以框架按职能把项目拆开,再靠几条做法把各部分接起来:
- 交接一律走 git 里的文件;
- 重活派给用完即走的工人;
- 「必须每次发生」的写成闸门;
- 用户只在该拍板的地方拍板,不再当传话筒。

每条规矩都附着它的来历(`docs/principles.md`);每条平台行为要么标了实测日期,要么标 [未实测](`docs/platform-facts.md`)。

### 有什么

| 部件 | 做什么 |
|---|---|
| **塔** | 每个职能一个常驻会话:讨论、拍板、派活、收活;成品活不自己干 |
| **工人** | 塔为一个编号任务开的短命会话:推分支或开 PR,干完归档 |
| **门铃** | 绑在另一个会话上的触发器,按一下几秒内叫醒对方,跨仓库也通(同一账号)。消息只说「去读台账」,细节在 git 里 |
| **台账** | `main` 上四份 markdown:`docs/BACKLOG.md` · `docs/journal.md` · `docs/session-pool.md` · `docs/gate-log.md`;`scripts/ledger-push.mjs` 直推 `main`,被分支保护挡住时自动转 PR |
| **闸门** | `.claude/hooks/` 里的 hook,拦已知的坑:敏感数据进库、塔自己立了用户没说过的号、「已合」在 `main` 上查不到、台账停在分支上、上下文超预算……全部 fail-open |
| **例程** | 每日清理工人、每周深度重开、派工后 10 分钟回查的提示词(`docs/routines.md`) |

### 八个塔

每个塔就是一份 skill 文件 `.claude/skills/tower-<板块>/SKILL.md`(模板在 `framework/.claude/skills/`),
写着这个板块管什么、不管什么、要问用户什么。**板块可以只有 skill 没有塔** —— 有材料、有持续讨论才开塔。

| 板块 | 管什么 |
|---|---|
| `plan` | 路线图、里程碑、范围与工时取舍、提案、定价策略、优先级 |
| `product` | 用户是谁、做什么、长什么样、算不算做完:访谈、规格、线框、验收标准、指标 |
| `dev` | 建产品本身;没有规格不开工 |
| `data` | 验证数据、gold set、回归、迁移校验、成本实测 |
| `test` | 验收 dev 交的东西:自己起服务、自己点、报缺陷带复现;不写业务代码 |
| `ops` | **我们自己的产品**怎么跑在线上:部署、备份恢复演练、监控、密钥、切换 |
| `biz` | 销售、客户成功、合同与计费、公司事务 |
| `meta` | 会话这台机器本身:上下文经济、派发、台账、闸门、塔协议、各塔工具箱 |

### 预设

不是每个项目都要八个塔。`--preset` 按项目类型只装用得到的板块,并把每个塔「什么时候开」填好(定义在 `presets.json`):

| 预设 | 板块 | 适合 |
|---|---|---|
| `web-product` | plan · product · biz · meta · dev · data · test · ops | 网页产品(要卖) |
| `web-app` | product · meta · dev · test · ops | 网页应用(自用) |
| `devtool` | plan · meta · dev · test | 开发工具或库 |
| `minimal` | meta · dev | 最小 |

板块按通常的开塔顺序排。以 `web-product` 为例:plan、product、biz、meta 先开;规格评审过了开 dev;
data 跟着 dev 开;代码量上来后从 dev 拆出 test;第一次上线前开 ops。

### 上下文经济

塔一活就是几周,上下文里装着什么就是主要成本。框架分几层压它:

1. **塔讨论,工人干活。** 会烧掉几十万 token 的活派工人做,塔只收结果。
2. **六条习惯**(`tower-meta`):图不进主会话 · 大文件不全读(grep 切片)· 长输出必截 · 读过不重读 · 一会话一任务 · 落盘先于压缩。
3. **提前自动压缩。** 框架的 `.claude/settings.json` 设了 `"autoCompactWindow": 300000`。**必须写数字**,写成字符串 `"150k"` 会被静默忽略。
4. **闸门9** 从转录里读出真实的上下文用量,到 70% 提醒塔先落盘。
5. **每周深度重开。** 每周一次,有动静的塔先把手上的事交接进台账,再归档,然后重新开一个。
   这一步清掉压缩摘要里慢慢攒下的偏差。

哪些证实了、哪些没有(细节见 `docs/platform-facts.md` §3 和 `tower.md`):
- **实测过**(2026-09-24/25):
  - 压缩设置真的生效,老会话在下一次被叫醒或压缩后切过去;
  - 闸门9 量的上下文跟平台报的差 2% 以内;
  - 重开一个塔约 $0.6,开局占上下文约 10 万。
- **没量过**:把这些做法全用上,跟不用相比总共省了多少。这个对照还没人做过。

### 装进项目

```bash
git clone https://github.com/zayuerweb-dev/belltower
node belltower/scripts/belltower-init.mjs 你的项目目录 --preset web-app   # 不加 --preset = 八个全装
cd 你的项目目录
# 改 .claude/belltower.json:仓库名、代码目录、敏感路径、时区
node scripts/test-hooks.mjs   # 必须全绿
```

`--preset` 不给值 = 列出所有预设。然后把 `CLAUDE.md` 和各 `.claude/skills/tower-*/SKILL.md` 里的 `<!-- 项目填写 -->` 换成本项目的内容。

### 以后更新

`node scripts/belltower-sync.mjs --ref <版本>` 先预演、加 `--apply` 才写。
**只覆盖框架文件**,项目自己的东西(CLAUDE.md、配置、四件台账、各板块 SKILL.md、冻结清单)永远不碰。
哪些算框架、哪些算项目,见 `belltower.manifest.json`。

### 先读哪几份

1. `docs/principles.md` —— 规矩背后的原则,每条带来历
2. `framework/templates/CLAUDE.md` —— 装进项目后的规矩(七条铁律、台账总线)
3. `docs/architecture.md` —— 板块怎么分、怎么交接
4. `framework/.claude/skills/tower-meta/references/tower.md` · `dispatch.md` —— 塔怎么当、工人怎么派
5. `docs/platform-facts.md` —— 平台实测过什么、没测过什么

### 测试

`node scripts/test.mjs` —— 框架自测 + init / 预设 / sync 实装 + 泄漏扫描,一条命令。变异验证的做法见 `docs/testing.md`。

### 许可证

MIT,见 `LICENSE`。
