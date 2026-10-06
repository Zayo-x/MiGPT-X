# MiGPT-X ——— 一条指令部署
#
#   docker run -d --name migpt-x \
#     -p 36593:36593 \
#     -v migpt-data:/data \
#     --restart unless-stopped \
#     ghcr.io/zayo-x/migpt-x:latest
#
# 设计约定：
#   · 镜像里只有代码和运行环境，所有会变化的东西都在 /data 挂载卷里
#   · 密钥（editable.json、.mi.json）永远不会被烤进镜像
#   · 容器内沿用宿主机的绝对路径（/root/migpt-next-2、/root/migpt-panel、
#     /root/tts-venv），所以引擎和面板里的路径常量一个字都不用改，
#     真正定位数据靠 MIGPT_* 环境变量（见 docker/entrypoint.sh）
#
# 国内网络构建请带上三个镜像源参数，不然光是拉包就要等很久：
#   docker build -t migpt-x \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/ \
#     --build-arg APT_MIRROR=mirrors.aliyun.com \
#     .
#
# 注意：这里刻意不写 `# syntax=docker/dockerfile:1`。那行会让 BuildKit 去
# 拉 docker/dockerfile 镜像，而它属于 Docker 官方命名空间、国内加速镜像
# 一般不代理，会卡在几十 KB/s。本文件没有用到任何需要该指令的新语法。

# 基础镜像可以换成任意镜像源。国内直连 Docker Hub 慢、或者 daemon.json 里配的
# 加速地址不通时，显式指定一个可用的即可：
#   --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-bookworm
#   --build-arg NODE_SLIM_IMAGE=docker.1ms.run/library/node:22-bookworm-slim
# 注意 daemon.json 里的 registry-mirrors 只对 docker.io 生效，而且它是**按顺序**尝试的，
# 只要列表里有一个坏的（比如返回 200 而不是 401 的伪 registry），整次拉取都会卡住。
ARG NODE_IMAGE=node:22-bookworm
ARG NODE_SLIM_IMAGE=node:22-bookworm-slim

# ─────────────────────────── 构建阶段 ───────────────────────────
FROM ${NODE_IMAGE} AS build

# CI=1 让 package.json 里的 postinstall（lefthook install）自动跳过 —— 镜像里没有 git 仓库
ENV CI=1
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 国内网络换成镜像源会快很多
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN pnpm config set registry "$NPM_REGISTRY"

# 先只拷依赖清单，让安装这一层能被缓存复用
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# 再拷全部源码构建（引擎运行时加载的是 packages/*/dist）
COPY . .
RUN pnpm run build

# ─────────────────────────── 运行阶段 ───────────────────────────
FROM ${NODE_SLIM_IMAGE}

# ffmpeg   引擎用 ffprobe 估算音频时长（等播完再补唤醒指令），并用 atempo 调速
# python3  微软 edge-tts 引擎需要
ARG APT_MIRROR=
ARG PIP_INDEX=https://pypi.org/simple/
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# 微软 edge-tts 装在固定路径：引擎 config.js 里写死了 /root/tts-venv/bin/edge-tts
RUN python3 -m venv /root/tts-venv \
 && /root/tts-venv/bin/pip install --no-cache-dir -q \
      --index-url "$PIP_INDEX" edge-tts==7.2.8

WORKDIR /root/migpt-next-2
COPY --from=build /app /root/migpt-next-2

# 控制台面板
COPY panel /root/migpt-panel

# 用转发脚本替换 pip 生成的同名 console script
# （pip 装的那个只认 edge-tts 自己的命令行参数，我们的引擎调用约定不一样）
# supervisor.mjs 在 panel/ 目录里，已经被上面那条 COPY 一起带进来了
COPY docker/edge-tts /root/tts-venv/bin/edge-tts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /root/tts-venv/bin/edge-tts /usr/local/bin/entrypoint.sh

ENV MIGPT_MODE=local \
    MIGPT_DATA_DIR=/data \
    MIGPT_ENGINE_DIR=/root/migpt-next-2 \
    MIGPT_CODE_DIR=/root/migpt-panel \
    MIGPT_PANEL_DIR=/data \
    MIGPT_TTS_VENV=/root/tts-venv \
    MIGPT_PORT=36593 \
    MIGPT_TTS_PORT=36594 \
    NODE_ENV=production

# 把虚拟环境放到 PATH 最前面：tts_server.py 是进程内 import edge_tts 的，
# 用系统 python3 起会直接 ModuleNotFoundError。宿主机上 systemd 也是用
# /root/tts-venv/bin/python3 启动它的。
ENV PATH="/root/tts-venv/bin:$PATH"

VOLUME ["/data"]
EXPOSE 36593

# 面板能应答即算健康（用 shell 形式才会展开环境变量）
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${MIGPT_PORT}/api/state" > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
