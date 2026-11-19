FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bubblewrap fontconfig fonts-noto-cjk && fc-cache -fv && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.170.0
WORKDIR /opt/runtime
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/job/package.json packages/job/package.json
COPY packages/job/tsconfig.json packages/job/tsconfig.json
RUN npm ci --workspace=packages/shared --workspace=packages/job
COPY packages/shared packages/shared
RUN npm -w packages/shared run build
COPY ops/tokyo-repair/cloud.mjs ops/tokyo-repair/controller.mjs ops/tokyo-repair/detect.mjs ops/tokyo-repair/diagnostic.mjs ops/tokyo-repair/policy.mjs ops/tokyo-repair/recovery.mjs ops/tokyo-repair/replay.mjs ops/tokyo-repair/sheet.mjs ops/tokyo-repair/source.mjs ops/tokyo-repair/worker.mjs /opt/runtime/ops/tokyo-repair/
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENTRYPOINT ["node","/opt/runtime/ops/tokyo-repair/controller.mjs"]
