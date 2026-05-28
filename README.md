# FanControlServer

飞牛私有云（fnOS）智能风扇与温度管理工具。

## 界面预览

<a href="./docs/images/screenshot1.png"><img src="./docs/images/screenshot1.png" width="500"></a>
<a href="./docs/images/screenshot2.png"><img src="./docs/images/screenshot2.png" width="500"></a>
<br>
<a href="./docs/images/screenshot3.png"><img src="./docs/images/screenshot3.png" width="500"></a>
<a href="./docs/images/screenshot4.png"><img src="./docs/images/screenshot4.png" width="500"></a>

## 功能特性

**风扇控制**
- 基于 Linux sysfs PWM 的多风扇独立控制
- 手动 / 曲线自动两种调速模式
- 每个风扇可独立选择温度源：CPU / GPU / 硬盘平均 / 最大值 / 指定硬盘
- 首次运行自动扫描风扇并写入配置
- 硬件指纹（stable_id）绑定，防止重启风扇路径变更

**硬件监控**
- 实时 CPU / GPU / 内存 / 硬盘温度及使用率
- 支持 NVMe / SATA 硬盘温度读取，区分活跃与待机状态
- 历史温度曲线图表（ECharts）

**安全机制**
- 过热保护：超过阈值自动全速
- 停转回滞：防止临界温度频繁启停
- 进程退出行为可选（保持当前或指定 PWM）
- 支持飞牛统一网关认证（需 fnos系统 1.1.3104+）

**其他**
- 响应式 Web 深色界面，WebSocket 实时推送
- 无外部 CDN 依赖，所有前端资源本地打包
- 默认端口 19527

## 技术栈

- **后端**：Go + Gin + WebSocket + logrus
- **前端**：Vite + TypeScript + Tailwind CSS + ECharts
- **数据来源**：hwmon sysfs、smartctl、hdparm、nvidia-smi

## 构建

需要 Go 1.24+ 和 Node.js 18+。

```bash
# Linux / macOS
./scripts/build.sh

# Windows PowerShell
.\scripts\build.ps1
```

脚本自动完成：前端编译 → Go 交叉编译（内嵌前端）→ fnpack 打包。

产物：`dist/*.fpk`

## 安装

```bash
appcenter-cli install-fpk dist/FanControlServer.fpk
```

安装向导可配置：服务端口、是否允许外部访问、是否启用认证。

## 目录结构

```
├── backend/          # Go 后端源码（go:embed 内嵌前端）
├── frontend/         # 前端源码（Vite + TS + Tailwind）
├── scripts/          # 构建脚本（build.sh / build.ps1）
├── app/              # 飞牛应用目录（server/ 为编译产物，ui/ 为桌面入口）
├── cmd/              # 飞牛生命周期脚本（启停、安装、卸载等）
├── config/           # 飞牛权限 / 资源配置
├── wizard/           # 飞牛安装 / 配置 / 卸载向导
└── manifest          # 飞牛应用元数据
```

## Star History

<a href="https://www.star-history.com/?repos=guan-ry%2FFanControlServerApp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=guan-ry/FanControlServerApp&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=guan-ry/FanControlServerApp&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=guan-ry/FanControlServerApp&type=date&legend=top-left" />
 </picture>
</a>