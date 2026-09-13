# 绘映技术架构与实施文档

版本：1.0｜核查日期：2026-09-13｜对应[PRD](PRD.md)。

本文件区分现有实现、实测结果和建议设计。源码位于仓库根目录的 backend/ 与 frontend/。示例不包含真实密钥，不建议直接将本地服务发布公网。

## 1. 当前系统与验证结果

系统为 Next.js 前端、FastAPI 后端、Python 工作流代理、外部模型适配器与 FFmpeg 合成组成的本地应用。前端端口 3000，后端端口 8000。前端 package.json 声明 Next.js 16.2.3、React 19.2.5。后端使用 Python 虚拟环境，项目声明的最低 Python 版本与实际兼容性仍需通过 CI 核实；本地环境为 Python 3.11。

核查会话：example-session。会话记录中的六个创作阶段均为 completed。视频片段 seg_01_01.mp4 经 ffprobe 核查为 H.264、1280×720、AAC 音轨、13.088 秒；合成输出 example-session_ep1.mp4 为 13.120 秒、4,526,015 字节。编码/封装导致时长存在小幅差异。

该结果证明一个片段的完整链路可用，不证明多集长视频、高并发、故障恢复或 mini 模型完整链路通过验收。成功生成使用标准 Seedance 2.0，随后才将默认视频模型改为 mini。

## 2. 架构与职责

请求链路：浏览器 → Next.js 页面/组件 → workflowApi → FastAPI 路由 → 工作流引擎/阶段代理 → 模型适配器 → 提供方 API。

存储链路：工作流引擎 → 本地会话 JSON 与素材文件；视频阶段 → 本地片段；后期代理 → FFmpeg → 按集输出 MP4。

| 层 | 主要位置 | 职责 |
|---|---|---|
| 主流程界面 | frontend/components/stages/ | 剧本、分镜、概念图、视频的编辑、选择和阶段操作 |
| 工作流请求 | frontend/lib/workflowApi.ts | 非流式请求及流式事件解析 |
| 画布 | frontend/app/canvas/ | 节点、连线、素材、视频配置与任务显示 |
| HTTP 服务 | backend/api_server.py、backend/api/ | 路由、上传、配置、项目操作 |
| 阶段代理 | backend/core/agents/ | 剧本、人物、分镜、概念图、视频与后期处理 |
| 范围约束 | backend/core/storyboard_scope.py | 按启用片段裁剪下游输入 |
| 模型适配 | backend/models/ | 提供方请求、响应和媒体处理 |
| 模型/配置 | backend/config.py、backend/models/config_model.py | 默认模型、运行配置与能力注册 |
| 会话与输出 | backend/code/data/sessions/、backend/code/result/ | 本地项目记录与媒体产物 |

目前没有统一数据库、持久任务代理或完整多租户体系。线程锁和本地 JSON 适合当前本地工作台，不构成分布式并发控制。

## 3. 主流程执行与状态

阶段标识依次为 script_generation、character_design、storyboard、reference_generation、video_generation、post_production。reference_generation 的用户界面名称已改为“场景概念图”，内部标识仍保留，以免破坏已有项目。

阶段代理接收上游数据与可选 intervention，返回 payload 和阶段完成/需人工干预等信息。前端确认推进与下一阶段执行为关联操作，不能把“存在下一阶段占位数据”判为已执行。

当前状态涉及 running、completed、error、stopped、waiting 等；页面曾把部分等待/失败情况显示成完成，现已修正相关判断，但还不是经过形式化验证的统一状态机。

建议统一任务状态为 draft → queued → submitted → running → downloading → succeeded，另有 failed、cancel_requested、cancelled 和 unknown。阶段“等待人工确认”应与提供方任务状态分离。停止本地等待不等于提供方取消成功，超时也不等于生成失败。

### 3.1 流式通信

流式请求默认直接请求 http://127.0.0.1:8000，可由 NEXT_PUBLIC_API_URL 配置；普通请求使用相对地址及前端代理。部署到远程环境时必须统一浏览器可访问的地址，不能保留客户端环回地址。

当前返回 Content-Type 为 text/event-stream，但内容采用逐行 JSON，由自定义解析函数读取，并非标准 EventSource 的 data: 事件格式。未来若改用标准 SSE 客户端，必须一起迁移服务端 framing。

project_helpers.py 通过异步任务和事件通知传送进度。已增加任务结束唤醒，避免无进度的保存/错误等待 15 秒心跳才返回。请求断连下的后台任务不等于进程重启后可恢复的持久作业。

## 4. 数据结构与选择范围

| 实体 | 关键字段 | 说明 |
|---|---|---|
| Session | session_id、current_stage、status、artifacts、stage_progress、meta、error | 项目阶段与模型配置 |
| Episode | episode_number、episode_title、segments | 分镜集 |
| Segment | segment_id、segment_number、episode_number、enabled、location、characters、total_duration、shots | 后续生成的选择单位 |
| Shot | shot_number、shot_type、duration、content | 片段中的镜头描述 |
| 图片/视频产物 | scenes/clips、versions、selected 等 | 不同阶段结构不完全相同，需由阶段适配 |

storyboard_scope 对输入深拷贝后过滤启用片段，应用于概念图、视频和合成输入。历史 enabled 缺省按 True 处理；不能在“显式全部取消”时回退全量。同步逻辑使用 excluded_scenes/excluded_clips 保留被排除产物，重新勾选可恢复；这不等同于删除磁盘文件。

集折叠为界面状态，不改变生成范围。分镜选择和编辑草稿在保存后更新产物；删除恢复目前限编辑期，不是跨刷新持久撤销。缺少统一草稿持久化与离开保护。

建议新增 artifact_revision 与稳定实体 ID，避免依赖展示序号识别片段。下游记录 source_revision、source_segment_ids 和 model_snapshot。原稿改变后标记 stale，并保留旧媒体供用户选择，不应自动销毁或重新计费。

## 5. API 概览

下表为现有主要路由。具体请求字段以路由模型为准，本文不把建议接口混为已上线接口。

| 方法与路径 | 用途 |
|---|---|
| POST /api/project/start | 创建项目 |
| POST /api/project/{id}/execute/{stage} | 执行阶段，流式返回 |
| GET /api/project/{id}/status | 当前状态 |
| GET /api/project/{id}/status/from_disk | 从持久记录读取状态 |
| GET/PATCH /api/project/{id}/artifact/{stage} | 获取/更新阶段产物 |
| POST /api/project/{id}/intervene | 人工修改或阶段干预，流式返回 |
| POST /api/project/{id}/continue | 推进阶段 |
| POST /api/project/{id}/stop | 本地停止操作 |
| PATCH /api/project/{id}/models | 更新项目模型配置 |
| POST /api/project/{id}/artifact/{stage}/upload_image | 为阶段上传图片 |
| GET /api/sessions | 会话列表 |
| GET /api/stages | 阶段信息 |
| GET/PUT /api/config | 全局配置读取/写入 |
| GET/PUT /api/canvas | 画布读取/保存 |
| POST /api/canvas/upload、/import | 画布素材上传/导入 |
| GET /api/canvas/library | 资产库 |
| POST /api/canvas/generate | 提交画布视频 |
| GET /api/canvas/jobs/{id} | 查询画布任务 |

配置 PUT 使用 values 包装配置；现有合并行为不宜当作任意字段 PATCH，更新时需保证其他配置不被默认值覆盖。配置返回对象包含敏感字段，不应记录完整响应或放入文档。

建议错误响应统一包含 code、message、retryable、task_id、provider_code、request_id；凭据和提供方完整请求头必须脱敏。限流应保留可重试信息，不能统一显示“生成失败”。

## 6. 模型接入与实际运行配置

| 用途 | 当前配置/事实 | 限制 |
|---|---|---|
| 文本 | deepseek-chat | 已用于剧本等文本链路 |
| 图片 | doubao-seedream-5-0-260128 | 已生成角色/概念图 |
| 视频默认及首帧默认 | doubao-seedance-2-0-mini-260615 | 后续改动；不能据此宣称此前标准版结果由 mini 生成 |
| 本次成功视频 | doubao-seedance-2-0-260128 | 13 秒、720P；应作为历史真实模型记录 |
| 自动视觉评估 | qwen3.5-plus | 当时没有配置对应 DashScope Key，评估不可用 |

模型注册的能力信息不等于提供方实际验证。mini 注册仍带 api_contract_verified=False；其他视频模式保留独立映射。更新默认值不会可靠覆盖所有历史项目与已打开页面，需要明确全局默认、项目配置、单次提交快照三层优先级：单次显式参数 > 项目已保存配置 > 全局默认。

OpenAI 兼容客户端已显式建立 httpx.Client，关闭环境变量隐式代理继承，并按配置启用代理，修复 SOCKS 依赖引发的初始化失败。不能据此认定所有第三方请求库都自动获得同样策略，应逐适配器核查。

### 6.1 概念图评估

此前评估不可用被当作低分，产生最多三轮重画。当前不可用分支保留现有图片并提示人工检查，不继续收费重画。真正质量不达标的重试仍有既有逻辑，需要进一步补预算限制。

待补：把 evaluation_status=unavailable 和人工审阅状态持久到产物。当前仅有版本并被选中不能证明“自动质量通过”。

### 6.2 视频调用

当前适配器包含提交、轮询、下载流程。轮询次数/间隔和网络超时有上限；轮询超时不应直接再次提交。主流程需要持久化提供方任务 ID，并在恢复时先查询原任务。画布已有较完整的请求 ID 和任务记录，两条链路尚未统一。

## 7. 画布实现

画布支持文本/图片/视频节点、拖动连线、空白创建菜单、选中视频操作面板、上传和资产选择。视频请求含 request_id、node_id、prompt、image_urls、reference_mode、duration、resolution、ratio；兼容旧单图字段。

现有画布视频参数支持 5/10 秒、480P/720P 及部分比例；多图参考与首帧输入分别处理。上传可接受的媒体种类与模型实际可输入格式不同，生成前仍需校验 PNG/JPEG/WebP 等可用图片。GIF 上传成功不代表能直接作为模型输入。

画布及任务存储在 backend/code/canvas 下，画布保存有 revision 冲突检测；节点/边数量有上限（500/1000）。生成记录支持同 request_id 重放与不一致请求拒绝，同节点活动任务约束。下载通过临时文件再替换，降低半成品被展示的风险。

当前锁为进程内锁，不是跨实例分布式锁。部分查询涉及远程轮询/下载，需避免长期占用任务锁；后续宜改独立 worker。不能据此宣称已具备全账号公平排队。

## 8. 新增编辑与 AI 修改方案（尚未实施）

### 8.1 现状

ScriptStage.tsx 已有 startEdit、cancelEdit 以及结构/JSON 编辑区内的取消按钮；固定底栏编辑态缺少对应取消入口。handleSave 调用 onIntervene 后立即退出编辑，异步失败时的草稿保留需改善。

script_agent 支持 modified_script 保存与 smart_continue 续写；storyboard_agent 支持 modified_storyboard。内部生成校验的自动修复不是用户可控的局部 AI 改写功能。

### 8.2 手动编辑方案

将保存处理改为 await 成功后退出编辑；用 saving 锁防重复保存，失败保留草稿。底栏调用已有 cancelEdit，并显式恢复草稿快照。切换模式遇到非法 JSON 时显示解析错误，不能静默忽略。取消不调用模型、不删除历史版本。

### 8.3 AI 候选修订方案

建议新建修订服务，不直接复用“重新生成整阶段”语义。请求字段：stage、base_revision、scope（整篇/集/片段 ID）、instruction、constraints、request_id。服务读原稿，裁剪范围及必要人物上下文，调用文本模型，校验结构和引用后保存 candidate。

建议接口（未实现）：POST /api/project/{id}/revisions 生成候选；GET /api/project/{id}/revisions/{revision_id} 查询；POST /api/project/{id}/revisions/{revision_id}/apply 采用；POST 同路径 /discard 放弃。

采用时执行乐观版本校验，base_revision 不匹配返回 409，提示重新对比；禁止覆盖用户后续编辑。采用操作原子更新原稿并建立版本记录；未选实体保持原样。候选失败和放弃不改变正式产物。原文、指令和引用素材是数据，系统不能据其内容执行代码或任意工具操作。

下游失效通过依赖关系标记 stale：剧本修改可能影响角色与分镜；分镜修改影响概念图、视频与合成。标记不触发模型任务。用户选择重新生成时，再按确认范围提交。每次媒体任务绑定采用版本，避免生成过程中编辑造成输入漂移。

## 9. 后期与文件生命周期

VideoEditorAgent 从所选视频快照提取有效路径，按集组装 concat 列表，FFmpeg 使用 libx264、AAC、yuv420p 和 faststart 输出。无有效片段时应失败并解释，不能伪造完成。当前会跳过缺失路径，产品应补明确“哪些片段缺失”的提示，防止不完整合成被误认为全量完成。

当前不提供专业时间线剪辑；分镜 episode_title 与部分后期读取字段应统一校验。项目 JSON、输出文件与画布资产的清理策略尚未统一：取消选择不是物理删除，删除会话也必须独立核查文件清理行为。建议采用资产引用计数、软删除和延迟清理。

## 10. 并发、可靠性与可观测性

部分代理线程池并发为 10，不代表账号并发配额为 10，也不代表整个应用总并发为 10。浏览器连接、长流式请求、后端线程池、提供方限流都可能造成等待。用户“第七个开始失败”的描述不足以确定提供方限制，应结合 HTTP 状态和请求 ID 诊断。

建议按提供方/模型建立统一队列与并发令牌，429 使用有上限的退避；提交结果未知时先查询，不盲目重试。主流程补 request_id 幂等、持久任务表、provider_task_id、输入快照和恢复扫描。

日志记录 project_id、stage、segment_id、request_id、provider_task_id、model、latency、attempt、terminal_status。区分提交、排队、模型运行、下载及合成耗时；前端“5%”不能解释为提供方真实进度。无真实百分比时显示阶段和已等待时间。

## 11. 安全与部署边界

当前存在宽泛 CORS、无完整账户鉴权、配置接口返回敏感字段、/code 静态目录覆盖范围较大等问题。用于线上前必须实现：服务端凭据保管与脱敏返回、身份认证和项目归属检查、受控媒体目录/签名下载、上传内容校验与大小限制、生产 CORS 白名单、审计与速率限制。

此处是现有技术缺口，不是已具备的安全功能。已有本地密钥不写入交付文件、前端打包或日志；生产密钥需要独立生命周期。关闭 watermark 参数不承担素材授权或生成内容合规判定。

## 12. 本地运行与验证

后端：在 backend 使用项目 .venv 环境运行 api_server.py，确认 8000 端口可访问。前端：在 frontend 安装与锁文件一致的依赖，使用开发脚本；发布构建使用 npm run build 和 npm run start。FFmpeg/ffprobe 必须在后端可执行路径中。不要为文档核查重新提交付费生成。

已存在的针对性测试文件：

| 测试 | 覆盖目的 | 未覆盖边界 |
|---|---|---|
| test_llm_proxy.py | 显式代理策略、客户端初始化 | 提供方实时网络可用性 |
| test_storyboard_scope.py | 范围裁剪、空选、排除恢复、删除集 | 多用户并发改同项目 |
| test_reference_evaluation_unavailable.py | 评估不可用不再次生成 | 真正质量评分有效性 |
| test_workflow_stream_completion.py | 无进度完成/错误及时返回 | 重启恢复与生产网络 |
| test_canvas.py | 画布任务与多图等相关行为 | 分布式队列、全部真实模型组合 |

开源打包时在隔离副本执行 unittest discover，22 个测试通过；未提交新的付费生成。测试使用现有本地 Python 环境，未验证全新机器安装。后续代码修改应按变更范围运行对应测试，再做端到端回归。

## 13. 实施顺序与验收矩阵

| 顺序 | 技术任务 | 对应 PRD | 验收重点 |
|---|---|---|---|
| 1 | 编辑底栏取消、await 保存、错误保留 | FR03 | 取消恢复；保存失败不退出/不生成 |
| 2 | 主流程任务 ID、输入快照与幂等 | FR02/04/07/16 | 重复点击和刷新不重复提交；显示真实模型 |
| 3 | AI 修订候选与乐观并发 | FR11/12 | 越范围修改拒绝；冲突 409；放弃不改原稿 |
| 4 | 下游依赖版本与 stale 状态 | FR13 | 修改仅标记影响，不自动调用媒体模型 |
| 5 | 全局队列与费用用量记录 | FR04/07 | 排队不报失败；未知提交先恢复查询 |
| 6 | 认证、资产隔离和安全配置 | FR18 | 未授权访问拒绝；敏感字段不返回 |

迁移前备份会话及资产索引，采用可兼容旧数据的新增字段；历史记录未知模型/任务 ID 应标记未知，不从新默认值反推填入。回滚保留候选、产物和提交记录，禁止通过重跑全部阶段“修复”状态。
