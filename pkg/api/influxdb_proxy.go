// pkg/api/influxdb_proxy.go
package api

import (
    "bytes"
    "encoding/csv"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "strings"
    "sync"
    "time"

    contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
    "github.com/grafana/grafana/pkg/api/response"
    "github.com/grafana/grafana/pkg/web"
)

var (
    influxURL        = getenv("INFLUXDB_URL", "https://influx.lanhc.com")
    influxToken      = getenv("INFLUXDB_TOKEN", "kcF_lnBLOpnArrmmHytfGCeo5bGh5LQJb_d6wxyBZntWUbz-KyUv8UH_3huFP5Ac3SjOwX5KniuEmgpV_WUwYQ==")
    influxOrg        = getenv("INFLUXDB_ORG", "ld6002h")
    defaultBucket    = getenv("INFLUXDB_BUCKET", "vitals_data")
    defaultDeviceID  = getenv("DEVICE_ID", "84F7035346E0")
)

// 缓存结构体，用于后端主动查询缓存
type CachedVitalsData struct {
    Results   []map[string]string `json:"results"`
    Timestamp int64               `json:"timestamp"` // Unix 毫秒时间戳
}

var (
    vitalsCache      CachedVitalsData
    vitalsCacheMutex sync.RWMutex
)

func getenv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}

type InfluxDBQueryRequest struct {
    Query    string `json:"query,omitempty"`
    Field    string `json:"field,omitempty"`
    Mode     string `json:"mode,omitempty"` // tma2m / mean5m
    Bucket   string `json:"bucket,omitempty"`
    DeviceID string `json:"deviceId,omitempty"`
}

type InfluxDBQueryResponse struct {
    Results []interface{} `json:"results,omitempty"`
    Error   string        `json:"error,omitempty"`
}

// InfluxDBQuery 处理 InfluxDB Flux 查询请求 - 返回缓存数据
func (hs *HTTPServer) InfluxDBQuery(c *contextmodel.ReqContext) response.Response {
    var req InfluxDBQueryRequest
    
    if err := web.Bind(c.Req, &req); err != nil {
        hs.log.Error("Failed to parse request", "error", err)
        return response.Error(http.StatusBadRequest, "Invalid request body", err)
    }

    // 直接返回缓存数据，而不是每次都查询 InfluxDB
    vitalsCacheMutex.RLock()
    cachedData := vitalsCache
    vitalsCacheMutex.RUnlock()

    if cachedData.Results == nil {
        hs.log.Warn("Cache is empty, returning empty results")
        return response.JSON(http.StatusOK, map[string]any{"results": []interface{}{}, "timestamp": time.Now().UnixMilli()})
    }

    hs.log.Info("Returning cached vitals data", "recordCount", len(cachedData.Results), "cacheAge", time.Now().UnixMilli()-cachedData.Timestamp)
    return response.JSON(http.StatusOK, map[string]any{"results": cachedData.Results, "timestamp": cachedData.Timestamp})
}

// 辅助函数
func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}

func firstNonEmpty(values ...string) string {
    for _, v := range values {
        if strings.TrimSpace(v) != "" {
            return v
        }
    }
    return ""
}

func fluxSampleTMA2M(bucket, deviceID, field string) string {
    return fmt.Sprintf(`from(bucket: "%s")
  |> range(start: -12h)
  |> filter(fn: (r) => r["device_id"] == "%s")
  |> filter(fn: (r) => r["_field"] == "%s")
  |> filter(fn: (r) => r._value != 0)
  |> timedMovingAverage(every: 5m, period: 10m)
  |> filter(fn: (r) => r._value != 0)`, bucket, deviceID, field)
}

func fluxMean5m(bucket, deviceID, field string) string {
    return fmt.Sprintf(`from(bucket: "%s")
  |> range(start: -2m)
  |> filter(fn: (r) => r["device_id"] == "%s")
  |> filter(fn: (r) => r["_field"] == "%s")
  |> filter(fn: (r) => r._value != 0)
  |> mean()`, bucket, deviceID, field)
}

func parseFluxCSV(body []byte) ([]map[string]string, error) {
    reader := csv.NewReader(bytes.NewReader(body))
    reader.FieldsPerRecord = -1

    var (
        headers []string
        rows    []map[string]string
    )

    for {
        record, err := reader.Read()
        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, err
        }
        if len(record) == 0 {
            continue
        }
        if strings.HasPrefix(record[0], "#") {
            headers = nil
            continue
        }
        if headers == nil {
            headers = record
            continue
        }
        row := make(map[string]string, len(headers))
        for i, h := range headers {
            if i < len(record) {
                row[h] = record[i]
            }
        }
        rows = append(rows, row)
    }
    return rows, nil
}

// 后端主动查询 InfluxDB 并更新缓存（后台运行）
func (hs *HTTPServer) startVitalsCacheRefresh() {
    go func() {
        ticker := time.NewTicker(1 * time.Second)
        defer ticker.Stop()

        for range ticker.C {
            hs.refreshVitalsCache()
        }
    }()
}

func (hs *HTTPServer) refreshVitalsCache() {
    // 构建查询语句 - 只查询最近 10 秒的数据
    devices := []string{
        "B8F862F6BFD8",  // room 1
        "84F7035346E0",  // room 2
        "10B41DC081B2",  // room 3
        "84F7035346E2",  // room 4
    }
    
    deviceFilter := strings.Join(
        func() []string {
            var filters []string
            for _, d := range devices {
                filters = append(filters, fmt.Sprintf(`r["device_id"] == "%s"`, d))
            }
            return filters
        }(),
        " or ",
    )

    fluxQuery := fmt.Sprintf(`from(bucket: "%s")
  |> range(start: -10s)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm")
  |> filter(fn: (r) => %s)`, defaultBucket, deviceFilter)

    data, err := hs.executeInfluxQuery(fluxQuery)
    if err != nil {
        hs.log.Error("Failed to refresh vitals cache", "error", err)
        return
    }

    vitalsCacheMutex.Lock()
    vitalsCache = CachedVitalsData{
        Results:   data,
        Timestamp: time.Now().UnixMilli(),
    }
    vitalsCacheMutex.Unlock()

    hs.log.Debug("Vitals cache refreshed", "recordCount", len(data))
}

func (hs *HTTPServer) executeInfluxQuery(fluxQuery string) ([]map[string]string, error) {
    // 构建 InfluxDB 查询 URL
    queryURL, err := url.Parse(fmt.Sprintf("%s/api/v2/query", influxURL))
    if err != nil {
        return nil, err
    }

    q := queryURL.Query()
    q.Set("org", influxOrg)
    queryURL.RawQuery = q.Encode()

    bodyBytes, err := json.Marshal(map[string]string{
        "query": fluxQuery,
    })
    if err != nil {
        return nil, err
    }

    httpReq, err := http.NewRequest("POST", queryURL.String(), bytes.NewReader(bodyBytes))
    if err != nil {
        return nil, err
    }

    httpReq.Header.Set("Authorization", fmt.Sprintf("Token %s", influxToken))
    httpReq.Header.Set("Accept", "text/csv")
    httpReq.Header.Set("Content-Type", "application/json")
    httpReq.Header.Set("User-Agent", "Grafana/12.3.0")

    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(httpReq)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("InfluxDB returned status %d: %s", resp.StatusCode, string(body))
    }

    contentType := resp.Header.Get("Content-Type")
    if strings.Contains(strings.ToLower(contentType), "text/csv") {
        return parseFluxCSV(body)
    }

    return nil, fmt.Errorf("unexpected content type: %s", contentType)
}