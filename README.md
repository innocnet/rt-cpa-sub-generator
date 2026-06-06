# RT CPA/SUB Generator

浏览器内运行的 RT CPA/Sub2API 生成器。页面是纯静态文件，Docker 版本使用 nginx 托管。

## Docker Compose

```bash
docker compose up --build
```

打开：

```text
http://localhost:8080/
```

## Docker

```bash
docker build -t rt-cpa-sub-generator:local .
docker run --rm -p 8080:80 rt-cpa-sub-generator:local
```

## 安全边界

RT 和 access token 只保存在浏览器内存中。刷新请求由浏览器直接发送到 `https://auth.openai.com/oauth/token`，容器本身不接收、不转发、不保存 token。
