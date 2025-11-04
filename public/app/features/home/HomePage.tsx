import { useState, useEffect } from 'react';
import { getBackendSrv } from 'app/core/services/backend_srv';

import { Box } from '@grafana/ui';

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

interface DeviceVitals extends DeviceMetrics {
  deviceId: string;
  room: string;
  occupied: boolean;
  fallRisk: boolean;
}

const MONITORED_DEVICES: DeviceConfig[] = [
  { room: '1', deviceId: '84F7035346E0' },
  { room: '2', deviceId: '10B41DC081B0'}
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
  |> range(start: -5m)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm")
  |> filter(fn: (r) => ${deviceFilter})
  |> last()`;
};

const extractDeviceMetrics = (response: any): Map<string, DeviceMetrics> => {
  const grouped = new Map<string, DeviceMetrics>();
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

    const metrics = grouped.get(deviceId) ?? createEmptyMetrics();

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
});

export function HomePage() {
  const [deviceVitals, setDeviceVitals] = useState<DeviceVitals[]>(
    MONITORED_DEVICES.map((config) => buildEmptyDeviceVitals(config))
  );
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const fetchVitals = async () => {
    setLoading(true);
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

      const updatedVitals = MONITORED_DEVICES.map((config) => {
        const metrics = groupedMetrics.get(config.deviceId) ?? createEmptyMetrics();
        const occupied = Object.values(metrics).some((value) => value !== null);
        const fallRisk = metrics.movementAmplitude !== null && metrics.movementAmplitude > 900;

        return {
          deviceId: config.deviceId,
          room: config.room,
          heartRate: metrics.heartRate,
          respirationRate: metrics.respirationRate,
          distanceMin: metrics.distanceMin,
          movementAmplitude: metrics.movementAmplitude,
          occupied,
          fallRisk,
        };
      });

      setDeviceVitals(updatedVitals);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('获取健康数据失败:', err);
      setError(`获取数据失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVitals();
    const interval = setInterval(fetchVitals, 150000);
    return () => clearInterval(interval);
  }, []);

  const handleManualRefresh = () => {
    fetchVitals();
  };

  const renderMetric = (
    label: string,
    value: number | null,
    unit: string,
    fractionDigits = 0
  ) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '8px 12px',
        backgroundColor: 'rgba(0, 0, 0, 0.02)',
        borderRadius: '4px',
      }}
    >
      <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '4px' }}>
        {label}
      </span>
      <span style={{ fontSize: '24px', fontWeight: 600, marginBottom: '4px' }}>
        {loading ? '-' : formatMetric(value, fractionDigits)}
      </span>
      <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>{unit}</span>
    </div>
  );

  return (
    <Page navId="home">
      <Box display="flex" direction="column" alignItems="center" justifyContent="center" paddingY={4}>
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
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '12px',
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '24px',
          }}
        >
          {deviceVitals.map((device) => {
            const fallRiskHighlight = device.fallRisk
              ? 'rgba(220, 53, 69, 0.1)'
              : 'rgba(0, 0, 0, 0.02)';

            return (
              <div
                key={device.deviceId}
                style={{
                  padding: '12px',
                  backgroundColor: fallRiskHighlight,
                  borderRadius: '6px',
                  border: `1px solid ${
                    device.fallRisk ? 'rgba(220, 53, 69, 0.4)' : 'rgba(0, 0, 0, 0.08)'
                  }`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 600 }}>
                    房间 {device.room}
                  </span>
                  <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>
                    设备 ID: {device.deviceId}
                  </span>
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
                    <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.6)' }}>
                      有人状态
                    </span>
                    <span style={{ fontSize: '16px', fontWeight: 600 }}>
                      {loading ? '-' : device.occupied ? '有人' : '无人'}
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
                    <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.6)' }}>
                      摔倒风险
                    </span>
                    <span
                      style={{
                        fontSize: '16px',
                        fontWeight: 600,
                        color: device.fallRisk ? '#d63342' : 'inherit',
                      }}
                    >
                      {loading ? '-' : device.fallRisk ? '有风险' : '无风险'}
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
                  {renderMetric('心率', device.heartRate, 'bpm')}
                  {renderMetric('呼吸率', device.respirationRate, 'rpm')}
                  {renderMetric('最小距离', device.distanceMin, 'cm', 1)}
                  {renderMetric('体动值', device.movementAmplitude, '', 1)}
                </div>
              </div>
            );
          })}
        </div>
      </Box>
    </Page>
  );
}
