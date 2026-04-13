package api

import (
	"bytes"
	"context"
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

	"github.com/grafana/grafana/pkg/api/response"
	"github.com/grafana/grafana/pkg/infra/db"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/web"
)

var (
	influxURL       = getenv("INFLUXDB_URL", "https://influx.lanhc.com")
	influxToken     = getenv("INFLUXDB_TOKEN", "kcF_lnBLOpnArrmmHytfGCeo5bGh5LQJb_d6wxyBZntWUbz-KyUv8UH_3huFP5Ac3SjOwX5KniuEmgpV_WUwYQ==")
	influxOrg       = getenv("INFLUXDB_ORG", "ld6002h")
	defaultBucket   = getenv("INFLUXDB_BUCKET", "vitals_data")
	defaultDeviceIDs = getenv("DEVICE_IDS", "ACA704DA4B80,C04E309BB608,D0CF1316DEC4") // 固定时间循环回放设备列表
	defaultDeviceID = getenv("DEVICE_ID", "D0CF1316DEC4")
	fallbackDeviceIDs = []string{"B8F862F6BFD8", "84F7035346E0", "10B41DC081B2", "84F7035346E2"}
)

const vitalsFieldFilter = `r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "heart_rate" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm" or r["_field"] == "fall" or r["_field"] == "fall_count" or r["_field"] == "human" or r["_field"] == "spo2" or r["_field"] == "heart_rate_valid" or r["_field"] == "spo2_valid"`

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

func parseDeviceIDList(raw string) []string {
	result := make([]string, 0)
	seen := make(map[string]struct{})
	for _, deviceID := range strings.Split(raw, ",") {
		normalized := strings.TrimSpace(strings.ToUpper(deviceID))
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func buildDeviceFilterExpr(devices []string) string {
	if len(devices) == 0 {
		return "false"
	}
	filters := make([]string, 0, len(devices))
	for _, d := range devices {
		filters = append(filters, fmt.Sprintf(`r["device_id"] == "%s"`, d))
	}
	return strings.Join(filters, " or ")
}

func excludeDevices(all []string, excluded []string) []string {
	if len(all) == 0 {
		return nil
	}
	excludedSet := make(map[string]struct{}, len(excluded))
	for _, d := range excluded {
		excludedSet[strings.TrimSpace(strings.ToUpper(d))] = struct{}{}
	}

	result := make([]string, 0, len(all))
	for _, d := range all {
		normalized := strings.TrimSpace(strings.ToUpper(d))
		if normalized == "" {
			continue
		}
		if _, exists := excludedSet[normalized]; exists {
			continue
		}
		result = append(result, normalized)
	}

	return result
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

// ===== 固定时间段回放模式 =====
// 一次性拉取 2026-03-07 19:00 ~ 19:05 的数据，按秒循环回放

var (
	// 固定时间段的全量数据（启动时从 InfluxDB 拉取一次）
	fixedPeriodData      []map[string]string
	fixedPeriodDataMutex sync.RWMutex
	fixedPeriodLoaded    bool

    // 固定时间段起止（UTC）
fixedStart = time.Date(2026, 4, 9, 14, 50, 0, 0, time.UTC) // 4月9日 22:50 CST = 4月9日 14:50 UTC
fixedEnd   = time.Date(2026, 4, 9, 15, 10, 0, 0, time.UTC) // 4月9日 23:10 CST = 4月9日 15:10 UTC
	fixedDuration = fixedEnd.Sub(fixedStart)                     // 5 分钟
)

// 后端主动查询 InfluxDB 并更新缓存（后台运行）——固定时间段循环回放模式
func (hs *HTTPServer) startVitalsCacheRefresh() {
	go func() {
		fixedReplayDevices := parseDeviceIDList(defaultDeviceIDs)
		if len(fixedReplayDevices) == 0 {
			fixedReplayDevices = parseDeviceIDList(defaultDeviceID)
		}

		// 1) 一次性加载固定设备在固定时段的数据，供循环回放
		hs.loadFixedPeriodData(fixedReplayDevices)

		// 2) 并行策略：固定设备走循环回放，其他设备走实时拉取
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		startPlayback := time.Now()
		var (
			realtimeDevices    []string
			realtimeRows       []map[string]string
			lastDeviceReloadAt time.Time
			lastRealtimeAt     time.Time
		)

		for range ticker.C {
			now := time.Now()

			if realtimeDevices == nil || now.Sub(lastDeviceReloadAt) >= 30*time.Second {
				allConfigured := hs.loadConfiguredDeviceIDs()
				realtimeDevices = excludeDevices(allConfigured, fixedReplayDevices)
				lastDeviceReloadAt = now
			}

			if now.Sub(lastRealtimeAt) >= 2*time.Second {
				rows, err := hs.fetchRealtimeVitals(realtimeDevices)
				if err != nil {
					hs.log.Error("Failed to refresh realtime vitals data", "error", err, "deviceCount", len(realtimeDevices))
				} else {
					realtimeRows = rows
				}
				lastRealtimeAt = now
			}

			fixedRows := hs.replayFixedVitals(startPlayback)
			merged := make([]map[string]string, 0, len(fixedRows)+len(realtimeRows))
			merged = append(merged, fixedRows...)
			merged = append(merged, realtimeRows...)

			vitalsCacheMutex.Lock()
			vitalsCache = CachedVitalsData{
				Results:   merged,
				Timestamp: now.UnixMilli(),
			}
			vitalsCacheMutex.Unlock()
		}
	}()
}

// loadFixedPeriodData 一次性从 InfluxDB 拉取固定 5 分钟的数据
func (hs *HTTPServer) loadFixedPeriodData(devices []string) {
	if len(devices) == 0 {
		hs.log.Warn("No devices found for fixed period replay")
		return
	}

	deviceFilter := buildDeviceFilterExpr(devices)

	fluxQuery := fmt.Sprintf(`from(bucket: "%s")
  |> range(start: %s, stop: %s)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
	|> filter(fn: (r) => %s)
  |> filter(fn: (r) => %s)`,
		defaultBucket,
		fixedStart.Format(time.RFC3339),
		fixedEnd.Format(time.RFC3339),
		vitalsFieldFilter,
		deviceFilter,
	)

	hs.log.Info("Loading fixed period data from InfluxDB",
		"start", fixedStart.Format(time.RFC3339),
		"stop", fixedEnd.Format(time.RFC3339))

	for retries := 0; retries < 5; retries++ {
		data, err := hs.executeInfluxQuery(fluxQuery)
		if err != nil {
			hs.log.Error("Failed to load fixed period data, retrying...", "error", err, "retry", retries+1)
			time.Sleep(3 * time.Second)
			continue
		}

		fixedPeriodDataMutex.Lock()
		fixedPeriodData = data
		fixedPeriodLoaded = true
		fixedPeriodDataMutex.Unlock()

		hs.log.Info("Fixed period data loaded successfully", "recordCount", len(data))
		return
	}

	hs.log.Error("Failed to load fixed period data after all retries")
}

func (hs *HTTPServer) fetchRealtimeVitals(devices []string) ([]map[string]string, error) {
	if len(devices) == 0 {
		return nil, nil
	}

	deviceFilter := buildDeviceFilterExpr(devices)
	fluxQuery := fmt.Sprintf(`from(bucket: "%s")
  |> range(start: -8s)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => %s)
  |> filter(fn: (r) => %s)`,
		defaultBucket,
		vitalsFieldFilter,
		deviceFilter,
	)

	return hs.executeInfluxQuery(fluxQuery)
}

type deviceMACRow struct {
	DeviceMAC string `xorm:"device_mac"`
}

func (hs *HTTPServer) loadConfiguredDeviceIDs() []string {
	devices := make([]string, 0)
	seen := make(map[string]struct{})

	appendDevice := func(deviceID string) {
		deviceID = strings.TrimSpace(strings.ToUpper(deviceID))
		if deviceID == "" {
			return
		}
		if _, exists := seen[deviceID]; exists {
			return
		}
		seen[deviceID] = struct{}{}
		devices = append(devices, deviceID)
	}

	for _, deviceID := range strings.Split(defaultDeviceIDs, ",") {
		appendDevice(deviceID)
	}

	err := hs.SQLStore.WithDbSession(context.Background(), func(sess *db.Session) error {
		var rows []deviceMACRow
		if err := sess.SQL("SELECT DISTINCT device_mac FROM device WHERE device_mac IS NOT NULL AND device_mac <> ''").Find(&rows); err != nil {
			return err
		}

		for _, row := range rows {
			appendDevice(row.DeviceMAC)
		}

		return nil
	})
	if err != nil {
		hs.log.Error("Failed to load devices from device table, using fallback list", "error", err)
	}

	if len(devices) == 0 {
		for _, deviceID := range fallbackDeviceIDs {
			appendDevice(deviceID)
		}
		appendDevice(defaultDeviceID)
	}

	return devices
}

// replayFixedVitals 根据当前墙钟时间计算在固定窗口内的偏移，返回对应秒的数据
func (hs *HTTPServer) replayFixedVitals(startPlayback time.Time) []map[string]string {
	fixedPeriodDataMutex.RLock()
	if !fixedPeriodLoaded || len(fixedPeriodData) == 0 {
		fixedPeriodDataMutex.RUnlock()
		return nil
	}
	allData := fixedPeriodData
	fixedPeriodDataMutex.RUnlock()

	// 当前回放已经过去了多少时间，对 5 分钟取模，实现循环
	elapsed := time.Since(startPlayback)
	offset := elapsed % fixedDuration // 0 ~ 5min 循环

	// 当前虚拟时间点
	virtualNow := fixedStart.Add(offset)
	windowStart := virtualNow.Add(-5 * time.Second) // 取前 5 秒的数据窗口

	// 从全量数据中筛选落在 [windowStart, virtualNow] 的记录
	var matched []map[string]string
	for _, row := range allData {
		tStr, ok := row["_time"]
		if !ok {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, tStr)
		if err != nil {
			t, err = time.Parse(time.RFC3339, tStr)
			if err != nil {
				continue
			}
		}
		if (t.Equal(windowStart) || t.After(windowStart)) && (t.Equal(virtualNow) || t.Before(virtualNow)) {
			matched = append(matched, row)
		}
	}

	// 如果当前窗口没数据，取最近的一条（避免空白）
	if len(matched) == 0 {
		matched = findClosestRecords(allData, virtualNow)
	}

	hs.log.Debug("Vitals cache replayed",
		"virtualTime", virtualNow.Format(time.RFC3339),
		"matchedRecords", len(matched),
		"offset", offset.String())

	return matched
}

// findClosestRecords 当窗口内无数据时，找到离 virtualNow 最近的每个 device+field 的记录
func findClosestRecords(allData []map[string]string, virtualNow time.Time) []map[string]string {
	type key struct {
		deviceID string
		field    string
	}
	closest := make(map[key]map[string]string)
	closestDiff := make(map[key]time.Duration)

	for _, row := range allData {
		tStr, ok := row["_time"]
		if !ok {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, tStr)
		if err != nil {
			t, err = time.Parse(time.RFC3339, tStr)
			if err != nil {
				continue
			}
		}
		k := key{deviceID: row["device_id"], field: row["_field"]}
		diff := virtualNow.Sub(t)
		if diff < 0 {
			diff = -diff
		}
		if prev, exists := closestDiff[k]; !exists || diff < prev {
			closestDiff[k] = diff
			closest[k] = row
		}
	}

	result := make([]map[string]string, 0, len(closest))
	for _, row := range closest {
		result = append(result, row)
	}
	return result
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
