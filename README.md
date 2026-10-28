# 个人任务工作台（DSH 插件）

把「项目 → 议题 → 工作单元 → 多轮对话 → 收尾交接 → 验收」这条流水线搬进 DeepSeek Harness：
侧栏多一个「工作台」入口，用一个本地 JSON 文件记住所有状态，宿主提供 HTTP 读接口与命令，
浏览器渲染五个视图，另外给 AI 注册 9 个受约束的工具。

- 零第三方运行时依赖；数据只在本机 `$DSH_HOME/workbench/workbench.json`（原子写 + fsync + 文件锁）。
- 不连任何远端服务；AI 工具**没有**立项、验收、完成、取消、删除的权限。

## 核心模型：单元 = 一个会话容器

| 概念 | 含义 |
|---|---|
| 项目 | 一条业务线，绑定一个默认工作目录 |
| 议题 | 一件要做的事，有验收标准；开工后**工作区目录锁定**（换目录请新建议题） |
| 单元 | 一次「认领会话」产生的执行容器，可以包含**任意多轮**对话 |
| 轮 | 单元内的一次问答往返，只累加计数，不决定单元是否结束 |

关键行为：

- **一轮结束 ≠ 单元结束**：AI 回复完成只是 `turnCount + 1`，单元继续跑，议题仍是「处理中」。
- **收尾是显式动作**：点「结束本单元」时若还没有交接，系统会**请该单元自己的会话**写四段交接
  （改动 / 验证 / 结果 / 剩余风险）；AI 只能代写草稿，最终由人确认。
- **打回回到同一单元继续**（会话仍存在时），不新建单元、不作废；会话已关闭才会作废并回待认领。
- **不限制并发**：同时跑多少单元由你决定，没有全局上限；同一议题仍只允许 1 个活跃单元。
- **已收尾的单元**：AI 不能再改写交接；议题完成后只有人能显式改回。

## 安装

拿到 `local-dsh-workbench-0.1.0.tgz` 后：

```sh
dsh plugin --profile desktop add --offline "file:/绝对路径/local-dsh-workbench-0.1.0.tgz"
```

然后**重启 DSH 应用**，侧栏出现「工作台」。

开发时也可以直接从源码目录装（`link:` 便于热改）：

```sh
dsh plugin --profile desktop add --offline "file:/绝对路径/workbench-plugin"   # 拷贝
dsh plugin --profile desktop add --offline "link:/绝对路径/workbench-plugin"   # 软链
```

卸载：

```sh
dsh plugin --profile desktop remove @local/dsh-workbench
```

## 用起来

- 侧栏「工作台」→ 进度线（默认）/ 看板 / 收件箱 / 搜索。
- 空白起步：先「＋新建项目」，或直接记一条 TODO；立项要选项目 + 至少一条验收标准。
- DSH 会话输入框旁的「⊞ 认领」：把**当前会话**挂到某个议题上，成为它的工作单元。
- 收件箱里看：待验收单元、**待收尾**（会话已结束但没人收尾）、AI 建议收尾、等你拍板。
- 议题详情里：结束本单元 / 打回（回执行中继续）/ 通过 / 作废，以及终验收。

## AI 工具（9 个，均有权限边界）

`workbench_create_todo`、`workbench_suggest_triage`、`workbench_claim_unit`、`workbench_create_unit`、
`workbench_write_handoff`、`workbench_suggest_wrapup`、`workbench_push_status`、
`workbench_request_decision`、`workbench_comment`

AI 能写交接、能建议收尾，但**不能**自己结束单元、不能验收、不能改议题状态、不能删除。

## 开发

```sh
./pack              # 一键打包：重建 client.js → dist/local-dsh-workbench-<version>.tgz（含 sha256）
npm test            # 101 条单测 + 集成测试（需要本机装好 DSH）
npm run check       # 语法 + tsc + client 构建一致性
scripts/verify-*.sh # 各层门禁（S1/S2/E2E/Phase3/UI 120+ 断言/健壮性）
```

## 状态

`0.1.0` —— 个人使用；接口与数据格式仍可能按需调整（schemaVersion 已有迁移机制）。
