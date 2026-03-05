# 毫米波跌倒检测延时优化方案

## 现状问题

原本的架构中，前端每 2 秒轮询一次后端 `/api/influxdb/query` 接口，后端每次都直接查询 InfluxDB。由于设备也是 2 秒发送一次数据，且轮询时间不同步，最坏情况下延时接近 **4s+**。

```
设备 (2s 发送) 
  ↓ 
InfluxDB 
  ↓ 
后端查询 (每次都打 InfluxDB) 
  ↓ 
前端轮询 (2s 一次) 
  ↓ 
UI 展示
```

## 实现的优化方案

### 后端改进（Go）

**文件：`pkg/api/influxdb_proxy.go` 和 `pkg/api/http_server.go`**

#### 1. 添加内存缓存机制
- 新增 `CachedVitalsData` 结构体存储查询结果和时间戳
- 使用 RWMutex 保证并发安全的读写

```go
type CachedVitalsData struct {
    Results   []map[string]string `json:"results"`
    Timestamp int64               `json:"timestamp"` // Unix 毫秒时间戳
}

var (
    vitalsCache      CachedVitalsData
    vitalsCacheMutex sync.RWMutex
)
```

#### 2. 后端主动查询（每 1s 一次）
- 新增 `startVitalsCacheRefresh()` 方法在后台启动 ticker
- 每 1 秒自动调用 `refreshVitalsCache()` 更新缓存
- 查询时间范围缩小到 **-3s**（只取最近 3 秒数据）

```go
func (hs *HTTPServer) startVitalsCacheRefresh() {
    go func() {
        ticker := time.NewTicker(1 * time.Second)
        defer ticker.Stop()

        for range ticker.C {
            hs.refreshVitalsCache()
        }
    }()
}
```

#### 3. API 返回缓存而不是直接查询
- `/api/influxdb/query` 直接返回缓存的数据
- 响应中包含 `timestamp` 字段表示缓存生成时间

```go
func (hs *HTTPServer) InfluxDBQuery(c *contextmodel.ReqContext) response.Response {
    vitalsCacheMutex.RLock()
    cachedData := vitalsCache
    vitalsCacheMutex.RUnlock()

    return response.JSON(http.StatusOK, map[string]any{
        "results": cachedData.Results, 
        "timestamp": cachedData.Timestamp,
    })
}
```

#### 4. 在 HTTPServer.Run() 中启动缓存刷新
- 在服务启动时调用 `hs.startVitalsCacheRefresh()`

### 前端改进（React/TypeScript）

**文件：`public/app/features/home/HomePage.tsx`**

#### 1. 缩短轮询间隔到 1s
```typescript
useEffect(() => {
  fetchVitals({ showIndicator: true });
  const interval = setInterval(() => {
    fetchVitals();
  }, 1000); // 从 2000ms 改为 1000ms
  return () => clearInterval(interval);
}, [fetchVitals]);
```

#### 2. 优化 Flux 查询范围
```typescript
const buildFluxQuery = (bucket: string, devices: DeviceConfig[]): string => {
  return `from(bucket: "${bucket}")
  |> range(start: -3s)  // 从 -1m 改为 -3s
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  // ... 其他过滤条件
}
```

#### 3. 添加缓存年龄日志
```typescript
if (response?.timestamp) {
  const cacheAge = Date.now() - response.timestamp;
  console.info(`缓存年龄: ${cacheAge}ms`);
}
```

## 预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 设备发送周期 | 2s | 2s |
| 后端查询周期 | 按需（随前端请求） | **1s** |
| 前端轮询周期 | 2s | **1s** |
| 最坏延时 | 4s+ | **1-2s** |
| 平均延时 | 2-3s | **0.5-1s** |
| InfluxDB 查询压力 | 中等 | 相似（固定 1s 一次） |
| 网络带宽 | 低 | 相似（每 1s 一次） |

## 架构改进示意图

优化后的数据流：

```
[设备 2s 发送]
      ↓
[InfluxDB]
      ↓
[后端缓存 (1s 自动更新)]
      ↓
[前端 1s 轮询] → 直接返回缓存 (无需等待 InfluxDB)
      ↓
[UI 展示] (低延时)
```

## 调试和监控

### 后端日志
```
INFO HTTP Server: Started vitals cache refresh background job
INFO InfluxDB proxy: Vitals cache refreshed recordCount=12 
DEBUG InfluxDB proxy: Returning cached vitals data recordCount=12 cacheAge=234ms
```

### 前端日志
```
INFO: 开始执行 HomePage.fetchVitals()
INFO: InfluxDB 响应: {...}
INFO: 缓存年龄: 245ms
```

查看浏览器控制台可以观察缓存年龄，验证优化效果。

## 后续调整

如需进一步优化：

1. **如果延时仍然较大（> 2s）：** 考虑使用 WebSocket/SSE 推送（见总体方案文档）
2. **如果需要实时告警：** 在后端服务中完成跌倒判断，通过 WebSocket 推送告警事件
3. **如果 InfluxDB 查询仍是瓶颈：** 减少查询范围或增加缓存间隔
4. **如果需要多设备：** 当前设备列表硬编码在 `refreshVitalsCache()`，可改为配置文件或环境变量

## 回滚方案

如果优化后出现问题，可快速回滚：

1. 在 `http_server.go` 的 Run() 方法中注释掉 `hs.startVitalsCacheRefresh()`
2. 恢复前端轮询间隔为 2000ms
3. 恢复 Flux 查询范围为 -1m

所有改动都是向下兼容的，无需修改数据库或其他服务。
