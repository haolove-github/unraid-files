# Unraid Files

一个面向 Unraid 的轻量文件管理器。扫描使用 `/mnt/user` 逻辑路径，移动、重命名、删除时会解析到 `/mnt/disk*`、`/mnt/cache`、`/mnt/pool` 等真实路径执行，避免通过 FUSE 逻辑层做慢速跨盘移动。

## 功能

- 浏览 `/mnt/user` 逻辑目录
- 显示文件实际位于哪些磁盘，多磁盘位置使用逗号分隔
- 显示 Docker 容器 bind mount 与文件/目录的关联
- 新建目录、上传、重命名、移动、下载
- 多选文件和目录打包为 TAR 下载
- 查看文件权限、所有者 UID/GID，按需计算 SHA-256
- 复制/移动支持目标冲突预检查、覆盖确认和复制自动重命名
- 删除到各真实磁盘下的 `.unraid-files-trash`
- 回收区查看、恢复、清除
- 永久删除
- 当前目录递归搜索
- 长时间复制、移动、删除操作显示任务进度
- 浏览器本地收藏常用路径
- 磁盘容量概览

## Unraid 部署

在 Unraid 终端或你喜欢的构建环境里：

```bash
docker compose up -d --build
```

打开：

```text
http://你的-unraid-ip:8080
```

推荐挂载：

```yaml
volumes:
  - /mnt:/mnt
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

`/mnt` 需要可写，否则文件操作会失败。Docker socket 只读挂载用于读取容器挂载信息；不挂载也能使用文件管理功能，只是不会显示 Docker 关联。

建议启用内置认证，并通过 `.env` 或其他安全方式传入密码：

```yaml
environment:
  UNRAID_AUTH_USER: admin
  UNRAID_AUTH_PASSWORD: ${UNRAID_AUTH_PASSWORD}
```

不要把真实密码提交到 Git。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | Web 服务端口 |
| `UNRAID_USER_ROOT` | `/mnt/user` | 逻辑扫描根目录 |
| `UNRAID_MNT_ROOT` | `/mnt` | 真实磁盘根的父目录 |
| `UNRAID_REAL_ROOTS` | 空 | 手动指定真实根，逗号分隔 |
| `UNRAID_DEFAULT_WRITE_ROOT` | 空 | 父目录横跨多盘时，新建目录默认真实写入根 |
| `UNRAID_TRASH_DIR` | `.unraid-files-trash` | 回收区目录名 |
| `UNRAID_JOB_RETENTION_MS` | `86400000` | 已完成/失败任务在内存中保留多久，毫秒 |
| `UNRAID_MAX_JOB_HISTORY` | `200` | 最多保留多少个已完成/失败任务 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker API socket |
| `UNRAID_AUTH_USER` | `admin` | 可选 Basic Auth 用户名 |
| `UNRAID_AUTH_PASSWORD` | 空 | 设置后启用 Basic Auth；空值表示不启用 |

## 移动策略

例如逻辑目录 `/mnt/user/media/movie` 同时存在于：

```text
/mnt/disk1/media/movie
/mnt/disk2/media/movie
```

移动到 `/mnt/user/archive` 时，服务端会执行：

```text
/mnt/disk1/media/movie -> /mnt/disk1/archive/movie
/mnt/disk2/media/movie -> /mnt/disk2/archive/movie
```

这样同盘 `rename` 基本是元数据操作，比从 `/mnt/user` 逻辑路径移动更快。

## 注意

- 这是文件管理器，容器权限应该只给可信用户访问。
- 默认不启用认证。即使仅在局域网使用，也建议设置 `UNRAID_AUTH_PASSWORD`。
- 不建议直接公开到公网；如确有需要，请通过 HTTPS 反向代理并启用认证。
- 挂载 Docker socket 会允许应用读取容器信息，应只在可信环境中使用。
- 批量打包下载依赖容器内的 `tar` 命令，项目提供的 Docker 镜像已包含该命令。
- 永久删除会直接删除真实路径，不进回收区。
- 删除到回收区时，每个真实磁盘会在根目录下创建 `.unraid-files-trash/<时间戳>/...`。

## 本地开发

需要 Node.js 18 或更高版本：

```bash
npm run check
npm test
npm start
```

## 许可证

[MIT License](LICENSE)
