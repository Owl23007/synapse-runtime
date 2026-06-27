# NapCat Docker 接入

本文档用于在 Linux/Docker 环境启动 NapCat，并通过 OneBot 11 WebSocket 接入 Synapse Runtime。

## 目录

- Compose 文件：`deploy/napcat/docker-compose.yml`
- NapCat WebUI：`http://127.0.0.1:6099`
- OneBot 11 WebSocket：`ws://127.0.0.1:3001`

## 启动 NapCat

```bash
cd deploy/napcat
cp .env.example .env
docker compose up -d
```

首次启动后打开 NapCat WebUI：

```text
http://127.0.0.1:6099
```

在 WebUI 中登录 QQ，并新增一个 OneBot 11 WebSocket 服务端配置：

- 类型：WebSocket 服务端
- 监听地址：`0.0.0.0`
- 端口：`3001`
- Access Token：和 Synapse Runtime 的 `NAPCAT_TOKEN` 保持一致
- 是否启用：启用

如果 Synapse Runtime 和 NapCat 在同一台宿主机运行，Runtime 使用：

```toml
[channels."qq-local"]
adapter = "onebot11"
provider = "napcat"
transport = "websocket"
endpoint = "ws://127.0.0.1:3001"
accessToken = "${NAPCAT_TOKEN:-}"
enabled = true
riskLevel = "high"
```

如果 Synapse Runtime 在另一个容器里运行，把 endpoint 改为 Docker 网络内的服务名：

```toml
endpoint = "ws://napcat:3001"
```

如果 Synapse Runtime 在另一台机器上运行，把 endpoint 改为 NapCat 宿主机地址：

```toml
endpoint = "ws://192.168.1.10:3001"
```

## Runtime 环境变量

在项目根目录 `.env` 中设置：

```env
NAPCAT_TOKEN=your-token
```

该值必须和 NapCat WebUI 中 OneBot 11 WebSocket 服务端的 Access Token 一致。如果 NapCat 侧未设置 token，可以留空，但不建议在非本机网络中这样使用。

## 常用命令

```bash
cd deploy/napcat
docker compose ps
docker compose logs -f napcat
docker compose restart napcat
docker compose down
```

## 注意事项

- `mlikiowa/napcat-docker:latest` 会拉取当前最新镜像；生产环境建议固定镜像版本。
- Compose 将 QQ 数据和 NapCat 配置挂载到 `deploy/napcat/data/`，便于重启后保留登录状态。
- 本项目当前实现的是 OneBot 11 正向 WebSocket，即 Synapse Runtime 主动连接 NapCat 的 WebSocket 服务端。
- `adapter = "onebot11"` 在 `runtime.mode = "hosted"` 下会被配置校验拒绝，只适合本地或自托管环境。
