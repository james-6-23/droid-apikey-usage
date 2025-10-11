# 🚀 API Key 余额监控看板

专为 **Deno Deploy** 设计的 API Key 管理系统。

## ✨ 核心功能

- 🔄 **Deno KV 持久化** - 全球分布式数据库
- 📦 **批量导入** - 支持数百个 API Key
- 🗑️ **便捷管理** - 列表中快速删除
- 🔒 **密码保护** - 环境变量配置安全访问
- 🎨 **Apple 设计** - FiraCode 字体 + 1.25x 放大列表

## 📝 部署步骤

### 1. fork 代码到github仓库


### 2. 部署到 Deno Deploy
1. 访问 [dash.deno.com](https://dash.deno.com)
2. 连接 GitHub 仓库
3. 入口文件：`main.ts`
4. 点击 Deploy

### 3. 配置密码（可选）
在项目设置 → Environment Variables 添加：
```
ADMIN_PASSWORD=你的密码
```

### 4. 开始使用
1. 访问 `https://your-project.deno.dev`
2. 输入密码登录（如设置了密码）
3. 点击 "⚙️ 管理密钥"
4. 批量导入 API Keys
5. 完成！

## 💡 使用说明

- **导入密钥**：点击 "⚙️ 管理密钥" → 批量粘贴（每行一个）→ 点击导入
- **查看余额**：主页自动显示统计卡片和详细表格
- **删除密钥**：管理面板 → 密钥列表 → 点击右侧"删除"按钮

## 🔒 安全提示

- ✅ API Key 存储在加密的 Deno KV 数据库中
- ✅ 界面上只显示密钥的前4位和后4位（如：`fk-tI...FQo`）
- ✅ Deno Deploy 提供自动 HTTPS 加密传输
- ✅ 建议设置 ADMIN_PASSWORD 环境变量保护访问

## 📝 更新日志

### v3.0.0 (当前版本)
- 🔒 密码保护（ADMIN_PASSWORD 环境变量）
- 🍎 FiraCode Nerd Font 字体
- 📏 列表放大 1.25x，优化字体渲染
- 🗑️ 删除按钮移到列表中，支持批量管理
- ✕ 关闭按钮移到弹窗右上角
- 📚 专注 Deno Deploy 部署

## 📄 许可

MIT License
