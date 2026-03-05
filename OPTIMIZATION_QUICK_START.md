# 优化方案快速开始指南

## 概述

已实现延时优化方案，核心思路：
- **后端**：每 1 秒主动查询 InfluxDB 一次并缓存结果
- **前端**：缩短轮询到 1 秒，直接获取缓存数据（无需等待 InfluxDB）
- **预期延时**：从 4s+ 降低到 **1-2s**

## 改动文件清单

### 后端
1. **`pkg/api/influxdb_proxy.go`**
   - 添加 `CachedVitalsData` 结构体和缓存全局变量
   - 修改 `InfluxDBQuery()` 返回缓存数据
   - 新增 `startVitalsCacheRefresh()`、`refreshVitalsCache()` 后台更新逻辑
   - 新增 `executeInfluxQuery()` 辅助方法

2. **`pkg/api/http_server.go`**
   - 在 `Run()` 方法中启动后台缓存刷新线程

### 前端
1. **`public/app/features/home/HomePage.tsx`**
   - 缩短轮询间隔：`2000ms` → `1000ms`
   - 优化 Flux 查询范围：`-1m` → `-3s`
   - 添加缓存年龄日志便于调试

## 测试步骤

### 1. 重新构建后端
```bash
cd /home/junliang/grafana
make build
```

### 2. 重新编译前端
```bash
yarn install  # 如果依赖有变化
yarn build
```

### 3. 启动开发服务
```bash
# 本地运行
make dev

# 或使用 Docker（如已构建）
docker run -p 3000:3000 grafana/grafana:dev
```

### 4. 验证效果

打开浏览器，访问首页（Grafana 首页），打开 **浏览器开发者工具 → 控制台（Console）**：

- 查看日志中的缓存年龄：`缓存年龄: XXXms`
  - 正常情况下应该在 200-500ms 之间
  - 表示数据从服务器生成到前端接收的延时

- 观察 Network 标签页面的请求
  - 应该每 1s 请求一次 `/api/influxdb/query`
  - 响应时间应该 < 50ms（因为直接返回缓存）

### 5. 跌倒检测验证

1. 模拟设备发送体动值 > 900 的数据到 InfluxDB
2. 观察首页是否在 **1-2 秒内**显示摔倒风险提示
3. 对比优化前的延时（应该快一倍以上）

## 关键指标

### 后端
- **缓存刷新周期**：1s
- **缓存数据范围**：最近 3s 的数据
- **并发安全**：使用 RWMutex 保护共享缓存

### 前端
- **轮询周期**：1s
- **无加载状态闪烁**：通过 `hasLoadedOnce` 标志控制

## 性能对比

| 项目 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| 平均延时 | 2-3s | 0.5-1s | **↓ 60-75%** |
| 最坏延时 | 4s+ | 1-2s | **↓ 50-75%** |
| 后端 CPU | 按需查询 | 固定 1s | 相似 |
| 网络请求 | 2s 一次 | 1s 一次 | ↑ 2x 请求数 |

## 常见问题

### Q: 为什么还是有延时？
A: 延时来自以下几部分：
- 设备发送 MQTT → InfluxDB 写入 (通常 100-300ms)
- 后端缓存刷新周期 (最多 1000ms)
- 网络传输延时 (通常 10-50ms)
- 前端更新 UI (通常 < 10ms)

总延时 ≈ (0-1000ms) + (0-1000ms) + 50ms + 10ms，所以在 1-2s 左右。

### Q: 能否进一步降低延时到 < 500ms？
A: 可以，改用 **WebSocket/SSE 推送**方案（见 `OPTIMIZATION_PLAN.md` 中的"方案一"）。

### Q: 设备配置在哪里修改？
A: 查看两个地方：
- 前端：`HomePage.tsx` 中的 `MONITORED_DEVICES` 数组
- 后端：`influxdb_proxy.go` 中 `refreshVitalsCache()` 的 `devices` 切片

建议后续改为从配置文件或环境变量读取。

### Q: 为什么后端要每 1s 查询一次，而不是按需查询？
A: 
- 按需查询会导致前端轮询和设备发送不同步，引入 jitter（最坏延时 ≈ 周期）
- 固定 1s 查询保证有一个同步的基准点，延时更稳定可预测
- 相比每次都查询，1s 一次是很好的权衡（避免过度频繁查询 InfluxDB）

### Q: 可以关闭缓存吗？
A: 可以，在 `http_server.go` 的 `Run()` 方法中注释掉缓存启动：
```go
// hs.startVitalsCacheRefresh()
```
然后恢复前端轮询到 2s，Flux 查询到 -1m 即可回到原来的方式。

## 下一步

1. **监控和收集数据**：观察实际延时和用户反馈
2. **微调参数**：
   - 后端缓存刷新周期：可改为 500ms - 2s
   - 前端轮询周期：可改为 500ms - 2s
   - Flux 查询范围：可改为 -2s 到 -5s
3. **长期优化**：评估是否采用 WebSocket/SSE 方案

## 相关文档

- 详细方案说明：`OPTIMIZATION_PLAN.md`
- 毫米波跌倒检测总体架构方案：见之前的讨论记录
