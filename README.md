# 绘映 HuiYing

本地运行的 AI 短片创作工作台：剧本 → 角色与场景 → 分镜 → 场景概念图 → 视频 → 按集合成。

本仓库基于已有绘映代码继续开发，保留上游 MIT 许可证与署名。此版本重点改进片段选择、画布交互、任务状态与模型接入。

## 当前能力

- 六阶段创作流程、结构化剧本编辑、智能续写。
- 按集折叠分镜、片段选择、集内全选、删除集/所选片段；按选择范围生成。
- 场景概念图版本选择、上传替换和重新生成。
- 无限画布节点、连线、双击菜单、素材上传与多图参考视频。
- DeepSeek、火山方舟等模型适配；FFmpeg 按集合成。

已在本地完成单片段视频与合成验证。多集长片、全部模型组合和高并发没有完整验证。AI 局部改写的差异预览/采用流程属于后续计划，不是现有能力。

## 环境

- Python 3.11（建议使用本次验证版本）
- Node.js 22 LTS、npm
- FFmpeg / ffprobe
- 自行开通所需模型并准备 API Key；开源软件不包含模型额度。

## 启动后端

在仓库根目录执行：

```sh
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp config.yaml.example config.yaml
python api_server.py
```

Windows 激活方式为 `.venv\Scripts\activate`，复制配置使用 `copy config.yaml.example config.yaml`。请在本地设置页或配置文件中填入自己的密钥；不要提交 config.yaml。

## 启动前端

另开终端，在仓库根目录执行：

```sh
cd frontend
npm ci
npm run dev
```

访问 http://localhost:3000 。后端默认 http://127.0.0.1:8000 。正式本地构建可执行 `npm run build` 后 `npm run start`。

## 模型配置

示例使用 DeepSeek 文本、Seedream 图片和 Seedance 2.0 mini 视频。模型 ID、开通权限、分辨率及收费规则以提供方实际支持为准；其他视频模式有独立模型配置。自动视觉评估使用独立提供方，未配置时需要人工检查图片。

推荐先选一个短片段测试。保存/勾选不调用生成模型；点击生成或重新生成可能产生提供方费用。视频与图片均需自行确认素材使用权限。

## 测试

后端安装依赖后执行：

```sh
cd backend
python -m unittest discover -s tests -v
```

现有针对性测试采用临时数据或模型 mock。媒体保存在 backend/code，未包含在源码包中。

## 文档

- [产品需求](docs/PRD.md)
- [技术架构](docs/TECHNICAL.md)
- [安全与运行边界](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [上游署名](NOTICE.md)

## 运行边界

这是本地开发版本，尚无完整账户权限隔离。不要将后端直接暴露公网；配置接口和媒体目录需在生产化前加固。主流程的持久任务恢复、统一并发队列与费用追踪仍待完善。

## 许可证

[MIT](LICENSE)。第三方模型服务、商标及用户素材不随代码许可证授予使用权。
