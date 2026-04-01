FROM node:20-slim
WORKDIR /app

# Sharp のネイティブビルド依存 + 日本語フォント（SVG価格テキスト描画に必須）
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ \
    fontconfig fonts-noto-cjk && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

# package files だけ先にコピー（キャッシュ効率化）
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/job/package.json packages/job/

RUN npm ci --workspace=packages/shared --workspace=packages/api --workspace=packages/job

# ソースコピー & ビルド
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/
COPY packages/job/ packages/job/

RUN npm run build -w packages/shared && \
    npm run build -w packages/api && \
    npm run build -w packages/job

EXPOSE 8080
CMD ["node", "packages/api/dist/index.js"]
