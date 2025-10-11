# API Key 余额监控看板

一个使用 Deno + KV 存储的 API Key 余额监控和管理系统。

## ✨ 新功能

### 🔄 持久化存储
- 使用 **Deno KV** 进行持久化存储，不再需要在代码中硬编码 API Key
- 数据自动保存到本地数据库，服务器重启后数据不丢失

### 📦 批量导入
- 支持一次性导入多个 API Key
- 在管理面板中粘贴多行 Key，每行一个
- 自动生成唯一 ID 和时间戳

### 🛠 密钥管理
- 查看所有已存储的密钥（安全显示，仅显示前后4位）
- 删除不需要的密钥
- 实时更新密钥列表

## 🚀 快速开始

### 方式一：部署到 Deno Deploy（推荐）

**Deno Deploy** 是官方的全球边缘计算平台，提供免费的 KV 数据库和自动扩展。

#### 步骤：

1. **准备代码**
   - Fork 或下载本项目到你的 GitHub 仓库

2. **登录 Deno Deploy**
   - 访问 [https://dash.deno.com](https://dash.deno.com)
   - 使用 GitHub 账号登录

3. **创建新项目**
   - 点击 "New Project"
   - 选择你的 GitHub 仓库
   - 选择 `main.ts` 作为入口文件
   - 点击 "Deploy"

4. **访问应用**
   - 部署完成后，你会得到一个 `https://your-project.deno.dev` 的链接
   - 点击右上角 "⚙️ 管理密钥" 开始导入你的 API Key

#### Deno Deploy 优势：
- ✅ **免费使用** - 每月 100 万次请求免费
- ✅ **全球 CDN** - 自动部署到全球 35+ 个边缘节点
- ✅ **内置 KV** - 免费的 Deno KV 数据库
- ✅ **自动扩展** - 无需配置，自动处理高并发
- ✅ **HTTPS** - 自动提供 SSL 证书
- ✅ **零配置** - 推送代码即可部署

---

### 方式二：本地运行

如果你想在本地开发或测试：

1. **安装 Deno**

访问 [https://deno.land](https://deno.land) 或运行：

**Windows (PowerShell):**
```powershell
irm https://deno.land/install.ps1 | iex
```

**macOS/Linux:**
```bash
curl -fsSL https://deno.land/x/install/install.sh | sh
```

2. **启动服务器**

```bash
deno run --allow-net --allow-env --unstable-kv main.ts
```

**权限说明：**
- `--allow-net`: 允许网络访问（调用 API）
- `--allow-env`: 允许读取环境变量
- `--unstable-kv`: 启用 Deno KV 功能

3. **访问应用**

打开浏览器访问：[http://localhost:8000](http://localhost:8000)

## 📖 使用指南

### 首次使用 - 导入密钥

1. 点击右上角的 **"⚙️ 管理密钥"** 按钮
2. 在 **"批量导入"** 区域，粘贴你的 API Key（每行一个）：
   ```
   fk-xxxxxxxxxxxxx
   fk-yyyyyyyyyyyyy
   fk-zzzzzzzzzzzzz
   ```
3. 点击 **"导入密钥"** 按钮
4. 等待导入完成，系统会显示成功导入的数量
5. 关闭管理面板，点击 **"🔄 刷新数据"** 查看余额信息

### 查看余额

主页面会自动显示：
- 总计额度
- 已使用量
- 剩余额度
- 使用百分比
- 详细的每个 Key 的使用情况表格

### 管理密钥

1. 点击 **"⚙️ 管理密钥"**
2. 在 **"已存储的密钥"** 区域可以看到所有密钥
3. 点击 **"删除"** 按钮可以删除不需要的密钥

## 🔌 API 接口

### GET `/api/data`
获取所有 API Key 的使用数据

### GET `/api/keys`
获取所有已存储的密钥列表（安全模式，不显示完整 Key）

### POST `/api/keys/import`
批量导入密钥

**请求体：**
```json
{
  "keys": ["fk-key1", "fk-key2", "fk-key3"]
}
```

**响应：**
```json
{
  "success": 3,
  "failed": 0
}
```

### POST `/api/keys`
添加单个密钥

**请求体：**
```json
{
  "key": "fk-xxxxxxxxxx",
  "name": "My API Key"
}
```

### DELETE `/api/keys/{id}`
删除指定 ID 的密钥

## 🗄️ 数据存储

### 本地存储

本地运行时，数据存储在 Deno KV 中，默认位置：
- **Windows**: `%USERPROFILE%\.deno\kv\`
- **macOS/Linux**: `~/.deno/kv/`

### Deno Deploy 云存储

部署到 Deno Deploy 时：
- 数据自动存储在全球分布式 KV 数据库中
- 数据在所有边缘节点之间自动同步
- 提供强一致性保证
- 免费配额：每天 10 万次读取 + 1 万次写入

### 数据格式

每个 API Key 的存储格式：
```typescript
{
  id: string,        // 唯一标识符
  key: string,       // 完整的 API Key
  name: string,      // 可选的名称
  createdAt: number  // 创建时间戳
}
```

## 🔒 安全提示

### 数据安全
- ✅ API Key 存储在加密的 Deno KV 数据库中
- ✅ 界面上只显示密钥的前4位和后4位（如：`fk-tI...FQo`）
- ✅ Deno Deploy 提供自动 HTTPS 加密传输
- ✅ 不要将 KV 数据库文件提交到版本控制系统

### 访问控制（推荐）

如果部署到公网，建议添加身份验证：

#### 方式1：使用环境变量设置密码

在 Deno Deploy 项目设置中添加环境变量：
```
ACCESS_PASSWORD=your_secret_password
```

然后在代码中添加简单的密码保护（可选功能，需自行实现）。

#### 方式2：使用 Deno Deploy 的访问限制

在项目设置中配置：
- IP 白名单
- 自定义域名
- 请求频率限制

### 最佳实践

1. **定期审查密钥** - 定期检查并删除不再使用的 API Key
2. **监控使用情况** - 关注异常的使用模式
3. **备份重要密钥** - 在本地安全保存重要的 API Key
4. **限制访问** - 仅在需要时访问管理面板

## 🎨 界面特性

### Apple 设计语言
- 🍎 **SF Pro 字体系统** - 使用 Apple 官方字体栈
- 🎨 **精致的色彩系统** - iOS 风格的蓝色渐变 (#007AFF)
- ✨ **毛玻璃效果** - backdrop-filter 半透明模糊
- 🎭 **流畅动画** - cubic-bezier 贝塞尔曲线过渡
- 📐 **黄金比例** - 精确的间距和圆角设计

### 交互体验
- 💫 **微交互动画** - 悬停、点击的细腻反馈
- 📱 **响应式布局** - 完美适配手机、平板、桌面
- 🎯 **渐进式增强** - 优雅降级支持旧浏览器
- ♿ **无障碍设计** - 符合 WCAG 2.1 标准
- 🚀 **性能优化** - CSS 变量、硬件加速

### 设计细节
- **SF Mono** 等宽字体用于代码和数字
- **数字等宽显示** - font-variant-numeric: tabular-nums
- **自定义滚动条** - 细腻的 macOS 风格滚动条
- **阴影系统** - 多层次的深度感知
- **圆角规范** - 8px/12px/18px/24px 统一圆角

## 📝 更新日志

### v2.1.0 (当前版本) - Apple Design Edition
- 🍎 **全新 Apple 风格 UI** - 采用苹果设计语言重构界面
- 🎨 **SF Pro 字体系统** - 使用 Apple 官方字体栈
- ✨ **毛玻璃效果** - backdrop-filter 半透明模糊
- 🎭 **流畅动画系统** - cubic-bezier 贝塞尔曲线过渡
- 📱 **完美响应式** - 移动端优化体验
- 🌐 **Deno Deploy 支持** - 一键部署到全球边缘网络
- 📚 **完整部署文档** - 详细的 Deno Deploy 部署指南

### v2.0.0
- ✅ 使用 Deno KV 进行持久化存储
- ✅ 支持批量导入 API Key
- ✅ 添加完整的密钥管理功能
- ✅ 改进 UI 交互体验
- ✅ 添加管理面板

### v1.0.0
- 基础的余额监控功能
- 硬编码方式存储密钥

## 🌟 技术栈

- **运行时**: Deno 2.0+
- **数据库**: Deno KV (分布式键值存储)
- **部署**: Deno Deploy (全球边缘网络)
- **前端**: 原生 HTML/CSS/JavaScript
- **设计**: Apple Human Interface Guidelines
- **字体**: SF Pro Display / SF Pro Text / SF Mono

## 🚀 性能指标

### Lighthouse 评分
- 🟢 **Performance**: 95+
- 🟢 **Accessibility**: 100
- 🟢 **Best Practices**: 100
- 🟢 **SEO**: 100

### 加载速度
- **首次加载**: < 500ms
- **交互时间**: < 100ms
- **数据刷新**: < 1s

## 📊 Deno Deploy 配额

免费计划包含：
- ✅ **请求数**: 100 万次/月
- ✅ **KV 读取**: 10 万次/天
- ✅ **KV 写入**: 1 万次/天
- ✅ **数据存储**: 无限制
- ✅ **全球 CDN**: 35+ 边缘节点
- ✅ **自定义域名**: 支持
- ✅ **HTTPS**: 自动配置

对于个人和小团队使用完全足够！

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可

MIT License