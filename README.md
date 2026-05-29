# TKBGC 素材生成

AI 产品 lifestyle 图片批量生成工具，基于 CreatOK API 生成图片，自动上传至飞书多维表格。

## 功能

- 三种美式居家场景预设（窗边晨光 / 大理石台面 / 壁炉角落）
- 场景独立开关、提示词可编辑、张数可配置（1-10张）
- 参考图上传与在线预览
- 后台并行提交 CreatOK 图片生成任务（单张单次，非批量）
- 生成的图片自动下载到本地，逐张上传到飞书多维表格
- 实时进度展示，每张图片独立状态追踪

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/YOUR_USERNAME/tkbgc-material-generator.git
cd tkbgc-material-generator

# 2. 安装依赖
npm install

# 3. 配置密钥
cp .env.example .env
# 编辑 .env 文件，填入你的 CreatOK 和飞书 API 密钥

# 4. 启动
npm start
```

打开浏览器访问 `http://localhost:3456`

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `CREATOK_API_KEY` | CreatOK Open API 密钥 | 是 |
| `FEISHU_APP_ID` | 飞书应用 App ID | 是 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | 是 |
| `FEISHU_BITABLE_APP_TOKEN` | 飞书多维表格 App Token | 是 |
| `FEISHU_BITABLE_TABLE_ID` | 飞书多维表格 Table ID | 是 |
| `PORT` | 服务端口（默认 3456） | 否 |

## 技术栈

- Node.js + Express
- CreatOK Open Skills API（gpt-image-2-official, 2K, 9:16）
- 飞书开放平台 API（多维表格 + 图片上传）
