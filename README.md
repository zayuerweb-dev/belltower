# belltower

A harness built on Claude Code for running projects with many sessions. Long-lived tower sessions each own one area. Towers ring each other's doorbell (a trigger that wakes the other session in seconds) and leave the details on a shared git ledger. They dispatch short-lived workers to do the work; finished workers are archived automatically.

[English](#english) · [中文](#中文)

---

## English

### What's in the box

| Piece | What it does |
|---|---|
| **Towers** | One long-lived session per area (default eight: `plan` `product` `dev` `data` `ops` `biz` `meta` `test`). A tower discusses, decides, dispatches and reviews. It does not do the finished work itself. |
| **Workers** | Short-lived sessions a tower spawns for one numbered task. They push a branch or open a PR, and are archived once done. |
| **Doorbell** | A trigger bound to another tower's session. Firing it wakes that session within seconds. The message only says "go read the ledger"; the details live in git. |
| **Ledger** | Four markdown files on `main`: `docs/BACKLOG.md`, `docs/journal.md`, `docs/session-pool.md` and `docs/gate-log.md`. `scripts/ledger-push.mjs` pushes them straight to `main`, and falls back to a PR when branch protection blocks the push. |
| **Gates** | Claude Code hooks (`.claude/hooks/`) that stop the known failure modes. Examples: sensitive data copied into the repo, a tower creating a task no user asked for, a "merged" claim not found on `main`, a ledger left on a branch, a context window past its budget. Every gate fails open. |
| **Routines** | Prompts for a daily worker cleanup, a weekly deep restart, and a 10-minute check-in after dispatching (`docs/routines.md`). |

### Install into a project

```bash
git clone https://github.com/zayuerweb-dev/belltower
node belltower/scripts/belltower-init.mjs path/to/your-project
cd path/to/your-project
$EDITOR .claude/belltower.json      # repo, codeDirs, boards, ranges, sensitivePaths, timezone
node scripts/test-hooks.mjs         # must be green
```

Then fill the `<!-- 项目填写 -->` placeholders in `CLAUDE.md` and in each `.claude/skills/tower-*/SKILL.md`.

### Update later

```bash
node scripts/belltower-sync.mjs --ref v0.1.0            # dry run: lists what would change
node scripts/belltower-sync.mjs --ref v0.1.0 --apply    # write, then re-run the tests
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
| `boards` | the eight above | identity check (session ID ↔ pool row `tower-<board>`) |
| `ranges` | `Q1xx` … `Q8xx` | shown when a tower is recognized |
| `sensitivePaths.bash` / `.edit` | `sensitive/`, `private-data/`, key files | gates 1–3; empty string turns a gate off |
| `sensitiveReminder` | iron rule 1 | session-start banner |
| `timezone` | `America/New_York` | every timestamp |

The skill prefix is fixed at `tower-`.

### Docs

The protocol docs are written in Chinese:
- `docs/architecture.md`: boards, handoffs, towers vs workers;
- `docs/platform-facts.md`: what the platform can and cannot do, each item marked tested or untested;
- `docs/routines.md`: routine prompts;
- `docs/principles.md`: the principles behind the rules;
- `docs/testing.md`: tests and mutation checks;
- `docs/vendor-skills.md`: pulling third-party skills;
- `framework/.claude/skills/tower-meta/references/`: `tower.md` (how a tower runs) and `dispatch.md` (how to dispatch a worker).

### Requirements

Node 18+ and git. It is built for Claude Code cloud sessions with the remote-session MCP tools (`create_session`, `create_trigger`, `send_later`…). The hooks also run locally, but the doorbell and workers need the cloud tools.

### License

MIT — see `LICENSE`.

---

## 中文

**belltower** 是一套跑在 Claude Code 上的多会话协作框架。每个职能一个**常驻塔**(长寿会话),
塔之间**按门铃**(一个绑在对方会话上的触发器,几秒内叫醒对方),细节写在**共享的 git 台账**里;
成品活**派短命工人**去做,干完自动归档。

### 装进项目

```bash
git clone https://github.com/zayuerweb-dev/belltower
node belltower/scripts/belltower-init.mjs 你的项目目录
cd 你的项目目录
# 改 .claude/belltower.json:仓库名、代码目录、板块、号段、敏感路径、时区
node scripts/test-hooks.mjs   # 必须全绿
```

然后把 `CLAUDE.md` 和各 `.claude/skills/tower-*/SKILL.md` 里的 `<!-- 项目填写 -->` 换成本项目的内容。

### 以后更新

`node scripts/belltower-sync.mjs --ref <版本>` 先预演、加 `--apply` 才写。
**只覆盖框架文件**,项目自己的东西(CLAUDE.md、配置、四件台账、各板块 SKILL.md、冻结清单)永远不碰。
哪些算框架、哪些算项目,见 `belltower.manifest.json`。

### 先读哪几份

1. `framework/templates/CLAUDE.md` —— 装进项目后的规矩(七条铁律、台账总线)
2. `docs/principles.md` —— 规矩背后的原则
3. `docs/architecture.md` —— 板块怎么分、怎么交接
4. `framework/.claude/skills/tower-meta/references/tower.md` · `dispatch.md` —— 塔怎么当、工人怎么派
5. `docs/platform-facts.md` —— 平台实测过什么、没测过什么

### 测试

`node scripts/test.mjs` —— 框架自测 + init/sync 实装 + 泄漏扫描,一条命令。变异验证的做法见 `docs/testing.md`。

### 许可证

MIT,见 `LICENSE`。
