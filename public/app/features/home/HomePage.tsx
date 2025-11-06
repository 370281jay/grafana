import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getBackendSrv } from 'app/core/services/backend_srv';
import { Box, Button } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';

interface DeviceConfig {
  room: string;
  deviceId: string;
  label?: string;
}

type DeviceMetrics = {
  heartRate: number | null;
  respirationRate: number | null;
  distanceMin: number | null;
  movementAmplitude: number | null;
};

type MetricKey = keyof DeviceMetrics;
type MetricTrend = 'up' | 'down' | 'same';

const createEmptyTrends = (): Record<MetricKey, MetricTrend> => ({
  heartRate: 'same',
  respirationRate: 'same',
  distanceMin: 'same',
  movementAmplitude: 'same',
});

const calculateTrends = (
  previous: DeviceMetrics | undefined,
  current: DeviceMetrics
): Record<MetricKey, MetricTrend> => {
  const trendFor = (key: MetricKey): MetricTrend => {
    const prevValue = previous?.[key] ?? null;
    const currValue = current[key];

    if (
      prevValue === null ||
      Number.isNaN(prevValue) ||
      currValue === null ||
      Number.isNaN(currValue)
    ) {
      return 'same';
    }

    if (currValue > prevValue) {
      return 'up';
    }

    if (currValue < prevValue) {
      return 'down';
    }

    return 'same';
  };

  return {
    heartRate: trendFor('heartRate'),
    respirationRate: trendFor('respirationRate'),
    distanceMin: trendFor('distanceMin'),
    movementAmplitude: trendFor('movementAmplitude'),
  };
};

interface DeviceVitals extends DeviceMetrics {
  deviceId: string;
  room: string;
  occupied: boolean;
  fallRisk: boolean;
  trends: Record<MetricKey, MetricTrend>;
}

type DashboardSummary = {
  uid: string;
  title: string;
  url: string;
};
//房间添加
const MONITORED_DEVICES: DeviceConfig[] = [
  { room: '1', deviceId: '10B41DC081B0' },
  { room: '2', deviceId: '84F7035346E0'},
  { room: '3', deviceId: '10B41DC081B2'},
  { room: '4', deviceId: '84F7035346E2'},
  // 在此添加更多设备配置
];

const INFLUXDB_CONFIG = {
  url: 'http://influx.lanhc.com',
  token: 'XXYxzLQLaaQ5UK6BsNky_sczBubMaL6oZhpifvWUyTbj7sKvkKhruuplOWXmNXHyrz-hExSEo9kcu0pN7yJVag==',
  org: 'ld6002h',
  bucket: 'vitals_data',
};

const buildDeviceFilter = (devices: DeviceConfig[]): string => {
  if (!devices.length) {
    return 'true';
  }
  return devices.map((device) => `r["device_id"] == "${device.deviceId}"`).join(' or ');
};

const formatMetric = (value: number | null, fractionDigits = 0): string => {
  if (value === null || Number.isNaN(value)) {
    return '-';
  }
  return value.toFixed(fractionDigits);
};

// 仿照 Python 脚本中的 Flux 查询语句
const buildFluxQuery = (bucket: string, devices: DeviceConfig[]): string => {
  const deviceFilter = buildDeviceFilter(devices);
  return `from(bucket: "${bucket}")
  |> range(start: -1m)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm")
  |> filter(fn: (r) => ${deviceFilter})`;
  // 删除了 |> last()，获取全部数据点
};

type DeviceMetricsWithRisk = DeviceMetrics & {
  fallRiskDetected: boolean;
};

const extractDeviceMetrics = (response: any): Map<string, DeviceMetricsWithRisk> => {
  const grouped = new Map<string, DeviceMetricsWithRisk>();
  const records = Array.isArray(response?.results) ? response.results : [];

  records.forEach((row: any) => {
    const deviceId = String(row?.device_id ?? '').trim();
    const field = String(row?._field ?? '').trim();
    const rawValue = row?._value;

    if (!deviceId || !field || rawValue === undefined || rawValue === null) {
      return;
    }

    const numericValue = parseFloat(String(rawValue));
    if (Number.isNaN(numericValue)) {
      return;
    }

    const metrics = grouped.get(deviceId) ?? {
      ...createEmptyMetrics(),
      fallRiskDetected: false,
    };

    // ✅ 检查体动值是否 > 900
    if (field === 'movement_amplitude' && numericValue > 900) {
      metrics.fallRiskDetected = true;
    }

    switch (field) {
      case 'heart_rate_bpm':
        metrics.heartRate = numericValue;
        break;
      case 'respiration_bpm':
        metrics.respirationRate = numericValue;
        break;
      case 'distance_min_cm':
        metrics.distanceMin = numericValue;
        break;
      case 'movement_amplitude':
        metrics.movementAmplitude = numericValue;
        break;
      default:
        break;
    }

    grouped.set(deviceId, metrics);
  });

  return grouped;
};

const createEmptyMetrics = (): DeviceMetrics => ({
  heartRate: null,
  respirationRate: null,
  distanceMin: null,
  movementAmplitude: null,
});

const buildEmptyDeviceVitals = (config: DeviceConfig): DeviceVitals => ({
  deviceId: config.deviceId,
  room: config.room,
  ...createEmptyMetrics(),
  occupied: false,
  fallRisk: false,
  trends: createEmptyTrends(),
});

export function HomePage() {
  const [deviceVitals, setDeviceVitals] = useState<DeviceVitals[]>(
    MONITORED_DEVICES.map((config) => buildEmptyDeviceVitals(config))
  );
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [isContactModalOpen, setContactModalOpen] = useState(false);
  const [isHelpModalOpen, setHelpModalOpen] = useState(false);

  const previousMetricsRef = useRef<Map<string, DeviceMetrics>>(new Map());

  const showPlaceholder = !hasLoadedOnce && loading;

  const dashboardUrlByDevice = useMemo(() => {
    const map = new Map<string, string>();
    MONITORED_DEVICES.forEach((config, index) => {
      const summary = dashboards[index];
      if (summary?.url) {
        map.set(config.deviceId, summary.url);
      }
    });
    return map;
  }, [dashboards]);

  const sortedDeviceVitals = useMemo(() => {
    return [...deviceVitals].sort((a, b) => Number(b.fallRisk) - Number(a.fallRisk));
  }, [deviceVitals]);

  const fetchDashboards = async () => {
    try {
      const searchResult = await getBackendSrv().get('/api/search', {
        type: 'dash-db',
        query: '*',
        limit: MONITORED_DEVICES.length,
      });

      const items = Array.isArray(searchResult)
        ? searchResult
            .filter((item: any) => item?.type === 'dash-db' && typeof item?.url === 'string')
            .map((item: any) => ({
              id: item.id,
              uid: String(item.uid ?? ''),
              title: String(item.title ?? ''),
              url: String(item.url ?? ''),
            }))
            .sort((a: any, b: any) => a.id - b.id)
        : [];

      setDashboards(items);
    } catch (err) {
      console.error('获取仪表板列表失败:', err);
    }
  };

  const fetchVitals = useCallback(
    async (options?: { showIndicator?: boolean }) => {
      const shouldShowIndicator = options?.showIndicator ?? !hasLoadedOnce;
      if (shouldShowIndicator) {
        setLoading(true);
      }
      setError(null);

      try {
        console.info('开始执行 HomePage.fetchVitals()');

        const fluxQuery = buildFluxQuery(INFLUXDB_CONFIG.bucket, MONITORED_DEVICES);
        console.info('Flux 查询语句:', fluxQuery);

        const response = await getBackendSrv().post('/api/influxdb/query', {
          query: fluxQuery,
        });

        console.info('InfluxDB 响应:', response);

        const groupedMetrics = extractDeviceMetrics(response);
        const previousMetrics = previousMetricsRef.current;
        const nextMetricsMap = new Map<string, DeviceMetrics>();

        const updatedVitals = MONITORED_DEVICES.map((config) => {
          const metricsWithRisk = groupedMetrics.get(config.deviceId) ?? {
            ...createEmptyMetrics(),
            fallRiskDetected: false,
          };
          
          // 分离风险标志
          const { fallRiskDetected, ...metrics } = metricsWithRisk;
          
          nextMetricsMap.set(config.deviceId, metrics);
          const trends = calculateTrends(previousMetrics.get(config.deviceId), metrics);
          
          // ✅ 使用查询中检测到的风险标志
          const fallRisk = fallRiskDetected;
          
          const occupied =
            metrics.heartRate !== null && !Number.isNaN(metrics.heartRate);

          return {
            deviceId: config.deviceId,
            room: config.room,
            heartRate: metrics.heartRate,
            respirationRate: metrics.respirationRate,
            distanceMin: metrics.distanceMin,
            movementAmplitude: metrics.movementAmplitude,
            occupied,
            fallRisk,
            trends,
          };
        });

        previousMetricsRef.current = nextMetricsMap;

        setDeviceVitals(updatedVitals);
        setLastUpdated(new Date().toLocaleTimeString());
        setHasLoadedOnce(true);
      } catch (err) {
        console.error('获取健康数据失败:', err);
        setError(`获取数据失败: ${err instanceof Error ? err.message : '未知错误'}`);
      } finally {
        if (shouldShowIndicator) {
          setLoading(false);
        }
      }
    },
    [hasLoadedOnce]
  );

  useEffect(() => {
    fetchDashboards();
  }, []);

  useEffect(() => {
    fetchVitals({ showIndicator: true });
    const interval = setInterval(() => {
      fetchVitals();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchVitals]);

  const handleManualRefresh = () => {
    fetchVitals({ showIndicator: true });
  };

  const renderMetric = (
    label: string,
    value: number | null,
    unit: string,
    trend: MetricTrend,
    fractionDigits = 0
  ) => {
    const hasValue = value !== null && !Number.isNaN(value);
    const arrow = !hasValue || showPlaceholder ? '—' : trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—';
    const arrowColor = arrow === '▲' ? '#28a745' : arrow === '▼' ? '#dc3545' : 'rgba(0, 0, 0, 0.35)';

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: '8px 12px',
          backgroundColor: 'rgba(0, 0, 0, 0.02)',
          borderRadius: '4px',
        }}
      >
        <span style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.8)', marginBottom: '6px', fontWeight: 600 }}>
          {label}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '32px',
            fontWeight: 800,
            marginBottom: '4px',
          }}
        >
          {(() => {
            if (!hasLoadedOnce && loading && !hasValue) {
              return '-';
            }
            return hasValue ? formatMetric(value, fractionDigits) : '-';
          })()}
          <span style={{ fontSize: '18px', color: arrowColor }}>{arrow}</span>
        </span>
        <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>{unit}</span>
      </div>
    );
  };

  return (
    <Page navId="home">
      <Box display="flex" direction="column" alignItems="center" justifyContent="center" paddingY={2}>
        <div
          style={{
            width: '100%',
            maxWidth: '1200px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '4px',
            marginBottom: '8px',
          }}
        >
          <Button
            variant="secondary"
            onClick={() => window.open('https://chat.lanhc.com/?model=huian-huli', '_blank', 'noopener')}
          >
            智能体平台
          </Button>
          <Button variant="secondary" onClick={() => setHelpModalOpen(true)}>
            帮助
          </Button>
          <Button variant="primary" onClick={() => setContactModalOpen(true)}>
            联系我们
          </Button>
        </div>
        <h1 style={{ fontSize: '48px', marginBottom: '16px', textAlign: 'center' }}>
          欢迎来到惠康数据可视化平台
        </h1>
       

        {/* 错误提示 */}
        {error && (
          <div
            style={{
              width: '100%',
              maxWidth: '1200px',
              padding: '16px',
              marginBottom: '24px',
              backgroundColor: '#fee',
              borderRadius: '4px',
              border: '1px solid #fcc',
              color: '#c33',
              fontSize: '14px',
            }}
          >
            {error}
          </div>
        )}

        {/* 刷新状态信息 */}
        <div
          style={{
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '24px',
            fontSize: '12px',
            color: 'rgba(0, 0, 0, 0.5)',
            textAlign: 'center',
          }}
        >
          {loading ? (
            <span>正在加载数据...</span>
          ) : (
            <>
              <span>最后更新: {lastUpdated}</span>
              <button
                onClick={handleManualRefresh}
                style={{
                  marginLeft: '16px',
                  padding: '4px 12px',
                  backgroundColor: '#0066cc',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
              >
                手动刷新
              </button>
            </>
          )}
        </div>

        {/* 健康数据面板 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: '12px',
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '24px',
          }}
        >
          {sortedDeviceVitals.map((device) => {
             const dashboardLink = dashboardUrlByDevice.get(device.deviceId) ?? null;
             
            
            // 根据摔倒风险、有人状态、无人状态决定背景色
            let cardBackgroundColor = 'rgba(0, 0, 0, 0.02)'; // 默认：无人
            let cardBorderColor = 'rgba(0, 0, 0, 0.08)';
            
            if (device.fallRisk) {
              // 摔倒风险优先级最高
              cardBackgroundColor = 'rgba(220, 53, 69, 0.12)';
              cardBorderColor = 'rgba(220, 53, 69, 0.4)';
            } else if ( device.heartRate) {
              // 有人状态：绿色
              cardBackgroundColor = 'rgba(40, 167, 69, 0.15)';
              cardBorderColor = 'rgba(40, 167, 69, 0.5)';
            }
            // 无人状态保持默认色（已初始化）

            return (
              <div
                key={device.deviceId}
                onClick={() => {
                  if (dashboardLink) {
                    window.location.assign(dashboardLink);
                  }
                }}
                style={{
                  padding: '12px',
                  backgroundColor: cardBackgroundColor,
                  borderRadius: '6px',
                  border: `1px solid ${cardBorderColor}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  cursor: dashboardLink ? 'pointer' : 'default',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 600 }}>
                    房间 {device.room}
                  </span>
                  <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>
                    设备 ID: {device.deviceId}
                  </span>
                  {dashboardLink && (
                    <span style={{ fontSize: '12px', color: '#0066cc' }}>
                      点击进入仪表板
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 12px',
                      backgroundColor: 'rgba(0, 0, 0, 0.02)',
                      borderRadius: '4px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <span style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.8)', fontWeight: 600 }}>
                      有人状态
                    </span>
                    <span style={{ fontSize: '18px', fontWeight: 600 }}>
                      {showPlaceholder ? '-' : device.heartRate ? '有人' : '无人'}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: '8px 12px',
                      backgroundColor: device.fallRisk
                        ? 'rgba(220, 53, 69, 0.15)'
                        : 'rgba(0, 0, 0, 0.02)',
                      borderRadius: '4px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <span style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.8)', fontWeight: 600 }}>
                      摔倒风险
                    </span>
                    <span
                      style={{
                        fontSize: '18px',
                        fontWeight: 600,
                        color: device.fallRisk ? '#d63342' : 'inherit',
                      }}
                    >
                      {showPlaceholder ? '-' : device.fallRisk ? '有风险' : '无风险'}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: '8px',
                  }}
                >
                  {renderMetric('心率', device.heartRate, 'bpm', device.trends.heartRate)}
                  {renderMetric('呼吸率', device.respirationRate, 'rpm', device.trends.respirationRate)}
                  {renderMetric('距离', device.distanceMin, 'cm', device.trends.distanceMin, 1)}
                  {renderMetric('体动值', device.movementAmplitude, '', device.trends.movementAmplitude, 1)}
                </div>
              </div>
            );
          })}
        </div>
      </Box>
      {isHelpModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1300,
          }}
          onClick={() => setHelpModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: '#fff',
              padding: '24px',
              borderRadius: '8px',
              width: '90%',
              maxWidth: '520px',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 12px 24px rgba(0, 0, 0, 0.2)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 style={{ marginBottom: '12px' }}>界面使用教程</h2>
            <ol style={{ fontSize: '14px', lineHeight: 1.6, paddingLeft: '18px', marginBottom: '16px' }}>
              <li>顶部按钮支持快速跳转平台、查看帮助与联系我们信息。</li>
              <li>房间卡片展示实时健康数据，可点击进入对应仪表板。</li>
              <li>使用“手动刷新”按钮获取最新数据，或等待系统自动更新。</li>
            </ol>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setHelpModalOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
      {isContactModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1300,
          }}
          onClick={() => setContactModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: '#fff',
              padding: '24px',
              borderRadius: '8px',
              width: '90%',
              maxWidth: '600px',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 12px 24px rgba(0, 0, 0, 0.2)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 style={{ marginBottom: '12px' }}>联系我们</h2>
            <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
              如果您对我们的 “人工智能 + 边缘计算” 相关产品与服务感兴趣，或有合作意向，欢迎通过以下方式与我们联系：
            </p>
            <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>团队背景</h3>
            <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
              我们是华侨大学华大智语 &amp; 清大华宇联合团队。华大智语由华侨大学王华珍副教授领衔，近 60 名师生组成，学术研发实力强劲；清大华宇是清华海峡研究院团队，拥有十多年产业化经验，提供算力和产品支撑。双方协同构建产学研协同基底，形成全链条技术闭环、学术与产业双轮驱动、“0→1 研发到 1→N 落地” 的核心优势，在华文教育机器人出海、智算中心服务等领域成果斐然。
            </p>
            <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>联系方式</h3>
            <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
              版权所有：华侨大学华大智语 | 清大华宇（厦门）数字科技有限公司<br />
              地址：福建省厦门市集美区集美大道 668 号<br />
              联系：wanghuazhen@hqu.edu.cn；lucky@lanhc.com<br />
              友情链接：华侨大学、清华海峡研究院
            </p>
            <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '16px' }}>
              期待与您携手，共探人工智能与边缘计算的创新应用！
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setContactModalOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
