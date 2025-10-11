# 🚀 Deno Deploy 部署指南

这是一份详细的部署到 Deno Deploy 的分步指南。

## 📋 前置要求

- GitHub 账号
- 本项目的代码仓库

## 🎯 部署步骤

### 步骤 1: 准备代码仓库

1. **Fork 本项目** 或 **创建新仓库**
   ```bash
   # 如果是本地项目，初始化 Git
   git init
   git add .
   git commit -m "Initial commit"

   # 推送到 GitHub
   git remote add origin https://github.com/你的用户名/你的仓库名.git
   git branch -M main
   git push -u origin main
   ```

### 步骤 2: 登录 Deno Deploy

1. 访问 [https://dash.deno.com](https://dash.deno.com)
2. 点击右上角 **"Sign in with GitHub"**
3. 授权 Deno Deploy 访问你的 GitHub 账号

### 步骤 3: 创建新项目

1. 在 Deno Deploy 控制台，点击 **"New Project"** 按钮

2. 选择部署方式：
   - **推荐**: 选择 "Deploy from GitHub repository"
   - 这样每次推送代码都会自动重新部署

3. 配置项目：
   - **Repository**: 选择你的仓库
   - **Branch**: 选择 `main` 分支
   - **Entry Point**: 输入 `main.ts`
   - **Project Name**: 输入项目名称（将成为你的 URL 的一部分）

4. 点击 **"Deploy Project"**

### 步骤 4: 等待部署完成

- 部署通常需要 10-30 秒
- 你可以在控制台看到实时日志
- 部署成功后，会显示你的应用 URL：`https://your-project-name.deno.dev`

### 步骤 5: 首次使用

1. 点击部署成功后的 URL
2. 点击右上角 **"⚙️ 管理密钥"**
3. 在文本框中粘贴你的 API Key（每行一个）
4. 点击 **"导入密钥"**
5. 关闭管理面板，点击 **"🔄 刷新数据"**

## 🔧 进阶配置

### 自定义域名

1. 在项目设置中，找到 **"Domains"** 选项
2. 点击 **"Add Domain"**
3. 输入你的域名（如：`api-monitor.yourdomain.com`）
4. 按照指示添加 DNS 记录（CNAME 或 A 记录）
5. 等待 DNS 传播（通常几分钟到几小时）

### 环境变量（可选）

如果你需要添加环境变量：

1. 在项目设置中，找到 **"Environment Variables"**
2. 点击 **"Add Variable"**
3. 添加你需要的环境变量，例如：
   ```
   ACCESS_PASSWORD=your_secret_password
   ```

### 自动部署

设置好 GitHub 集成后，每次推送代码都会自动触发部署：

```bash
# 修改代码后
git add .
git commit -m "Update features"
git push

# Deno Deploy 会自动检测并重新部署
```

## 📊 监控和日志

### 查看日志

1. 在 Deno Deploy 控制台，进入你的项目
2. 点击 **"Logs"** 标签
3. 可以实时查看应用日志，包括：
   - HTTP 请求
   - 错误信息
   - Console.log 输出

### 查看使用统计

1. 点击 **"Analytics"** 标签
2. 查看：
   - 请求数量
   - 响应时间
   - 错误率
   - 地理分布

## 🗄️ KV 数据库管理

### 查看数据

Deno Deploy 的 KV 数据自动创建和管理，你可以：

1. 在项目设置中找到 **"KV"** 选项
2. 查看存储的数据
3. 手动添加或删除键值对（用于调试）

### 数据持久化

- 数据自动在全球边缘节点同步
- 不需要备份（Deno Deploy 自动处理）
- 强一致性保证

## 🔒 安全建议

### 1. 限制访问（推荐）

为了保护你的 API Key，建议添加访问控制：

**方式 1: IP 白名单**
在项目设置中配置允许访问的 IP 地址

**方式 2: 添加密码保护**
修改代码添加简单的身份验证

### 2. 监控异常活动

定期检查：
- 异常的请求模式
- 未授权的访问尝试
- 数据变化

### 3. 定期更新密钥

建议定期轮换 API Key，删除不再使用的密钥。

## 🆘 故障排查

### 部署失败

**问题**: 部署时出错

**解决方案**:
1. 检查 `main.ts` 文件路径是否正确
2. 查看部署日志中的错误信息
3. 确保代码中没有语法错误
4. 检查是否使用了 Deno 不支持的 Node.js API

### 无法连接数据库

**问题**: KV 操作失败

**解决方案**:
1. 确保使用了 `--unstable-kv` 标志（Deno Deploy 自动添加）
2. 检查 KV 操作的语法是否正确
3. 查看日志中的详细错误信息

### 数据丢失

**问题**: 重新部署后数据消失

**解决方案**:
- Deno Deploy 的 KV 数据是持久化的，不会因为重新部署而丢失
- 如果数据真的丢失，可能是：
  1. 创建了新项目（不同的项目有独立的 KV 存储）
  2. 手动清空了数据库
  3. 代码中有清空数据的逻辑

## 📈 性能优化

### 1. 使用 CDN

Deno Deploy 自动使用全球 CDN，无需额外配置

### 2. 缓存策略

可以添加 HTTP 缓存头来提升性能：

```typescript
headers: {
  "Cache-Control": "public, max-age=60",
}
```

### 3. 压缩响应

Deno Deploy 自动启用 Gzip/Brotli 压缩

## 🌍 全球部署节点

Deno Deploy 在以下地区有边缘节点：

- 🇺🇸 美国（多个城市）
- 🇪🇺 欧洲（多个城市）
- 🇯🇵 日本（东京）
- 🇸🇬 新加坡
- 🇦🇺 澳大利亚（悉尼）
- 🇮🇳 印度（孟买）
- 🇧🇷 巴西（圣保罗）

你的应用会自动部署到最近的节点，确保全球用户都有快速的访问速度。

## 💰 费用说明

### 免费计划

- ✅ 100 万次请求/月
- ✅ 10 万次 KV 读取/天
- ✅ 1 万次 KV 写入/天
- ✅ 无限数据存储
- ✅ 35+ 全球边缘节点
- ✅ 自动 HTTPS
- ✅ 自定义域名

### 付费计划

如果免费配额不够用，可以升级到付费计划：
- 更多请求数
- 更多 KV 操作
- 优先支持

## 📚 更多资源

- [Deno Deploy 官方文档](https://deno.com/deploy/docs)
- [Deno KV 文档](https://deno.com/kv)
- [Deno 官方网站](https://deno.land)
- [本项目 README](./README.md)

## 🎉 部署完成！

恭喜！你的 API Key 监控系统已经成功部署到全球边缘网络。

访问你的应用：`https://your-project-name.deno.dev`

享受快速、安全、免费的云服务吧！🚀
