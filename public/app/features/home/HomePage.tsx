import { useState, useEffect } from 'react';
import { getBackendSrv } from 'app/core/services/backend_srv';

import { Box } from '@grafana/ui';

import { Page } from 'app/core/components/Page/Page';

interface VitalsData {
  heartRate: number | null;
  respirationRate: number | null;
  distanceMin: number | null;
  movementAmplitude: number | null;
}

// InfluxDB 硬编码配置
const INFLUXDB_CONFIG = {
  url: 'http://influx.lanhc.com',
  token: 'XXYxzLQLaaQ5UK6BsNky_sczBubMaL6oZhpifvWUyTbj7sKvkKhruuplOWXmNXHyrz-hExSEo9kcu0pN7yJVag==',
  org: 'ld6002h',
  bucket: 'vitals_data',
  deviceId: '84F7035346E0',
};

// 仿照 Python 脚本中的 Flux 查询语句
const buildFluxQuery = (bucket: string, deviceId: string): string => {
  return `from(bucket: "${bucket}")
  |> range(start: -5m)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm")
  |> last()`;
};

// 仿照 Python 的 _query_single_value 逻辑
const querySingleValue = (response: any): Map<string, number | null> => {
  const result = new Map<string, number | null>();
  result.set('heartRate', null);
  result.set('respirationRate', null);
  result.set('distanceMin', null);
  result.set('movementAmplitude', null);

  try {
    if (response.results) {
      response.results.forEach((result: any) => {
        result.series?.forEach((series: any) => {
          const field = series.tags?._field;
          const value = series.values?.[0]?.[1];

          if (field === 'heart_rate_bpm' && value !== null && value !== undefined) {
            result.set('heartRate', parseFloat(value));
          } else if (field === 'respiration_bpm' && value !== null && value !== undefined) {
            result.set('respirationRate', parseFloat(value));
          } else if (field === 'distance_min_cm' && value !== null && value !== undefined) {
            result.set('distanceMin', parseFloat(value));
          } else if (field === 'movement_amplitude' && value !== null && value !== undefined) {
            result.set('movementAmplitude', parseFloat(value));
          }
        });
      });
    }
  } catch (error) {
    console.error('查询单值失败:', error);
  }

  return result;
};

export function HomePage() {
  const [vitals, setVitals] = useState<VitalsData>({
    heartRate: null,
    respirationRate: null,
    distanceMin: null,
    movementAmplitude: null,
  });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // 直接调用 InfluxDB API
  const fetchVitals = async () => {
    setLoading(true);
    setError(null);

    try {
      console.info('开始执行 HomePage.fetchVitals()');

      const fluxQuery = buildFluxQuery(INFLUXDB_CONFIG.bucket, INFLUXDB_CONFIG.deviceId);
      console.info('Flux 查询语句:', fluxQuery);

      // 调用后端代理接口
      const response = await getBackendSrv().post('/api/influxdb/query', {
        query: fluxQuery,
      });

      console.info('InfluxDB 响应:', response);

      // 仿照 Python 的数据解析逻辑
      const queryResult = querySingleValue(response);
      const vitalsData: VitalsData = {
        heartRate: queryResult.get('heartRate') ?? null,
        respirationRate: queryResult.get('respirationRate') ?? null,
        distanceMin: queryResult.get('distanceMin') ?? null,
        movementAmplitude: queryResult.get('movementAmplitude') ?? null,
      };

      console.info('查询结果:', vitalsData);

      setVitals(vitalsData);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      console.error('获取健康数据失败:', error);
      setError(`获取数据失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  // 页面挂载时自动查询，之后每 30 秒刷新一次
  useEffect(() => {
    fetchVitals();
    const interval = setInterval(fetchVitals, 30000);

    return () => clearInterval(interval);
  }, []);

  // 手动刷新按钮处理
  const handleManualRefresh = () => {
    fetchVitals();
  };

  return (
    <Page navId="home">
      <Box display="flex" direction="column" alignItems="center" justifyContent="center" paddingY={4}>
        <h1 style={{ fontSize: '48px', marginBottom: '16px', textAlign: 'center' }}>
          欢迎来到惠康数据可视化平台
        </h1>
        <p style={{ fontSize: '18px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '48px', textAlign: 'center' }}>
          强大的数据可视化和监控解决方案
        </p>

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
            gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
            gap: '16px',
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '32px',
          }}
        >
          <div
            style={{
              padding: '16px',
              backgroundColor: 'rgba(0, 0, 0, 0.02)',
              borderRadius: '4px',
              border: '1px solid rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '8px' }}>
              心率
            </div>
            <div style={{ fontSize: '32px', fontWeight: 'bold', marginBottom: '4px' }}>
              {loading ? '-' : vitals.heartRate?.toFixed(1) ?? '-'}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>
              bpm
            </div>
          </div>

          <div
            style={{
              padding: '16px',
              backgroundColor: 'rgba(0, 0, 0, 0.02)',
              borderRadius: '4px',
              border: '1px solid rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '8px' }}>
              呼吸率
            </div>
            <div style={{ fontSize: '32px', fontWeight: 'bold', marginBottom: '4px' }}>
              {loading ? '-' : vitals.respirationRate?.toFixed(1) ?? '-'}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>
              rpm
            </div>
          </div>

          <div
            style={{
              padding: '16px',
              backgroundColor: 'rgba(0, 0, 0, 0.02)',
              borderRadius: '4px',
              border: '1px solid rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '8px' }}>
              最小距离
            </div>
            <div style={{ fontSize: '32px', fontWeight: 'bold', marginBottom: '4px' }}>
              {loading ? '-' : vitals.distanceMin?.toFixed(1) ?? '-'}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>
              cm
            </div>
          </div>

          <div
            style={{
              padding: '16px',
              backgroundColor: 'rgba(0, 0, 0, 0.02)',
              borderRadius: '4px',
              border: '1px solid rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '8px' }}>
              运动幅度
            </div>
            <div style={{ fontSize: '32px', fontWeight: 'bold', marginBottom: '4px' }}>
              {loading ? '-' : vitals.movementAmplitude?.toFixed(1) ?? '-'}
            </div>
            <div style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>
              mm
            </div>
          </div>
        </div>
      </Box>
    </Page>
  );
}
