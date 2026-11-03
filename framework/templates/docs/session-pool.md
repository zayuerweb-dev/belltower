# 会话活表

**此刻在跑的会话。收工即删行。** 这张表只描述现在,不是历史 —— 历史看 `journal.md`。

协议见 `.claude/skills/tower-meta/references/tower.md`。

---

## 塔(常驻,一个板块一个)

> **行格式别改**:`| <板块> | \`tower-<板块>\` | …`。开局 hook 靠这个格式 + 本行里的会话 ID 认出「你是哪个塔」。
> 板块清单来自 `.claude/belltower.json` 的 `boards`;增删板块时这里同步增删行。
> 装好的项目补开一个板块用 `node scripts/belltower-sync.mjs --add <板块>`,这张表的行它会一起补上(先预演,加 `--apply` 才写)。
> 会话 ID 一栏写 `session_…` 的 ID(可附一句开塔时刻、分支);塔被重开后**换成新 ID**(按门铃前先查这里)。

| 塔 | 板块 skill | 形态 | 会话 ID / 链接 | 状态 |
|---|---|---|---|---|
| plan | `tower-plan` | 云 | ⬜ 待开 | |
| product | `tower-product` | 云 | ⬜ 待开 | |
| dev | `tower-dev` | 云 | ⬜ 待开 | |
| data | `tower-data` | 云 | ⬜ 待开 | |
| ops | `tower-ops` | 云 | ⬜ 待开 | |
| biz | `tower-biz` | 云 | ⬜ 待开 | |
| meta | `tower-meta` | 云 | ⬜ 待开 | |
| test | `tower-test` | 云 | ⬜ 待开 | |
| patrol | `tower-patrol` | 云 | ⬜ 待开 | |

**开塔口令**(用户粘贴,一塔一行,把 `plan` 换成对应板块;巡检塔那行的「任务=」不一样,见 `tower.md`「开塔口令」):

```
板块=plan 任务=常驻讨论台,按 .claude/skills/tower-meta/references/tower.md 开局
```

> **由巡检塔代开**(`create_session`)—— 塔要由不会被重开的会话来开,见 `tower.md`「谁来开塔:巡检塔是根」:
> `source_url` = 本仓库、**`source_revision: "main"` 必传**(不传的话塔在桌面 App 侧栏里落进「Other」,不进项目组),
> `title` = 「<项目>/<板块>」,`tags: ["tower", <板块>]`,**不带 `worker`**(每日巡检归档工人时靠这个标认塔),
> `prompt` 只写 `/effort max`,等新会话 `IDLE` 再用门铃送上面那行口令(`tower.md`「每月深度重开」开新会话、送口令那两步)。
>
> **巡检塔(patrol)自己例外,不由别的塔代开**:用户在侧栏亲手开(顶层会话),起名「<项目>/patrol」,补 `tower` / `patrol` 两个标。
> 它是开塔的根 —— 每月深度重开由它来做,它自己不进深度重开、永远不归档;要全新,让用户在它的窗口里手动 `/clear`。

---

## 任务会话(短命)

| 单号 | 派发塔 | 任务 | 工人会话 | 分支 | 起跑 | 状态 |
|---|---|---|---|---|---|---|

**收工即删行**,痕迹留 `journal.md`。行的身份是**单号 `Qn`**,一个号一行。
派发配方见 `.claude/skills/tower-meta/references/dispatch.md`;**收活时塔自己查 PR,不认工人的自述**
(实测过:回执写 merged,实际是 open)。

---

## 记帐规矩

- 塔开出来 → 在上表填会话 ID 和状态。
- 派任务 → 在下表加一行,写清验收标准。
- 任务闭环 → `journal.md` 记一行,然后**把下表那一行删掉**。
- 塔睡了不用删 —— 塔是常驻的,任务才是消耗品。
- **任务闭环后,工人会话 `archive_session` 掉** —— 转只读、释放容器、从侧边栏收走。
  **不是删除**:「不认工人自述、要能回查」,删了转录就查不回去。
  ★ **归档前先确认产出推出去了**(`git ls-remote --heads origin 'claude/qnn*'` +
  `git log origin/main --grep='(#<PR 号>)'`)—— 归档释放容器,没 push 的东西就没了。
  配方见 `dispatch.md` §6 末段。闸门10 会在你派下一个工人时问一次。

## 已知的平台事实

- **本机会话的 `list_sessions` 看不到云会话**;云塔能同时列到云端和本机会话。
  跨会话的**权威流转仍然走文件总线**,别指望会话列表。
- 云塔醒来是**陈旧克隆**,开局第一件事 `git fetch` + `git merge`。
- 更多见本框架的 `docs/platform-facts.md`。
