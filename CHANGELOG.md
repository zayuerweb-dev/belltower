# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/),版本号遵循语义化版本。

## [0.2.0] — 2026-09-25

### 新增
- **塔预设**:`belltower-init.mjs --preset <预设>` 按项目类型只装用得到的板块。一共四种:
  `web-product`(八个全开)· `web-app` · `devtool` · `minimal`,定义在 `presets.json`。
  选了预设之后:
  - 没选的板块不装 SKILL.md;
  - 新装的 `belltower.json` 只留选中的 `boards` / `ranges`;
  - 新装的 `CLAUDE.md` 路由表删掉没选的行,「塔」那一格填上开塔时机;
  - 新装的活表只留选中板块的行。
  - 项目里已有的文件不碰。
  - `--preset` 不给值,就列出所有预设。
- `belltower-sync.mjs`:没开的板块(不在 `boards` 里),它的 SKILL.md 不再报「缺起步文件」。

### 文档
- README 重写:加了「为什么做这个」「八个塔」「预设」「上下文经济」几节。上下文经济一节写明哪些实测过、哪些没量过。

### 修正
- `create_session` 开塔、派工人时,`source_url` 和 `source_revision: "main"` 一定要一起传。只传前者,会话能拿到仓库,
  但在桌面 App 侧栏里落进「Other」,不进项目组。这条已改进 `dispatch.md` §3/§4(派工人模板原来写的是「不用传」)、
  `tower.md` / `routines.md` 的每周重开、活表模板和 `platform-facts.md` §4.1。

### 测试
- 加了预设的测试:每个预设都含 meta,每个板块都写了开塔时机;`--preset minimal` 实装一遍,只装选中的板块,装好后框架自测全绿;
  sync 不把没开的板块报成缺;给了不存在的预设会退出 2;README 的预设表要跟 `presets.json` 对得上。

## [0.1.1] — 2026-09-25

### 文档
- `docs/platform-facts.md` §1.1:补「跨仓库门铃」实测。同一账号下,不同仓库的两个会话可以互相按门铃;
  另外记了门铃可以由另一个会话删、回执里会话 ID 有两种前缀、对方正在跑一轮时门铃会排队。§7 速查表加了一行。
- §2:给别的会话建的门铃,建它的会话改不了提示词,写错了就删掉重建。
- §1.4:`set_session_title` 能改同一账号下任何会话的标题;塔的标题建议统一成「项目/板块」。

## [0.1.0] — 2026-09-25

第一版:从一个私有项目里跑了一个多月的协作框架洗成通用版。

### 有什么
- **常驻塔 + 短命工人**:八个默认板块(plan / product / dev / data / ops / biz / meta / test),
  板块清单与号段可配;开局 hook 从会话 ID 现查活表,认出「我是哪个塔」。
- **门铃 + 台账总线**:四件台账直推 `main`(`scripts/ledger-push.mjs`),
  分支保护开着时自动转 PR 模式(靠 `origin/main` 的 sha 动没动分辨「被规则挡」和「被抢跑」)。
- **闸门**(Claude Code hooks,全部 fail-open):
  - guard-bash 1–4:敏感数据拷贝与强加进库、删系统目录、git 危险操作;
  - guard-edit 1–6:冻结清单、敏感路径、立号要用户原话、自签解除阻塞、「已合」要在主干找得到;
  - guard-mcp 10–11:派工人问授权、代码 PR 不许自己合;
  - guard-stop 6 / 7 / 8 / 9 / 12:改了代码没跑测试、没记流水、harness 没合进主干、上下文过线、台账停在分支。
- **配置** `.claude/belltower.json`:项目名、仓库、代码目录与扩展名、板块、号段、时区、敏感路径与提醒。
- **安装与同步**:`belltower-init.mjs`(装进项目)、`belltower-sync.mjs`(只更新框架文件,默认预演)。
- **泄漏扫描** `scan-public.mjs`:会话 ID、个人链接、邮箱、本机路径、提交 sha、PR 号、模型 ID、密钥前缀;
  项目词表用 `--words` 从仓库外带进来。
- **测试**:`node scripts/test.mjs` 一条命令(框架自测含台账推送沙箱、init/sync 实装、扫描规则逐条埋雷)。
- **发版**:推 `main`,CI 测试全绿后按 `belltower.manifest.json` 的版本号自动打 tag(云会话自己推不了 tag)。

### 跟原项目相比改了什么
- 项目、公司、客户、行业相关的内容全部去掉,教训保留、改写成通用说法。
- 敏感数据闸门从写死的目录名改成配置里的路径模式(默认值是通用的 `sensitive/`、`private-data/`、密钥文件)。
- 「代码 PR」「代码现状」「改了代码没跑测试」从写死的目录改成读 `codeDirs` / `codeExt`。
- 派工人闸门的匹配从具体的 MCP 服务器名改成 `mcp__.*__create_session`(服务器名因环境而异)。
- 测试全部改在临时沙箱里跑,不依赖本仓库的台账、配置和 git 历史(原项目有一条依赖真实历史的用例在浅克隆里会红,已改成沙箱)。
- 不带外来 skill,只带拉取脚本(见 `docs/vendor-skills.md`)。
