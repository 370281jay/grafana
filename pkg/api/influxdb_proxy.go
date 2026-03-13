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
    influxURL         = getenv("INFLUXDB_URL", "https://influx.lanhc.com")
    influxToken       = getenv("INFLUXDB_TOKEN", "kcF_lnBLOpnArrmmHytfGCeo5bGh5LQJb_d6wxyBZntWUbz-KyUv8UH_3huFP5Ac3SjOwX5KniuEmgpV_WUwYQ==")
    influxOrg         = getenv("INFLUXDB_ORG", "ld6002h")
    defaultBucket     = getenv("INFLUXDB_BUCKET", "vitals_data")
    defaultDeviceID   = getenv("DEVICE_ID", "84F7035346E0")
    fallbackDeviceIDs = []string{"B8F862F6BFD8", "84F7035346E0", "10B41DC081B2", "84F7035346E2"}
)

type CachedVitalsData struct {
    Results   []map[string]string `json:"results"`
    Timestamp int64               `json:"timestamp"`
}

var (
    vitalsCache      CachedVitalsData
    vitalsCacheMutex sync.RWMutex
)

func getenv(key, fallback string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return fallback
}

type InfluxDBQueryRequest struct {
    Query    string `json:"query,omitempty"`
    Field    string `json:"field,omitempty"`
    Mode     string `json:"mode,omitempty"`
    Bucket   string `json:"bucket,omitempty"`
    DeviceID string `json:"deviceId,omitempty"`
}

type InfluxDBQueryResponse struct {
    Results []interface{} `json:"results,omitempty"`
    Error   string        `json:"error,omitempty"`
}

func (hs *HTTPServer) InfluxDBQuery(c *contextmodel.ReqContext) response.Response {
    var req InfluxDBQueryRequest
    if err := web.Bind(c.Req, &req); err != nil {
        hs.log.Error("Failed to parse request", "error", err)
        return response.Error(http.StatusBadRequest, "Invalid request body", err)
    }

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

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}

func firstNonEmpty(values ...string) string {
    for _, value := range values {
        if strings.TrimSpace(value) != "" {
            return value
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
        for index, header := range headers {
            if index < len(record) {
                row[header] = record[index]
            }
        }
        rows = append(rows, row)
    }

    return rows, nil
}

var (
    fixedPeriodData      []map[string]string
    fixedPeriodDataMutex sync.RWMutex
    fixedPeriodLoaded    bool
    fixedStart           = time.Date(2026, 3, 7, 11, 0, 0, 0, time.UTC)
    fixedEnd             = time.Date(2026, 3, 7, 11, 5, 0, 0, time.UTC)
    fixedDuration        = fixedEnd.Sub(fixedStart)
)

func (hs *HTTPServer) startVitalsCacheRefresh() {
    go func() {
        hs.loadFixedPeriodData()

        replayTicker := time.NewTicker(1 * time.Second)
        defer replayTicker.Stop()

        reloadTicker := time.NewTicker(10 * time.Second)
        defer reloadTicker.Stop()

        startPlayback := time.Now()

        for {
            select {
            case <-replayTicker.C:
                hs.replayVitalsCache(startPlayback)
            case <-reloadTicker.C:
                hs.loadFixedPeriodData()
            }
        }
    }()
}

func (hs *HTTPServer) loadFixedPeriodData() {
    devices := hs.loadConfiguredDeviceIDs()

    filterParts := make([]string, 0, len(devices))
    for _, deviceID := range devices {
        filterParts = append(filterParts, fmt.Sprintf(`r["device_id"] == "%s"`, deviceID))
    }
    deviceFilter := strings.Join(filterParts, " or ")

    fluxQuery := fmt.Sprintf(`from(bucket: "%s")
  |> range(start: %s, stop: %s)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm")
  |> filter(fn: (r) => %s)`,
        defaultBucket,
        fixedStart.Format(time.RFC3339),
        fixedEnd.Format(time.RFC3339),
        deviceFilter,
    )

    hs.log.Info("Loading fixed period data from InfluxDB", "devices", strings.Join(devices, ","), "start", fixedStart.Format(time.RFC3339), "stop", fixedEnd.Format(time.RFC3339))

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

type homePageCardDeviceRow struct {
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

    err := hs.SQLStore.WithDbSession(context.Background(), func(sess *db.Session) error {
        var rows []homePageCardDeviceRow
        if err := sess.SQL("SELECT DISTINCT device_mac FROM home_page_card WHERE device_mac IS NOT NULL AND device_mac <> ''").Find(&rows); err != nil {
            return err
        }

        for _, row := range rows {
            appendDevice(row.DeviceMAC)
        }

        return nil
    })
    if err != nil {
        hs.log.Error("Failed to load home page card devices, using fallback list", "error", err)
    }

    if len(devices) == 0 {
        for _, deviceID := range fallbackDeviceIDs {
            appendDevice(deviceID)
        }
        appendDevice(defaultDeviceID)
    }

    return devices
}

func (hs *HTTPServer) replayVitalsCache(startPlayback time.Time) {
    fixedPeriodDataMutex.RLock()
    if !fixedPeriodLoaded || len(fixedPeriodData) == 0 {
        fixedPeriodDataMutex.RUnlock()
        return
    }
    allData := fixedPeriodData
    fixedPeriodDataMutex.RUnlock()

    elapsed := time.Since(startPlayback)
    offset := elapsed % fixedDuration

    virtualNow := fixedStart.Add(offset)
    windowStart := virtualNow.Add(-5 * time.Second)

    var matched []map[string]string
    for _, row := range allData {
        timeValue, ok := row["_time"]
        if !ok {
            continue
        }

        parsedTime, err := time.Parse(time.RFC3339Nano, timeValue)
        if err != nil {
            parsedTime, err = time.Parse(time.RFC3339, timeValue)
            if err != nil {
                continue
            }
        }

        if (parsedTime.Equal(windowStart) || parsedTime.After(windowStart)) && (parsedTime.Equal(virtualNow) || parsedTime.Before(virtualNow)) {
            matched = append(matched, row)
        }
    }

    if len(matched) == 0 {
        matched = findClosestRecords(allData, virtualNow)
    }

    vitalsCacheMutex.Lock()
    vitalsCache = CachedVitalsData{
        Results:   matched,
        Timestamp: time.Now().UnixMilli(),
    }
    vitalsCacheMutex.Unlock()

    hs.log.Debug("Vitals cache replayed", "virtualTime", virtualNow.Format(time.RFC3339), "matchedRecords", len(matched), "offset", offset.String())
}

func findClosestRecords(allData []map[string]string, virtualNow time.Time) []map[string]string {
    type key struct {
        deviceID string
        field    string
    }

    closest := make(map[key]map[string]string)
    closestDiff := make(map[key]time.Duration)

    for _, row := range allData {
        timeValue, ok := row["_time"]
        if !ok {
            continue
        }

        parsedTime, err := time.Parse(time.RFC3339Nano, timeValue)
        if err != nil {
            parsedTime, err = time.Parse(time.RFC3339, timeValue)
            if err != nil {
                continue
            }
        }

        pair := key{deviceID: row["device_id"], field: row["_field"]}
        diff := virtualNow.Sub(parsedTime)
        if diff < 0 {
            diff = -diff
        }
        if previous, exists := closestDiff[pair]; !exists || diff < previous {
            closestDiff[pair] = diff
            closest[pair] = row
        }
    }

    result := make([]map[string]string, 0, len(closest))
    for _, row := range closest {
        result = append(result, row)
    }
    return result
}

func (hs *HTTPServer) executeInfluxQuery(fluxQuery string) ([]map[string]string, error) {
    queryURL, err := url.Parse(fmt.Sprintf("%s/api/v2/query", influxURL))
    if err != nil {
        return nil, err
    }

    values := queryURL.Query()
    values.Set("org", influxOrg)
    queryURL.RawQuery = values.Encode()

    bodyBytes, err := json.Marshal(map[string]string{"query": fluxQuery})
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
