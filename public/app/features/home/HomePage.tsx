/* eslint-disable @grafana/i18n/no-untranslated-strings */
import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from 'react';

import { Box, Button } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import { getBackendSrv } from 'app/core/services/backend_srv';


interface InfluxRow {
  device_id?: string;
  _field?: string;
  _value?: number | string | null;
}

interface InfluxQueryResponse {
  results?: InfluxRow[];
}

interface SearchResultItem {
  id: number;
  uid?: string;
  title?: string;
  url?: string;
  type?: string;
}

interface DeviceConfig {
  id?: number;
  room: string;
  deviceId: number | null;
  deviceMac: string;
  deviceType?: string;
  dashboardUid?: string;
  dashboardUrl?: string;
  label?: string;
}

type DeviceMetrics = {
  heartRate: number | null;
  respirationRate: number | null;
  distanceMin: number | null;
  movementAmplitude: number | null;
};

// 每个指标的"最后有效值"及其时间戳，用于空白帧保持显示
type MetricLastKnown = {
  value: number;
  timestamp: number; // ms
};

type DeviceLastKnownMetrics = {
  heartRate: MetricLastKnown | null;
  respirationRate: MetricLastKnown | null;
  distanceMin: MetricLastKnown | null;
  movementAmplitude: MetricLastKnown | null;
};

// 超过该时长未收到有效数据，才真正将显示值置空（毫秒）
const METRIC_STALE_THRESHOLD_MS = 10000;

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
  deviceId: number | null;
  deviceMac: string;
  room: string;
  deviceType: string;
  occupied: boolean;
  fallRisk: boolean;
  trends: Record<MetricKey, MetricTrend>;
  // 标记哪些字段当前是"保持显示"的旧值（空白帧时不清零）
  staleFields: Partial<Record<MetricKey, boolean>>;
  fallDetected: boolean;
  fallTimerSeconds: number | null;
  humanPresence: boolean | null;
}

type DashboardSummary = {
  id: number;
  uid: string;
  title: string;
  url: string;
};

type DeviceEntity = {
  id: number;
  name: string;
  deviceMac: string;
  deviceType?: string;
  description?: string;
};

type DeviceFormValues = {
  name: string;
  deviceMac: string;
  deviceType: string;
  description: string;
};

type DeviceConfigWithId = DeviceConfig & { id: number };

type HomePageCardDTO = {
  id: number;
  deviceId?: number;
  deviceMac: string;
  deviceType?: string;
  cardName: string;
  dashboardUid?: string;
  dashboardUrl?: string;
};

const DEFAULT_DEVICE_TYPE = 'heart-rate';

const DEVICE_TYPE_OPTIONS = [
  { value: 'heart-rate', label: '心率检测' },
  { value: 'fall-detection', label: '跌倒检测' },
];

const DEVICE_TYPE_LABELS: Record<string, string> = {
  'heart-rate': '心率检测',
  'fall-detection': '跌倒检测',
};

type DeviceFilterValue = 'all' | 'heart-rate' | 'fall-detection';

const formatRoomLabel = (room: string) => (room.startsWith('房间') ? room : `房间${room}`);

const normalizeDeviceMac = (value: string) => value.trim().replaceAll(':', '').replaceAll('-', '').toUpperCase();
const dropdownStyle: CSSProperties = {
  width: '100%',
  minHeight: '36px',
  padding: '8px 10px',
  borderRadius: '4px',
  border: '1px solid rgba(0, 0, 0, 0.2)',
  backgroundColor: '#fff',
  color: 'rgba(0, 0, 0, 0.85)',
  fontSize: '13px',
  lineHeight: '1.35',
  appearance: 'none',
};
//房间添加
const MONITORED_DEVICES: DeviceConfig[] = [
  // { room: '1', deviceId: 'D0CF1316DEC4' },
  { room: '1', deviceId: null, deviceMac: 'B8F862F6BFD8', deviceType: DEFAULT_DEVICE_TYPE, dashboardUid: '', dashboardUrl: '' },
  { room: '2', deviceId: null, deviceMac: '84F7035346E0', deviceType: DEFAULT_DEVICE_TYPE, dashboardUid: '', dashboardUrl: '' },
  { room: '3', deviceId: null, deviceMac: '10B41DC081B2', deviceType: DEFAULT_DEVICE_TYPE, dashboardUid: '', dashboardUrl: '' },
  { room: '4', deviceId: null, deviceMac: '84F7035346E2', deviceType: DEFAULT_DEVICE_TYPE, dashboardUid: '', dashboardUrl: '' },
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
  return devices
    .filter((device) => device.deviceMac)
    .map((device) => `r["device_id"] == "${device.deviceMac}"`)
    .join(' or ') || 'true';
};

const formatMetric = (value: number | null, fractionDigits = 0): string => {
  if (value === null || Number.isNaN(value)) {
    return '-';
  }
  return value.toFixed(fractionDigits);
};

const formatFallTimer = (value: number | null): string => {
  if (value === null || Number.isNaN(value)) {
    return '-';
  }
  const seconds = Math.max(0, Math.floor(value));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

// 仿照 Python 脚本中的 Flux 查询语句
const buildFluxQuery = (bucket: string, devices: DeviceConfig[]): string => {
  const deviceFilter = buildDeviceFilter(devices);
  return `from(bucket: "${bucket}")
  |> range(start: -3s)
  |> filter(fn: (r) => r["_measurement"] == "device_data")
  |> filter(fn: (r) => r["_field"] == "distance_min_cm" or r["_field"] == "heart_rate_bpm" or r["_field"] == "movement_amplitude" or r["_field"] == "respiration_bpm" or r["_field"] == "fall" or r["_field"] == "fall_count" or r["_field"] == "human")
  |> filter(fn: (r) => ${deviceFilter})`;
};

type DeviceMetricsWithRisk = DeviceMetrics & {
  fallRiskDetected: boolean;
  fallFlag?: number | null;
  fallCount?: number | null;
  humanPresence?: number | null;
};

const extractDeviceMetrics = (response: InfluxQueryResponse): Map<string, DeviceMetricsWithRisk> => {
  const grouped = new Map<string, DeviceMetricsWithRisk>();
  const records: InfluxRow[] = Array.isArray(response?.results) ? response.results : [];

  records.forEach((row: InfluxRow) => {
    const deviceIdRaw = row?.device_id;
    const fieldRaw = row?._field;
    const rawValue = row?._value;

    const deviceId = typeof deviceIdRaw === 'string' ? deviceIdRaw.trim() : '';
    const field = typeof fieldRaw === 'string' ? fieldRaw.trim() : '';

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
      fallFlag: null,
      fallCount: null,
      humanPresence: null,
    };

    // ✅ 检查体动值是否 > 900
    if (field === 'movement_amplitude' && numericValue > 800) {
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
      case 'fall':
        metrics.fallFlag = numericValue;
        if (numericValue >= 0.5) {
          metrics.fallRiskDetected = true;
        }
        break;
      case 'fall_count':
        metrics.fallCount = numericValue;
        break;
      case 'human':
        metrics.humanPresence = numericValue;
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
  deviceId: config.deviceId ?? null,
  deviceMac: config.deviceMac ?? '',
  room: config.room,
  deviceType: config.deviceType ?? DEFAULT_DEVICE_TYPE,
  ...createEmptyMetrics(),
  occupied: false,
  fallRisk: false,
  trends: createEmptyTrends(),
  staleFields: {},
  fallDetected: false,
  fallTimerSeconds: null,
  humanPresence: null,
});

export function HomePage() {
  const [deviceConfigs, setDeviceConfigs] = useState<DeviceConfig[]>(MONITORED_DEVICES);
  const [deviceVitals, setDeviceVitals] = useState<DeviceVitals[]>(
    MONITORED_DEVICES.map((config: DeviceConfig) => buildEmptyDeviceVitals(config))
  );
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [isSettingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<DeviceConfig[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [deviceEntities, setDeviceEntities] = useState<DeviceEntity[]>([]);
  const [isDeviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const [deviceFormValues, setDeviceFormValues] = useState<DeviceFormValues>({
    name: '',
    deviceMac: '',
    deviceType: DEFAULT_DEVICE_TYPE,
    description: '',
  });
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [deviceModalError, setDeviceModalError] = useState<string | null>(null);
  const [isSavingDevice, setIsSavingDevice] = useState(false);
  const [isContactModalOpen, setContactModalOpen] = useState(false);
  const [isHelpModalOpen, setHelpModalOpen] = useState(false);
  const [isAlarmModalOpen, setAlarmModalOpen] = useState(false);
  const [alarmDevices, setAlarmDevices] = useState<string[]>([]);
  const [lastAlarmTime, setLastAlarmTime] = useState<number>(0);
  const ACK_COOLDOWN_MS = 60000; // 1 分钟
  const [acknowledgedRiskRooms, setAcknowledgedRiskRooms] = useState<Map<string, number>>(new Map()); // ✅ 添加
  const [activeDeviceFilter, setActiveDeviceFilter] = useState<DeviceFilterValue>('all');
  const alarmingRoomsRef = useRef<Set<string>>(new Set());

  const previousMetricsRef = useRef<Map<string, DeviceMetrics>>(new Map());
  // 记录每个设备各指标的最后有效值和时间戳，用于空白帧时保持显示
  const lastKnownMetricsRef = useRef<Map<string, DeviceLastKnownMetrics>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmPlayCountRef = useRef(0);
  const alarmTimeoutRef = useRef<number | null>(null); // ✅ 添加

  const showPlaceholder = !hasLoadedOnce && loading;
  const deviceFilterOptions: Array<{ value: DeviceFilterValue; label: string }> = useMemo(
    () => [
      { value: 'all', label: '全部设备' },
      { value: 'heart-rate', label: '心率检测' },
      { value: 'fall-detection', label: '跌倒检测' },
    ],
    []
  );

  const dashboardByUid = useMemo(() => {
    return new Map(dashboards.map((dashboard: DashboardSummary) => [dashboard.uid, dashboard]));
  }, [dashboards]);

  const dashboardUrlByDevice = useMemo(() => {
    const map = new Map<string, string>();
    deviceConfigs.forEach((config: DeviceConfig) => {
      const summary = config.dashboardUid ? dashboardByUid.get(config.dashboardUid) : undefined;
      const dashboardUrl = summary?.url ?? config.dashboardUrl;

      if (dashboardUrl && config.deviceMac) {
        map.set(config.deviceMac, dashboardUrl);
      }
    });
    return map;
  }, [dashboardByUid, deviceConfigs]);

  const sortedDeviceVitals = useMemo(() => {
    return [...deviceVitals].sort((a, b) => Number(b.fallRisk) - Number(a.fallRisk));
  }, [deviceVitals]);

  const filteredDeviceVitals = useMemo(() => {
    if (activeDeviceFilter === 'all') {
      return sortedDeviceVitals;
    }
    return sortedDeviceVitals.filter((item: DeviceVitals) => item.deviceType === activeDeviceFilter);
  }, [activeDeviceFilter, sortedDeviceVitals]);

  const fetchDashboards = async () => {
    try {
      const searchResult = await getBackendSrv().get<SearchResultItem[]>('/api/search', {
        type: 'dash-db',
        query: '*',
        limit: 100,
      });

      const rawItems: SearchResultItem[] = Array.isArray(searchResult) ? searchResult : [];
      const items = rawItems
        .filter((item: SearchResultItem) => item?.type === 'dash-db' && typeof item?.url === 'string')
        .map((item) => ({
          id: Number(item.id ?? 0),
          uid: String(item.uid ?? ''),
          title: String(item.title ?? ''),
          url: String(item.url ?? ''),
        }))
        .sort((a, b) => a.id - b.id);

      setDashboards(items);
    } catch (err) {
      console.error('获取仪表板列表失败:', err);
    }
  };

  const fetchDevices = useCallback(async () => {
    try {
      const result = await getBackendSrv().get<DeviceEntity[]>('/api/devices');
      const items = Array.isArray(result)
        ? result.map((item) => ({
            id: item.id,
            name: String(item.name ?? '').trim(),
            deviceMac: normalizeDeviceMac(String(item.deviceMac ?? '')),
            deviceType: item.deviceType ? String(item.deviceType).trim() : DEFAULT_DEVICE_TYPE,
            description: String(item.description ?? '').trim(),
          }))
        : [];

      setDeviceEntities(items);
      setSettingsDraft((prev: DeviceConfig[]) =>
        prev.map((config) => {
          if (config.deviceId == null) {
            return config;
          }
          const match = items.find((device) => device.id === config.deviceId);
          if (!match) {
            return config;
          }
          return {
            ...config,
            deviceMac: match.deviceMac,
            deviceType: config.deviceType ?? match.deviceType ?? DEFAULT_DEVICE_TYPE,
          };
        })
      );
    } catch (err) {
      console.error('Failed to fetch devices:', err);
    }
  }, []);

  const fetchCardConfigs = async () => {
    try {
      const result = await getBackendSrv().get<HomePageCardDTO[]>('/api/home-page-cards');

      if (!Array.isArray(result) || result.length === 0) {
        setDeviceConfigs(MONITORED_DEVICES);
        return;
      }

      const items = result
        .filter((item) => item && typeof item.cardName === 'string')
        .map((item) => ({
          id: item.id,
          room: String(item.cardName ?? '').trim(),
          deviceId: typeof item.deviceId === 'number' ? item.deviceId : null,
          deviceMac: normalizeDeviceMac(String(item.deviceMac ?? '')),
          deviceType: String(item.deviceType ?? DEFAULT_DEVICE_TYPE).trim() || DEFAULT_DEVICE_TYPE,
          dashboardUid: String(item.dashboardUid ?? '').trim(),
          dashboardUrl: String(item.dashboardUrl ?? '').trim(),
        }));

      setDeviceConfigs(items.length > 0 ? items : MONITORED_DEVICES);
    } catch (err) {
      console.error('Failed to fetch home page cards:', err);
      setDeviceConfigs(MONITORED_DEVICES);
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

        const fluxQuery = buildFluxQuery(INFLUXDB_CONFIG.bucket, deviceConfigs);
        console.info('Flux 查询语句:', fluxQuery);

        const response = await getBackendSrv().post('/api/influxdb/query', {
          query: fluxQuery,
        });

        console.info('InfluxDB 响应:', response);
        
        // 打印缓存时间戳，用于调试延时问题
        if (response?.timestamp) {
          const cacheAge = Date.now() - response.timestamp;
          console.info(`缓存年龄: ${cacheAge}ms`);
        }

        const groupedMetrics = extractDeviceMetrics(response);
        const previousMetrics = previousMetricsRef.current;
        const nextMetricsMap = new Map<string, DeviceMetrics>();
        const now = Date.now();

        const updatedVitals: DeviceVitals[] = deviceConfigs.map((config: DeviceConfig) => {
          const deviceKey = config.deviceMac;
          if (!deviceKey) {
            return buildEmptyDeviceVitals(config);
          }

          const metricsWithRisk = groupedMetrics.get(deviceKey) ?? {
            ...createEmptyMetrics(),
            fallRiskDetected: false,
            fallFlag: null,
            fallCount: null,
            humanPresence: null,
          };

          // 分离风险标志
          const {
            fallRiskDetected,
            fallFlag = null,
            fallCount = null,
            humanPresence = null,
            ...rawMetrics
          } = metricsWithRisk;

          // ——— 空白帧保持策略 ———
          // 对 heartRate / respirationRate 做"最后有效值"填充：
          // 若本帧为 null，但上次有效值未超过 METRIC_STALE_THRESHOLD_MS，则保持旧值显示，
          // 并在 staleFields 中标记，以便渲染时用灰色区分。
          const deviceLastKnown = lastKnownMetricsRef.current.get(deviceKey) ?? {
            heartRate: null,
            respirationRate: null,
            distanceMin: null,
            movementAmplitude: null,
          };

          const staleFields: Partial<Record<MetricKey, boolean>> = {};
          const STALE_KEYS: MetricKey[] = ['heartRate', 'respirationRate', 'distanceMin', 'movementAmplitude'];
          const metrics: DeviceMetrics = { ...rawMetrics };

          STALE_KEYS.forEach((key) => {
            const rawVal = rawMetrics[key];
            if (rawVal !== null && !Number.isNaN(rawVal)) {
              // 本帧有有效值 → 更新 lastKnown
              deviceLastKnown[key] = { value: rawVal, timestamp: now };
            } else {
              // 本帧为空白 → 尝试用 lastKnown 填充
              const known = deviceLastKnown[key];
              if (known !== null && now - known.timestamp < METRIC_STALE_THRESHOLD_MS) {
                metrics[key] = known.value;
                staleFields[key] = true; // 标记为"保持显示"的旧值
              }
              // 超过时效则保持 null，界面显示 '-'
            }
          });

          lastKnownMetricsRef.current.set(deviceKey, deviceLastKnown);
          // ——— 结束空白帧保持策略 ———

          nextMetricsMap.set(deviceKey, metrics);
          const trends = calculateTrends(previousMetrics.get(deviceKey), metrics);

          const deviceType = config.deviceType ?? DEFAULT_DEVICE_TYPE;
          const isFallDevice = deviceType === 'fall-detection';
          const fallDetected = isFallDevice ? fallFlag !== null && fallFlag >= 0.5 : fallRiskDetected;
          const fallTimerSeconds = isFallDevice ? fallCount ?? null : null;
          const humanPresenceValue = humanPresence == null ? null : humanPresence >= 0.5;

          const fallRisk = isFallDevice ? fallDetected : fallRiskDetected;

          const occupied = isFallDevice
            ? humanPresenceValue ?? false
            : metrics.heartRate !== null && !Number.isNaN(metrics.heartRate);

          return {
            deviceId: config.deviceId ?? null,
            deviceMac: deviceKey,
            room: config.room,
            deviceType,
            heartRate: metrics.heartRate,
            respirationRate: metrics.respirationRate,
            distanceMin: metrics.distanceMin,
            movementAmplitude: metrics.movementAmplitude,
            occupied,
            fallRisk,
            trends,
            staleFields,
            fallDetected,
            fallTimerSeconds,
            humanPresence: isFallDevice ? humanPresenceValue : null,
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
    [deviceConfigs, hasLoadedOnce]
  );

  useEffect(() => {
    fetchDashboards();
    fetchCardConfigs();
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  useEffect(() => {
  setDeviceVitals(deviceConfigs.map((config: DeviceConfig) => buildEmptyDeviceVitals(config)));
    previousMetricsRef.current = new Map();
    lastKnownMetricsRef.current = new Map();
  }, [deviceConfigs]);

  useEffect(() => {
    fetchVitals({ showIndicator: true });
    const interval = setInterval(() => {
      fetchVitals();
    }, 2000); // 缩短到 2s 轮询一次，配合后端 2s 缓存刷新
    return () => clearInterval(interval);
  }, [fetchVitals]);

  //增加房间号映射 
  const alarmSoundMap = useMemo<Record<string, string>>(
    () => ({
      '1': '/public/sounds/room1.mp3',
      '2': '/public/sounds/room2.mp3',
      '3': '/public/sounds/room3.mp3',
      '4': '/public/sounds/room4.mp3',
    }),
    []
  );

  const playMultipleAlarmSounds = useCallback((roomIds: string[]) => {
    let index = 0;
    let loopCount = 0;
    const MAX_LOOPS = 10;
    
    const playNext = () => {
      if (loopCount >= MAX_LOOPS) {
        return;
      }

      if (index < roomIds.length) {
        const roomId = roomIds[index];
        const audioFilePath = alarmSoundMap[roomId] ?? '/public/sounds/room1.mp3';

        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
        }

        const audio = new Audio(audioFilePath);
        const volume = 0.9;
        audio.volume = Math.min(1, Math.max(0, volume));

        audio.onended = () => {
          if (audioRef.current === audio) {
            audioRef.current = null;
          }
          index += 1;
          playNext();
        };

        audio.onerror = () => {
          console.error(`音频加载失败: ${audioFilePath}`);
          index += 1;
          playNext();
        };

        audioRef.current = audio;
        audio.play().catch((err) => console.error('播放失败:', err));
      } else {
        index = 0;
        loopCount += 1;
        
        if (loopCount < MAX_LOOPS) {
          alarmTimeoutRef.current = window.setTimeout(() => {
            playNext();
          }, 500);
        }
      }
    };

    playNext();
  }, [alarmSoundMap]);

  const stopAlarmSound = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    // ✅ 清除待定的超时
    if (alarmTimeoutRef.current !== null) {
      window.clearTimeout(alarmTimeoutRef.current);
      alarmTimeoutRef.current = null;
    }
    alarmPlayCountRef.current = 0;
  }, []);

  const closeAlarmModal = useCallback(() => {
    const now = Date.now();
  const currentRooms: Set<string> = new Set(alarmingRoomsRef.current);
    setAcknowledgedRiskRooms((prev: Map<string, number>) => {
      const next = new Map<string, number>(prev);
      currentRooms.forEach((room) => {
        next.set(room, now);
      });
      return next;
    });

    setAlarmModalOpen(false);
    stopAlarmSound();
    setAlarmDevices([]);
    alarmingRoomsRef.current.clear();
    setLastAlarmTime(now);
  }, [stopAlarmSound]);

  // 监听风险状态变化
  useEffect(() => {
    const riskDevices = deviceVitals
      .filter((device: DeviceVitals) => device.fallRisk)
      .map((device: DeviceVitals) => device.room);

    if (riskDevices.length > 0) {
      const now = Date.now();
      const timeSinceLastAlarm = now - lastAlarmTime;
      const ALARM_COOLDOWN_MS = 10000;

  const newRiskRooms = riskDevices.filter((room: string) => {
        const lastAck = acknowledgedRiskRooms.get(room);
        const ackExpired = !lastAck || now - lastAck >= ACK_COOLDOWN_MS;
        return ackExpired && !alarmingRoomsRef.current.has(room);
      });

      // 首次触发或检测到新增房间风险时播放
      if (
        newRiskRooms.length > 0 &&
        (timeSinceLastAlarm > ALARM_COOLDOWN_MS || !isAlarmModalOpen)
      ) {
  const displayNames = riskDevices.map((room: string) => formatRoomLabel(room));
        setAlarmDevices(displayNames);
        setAlarmModalOpen(true);
        playMultipleAlarmSounds(newRiskRooms);

  riskDevices.forEach((room: string) => alarmingRoomsRef.current.add(room));
        setLastAlarmTime(now);
      } else if (isAlarmModalOpen && riskDevices.length > 0) {
  const displayNames = riskDevices.map((room: string) => formatRoomLabel(room));
        setAlarmDevices(displayNames);
      }
    } else {
      // 所有房间都恢复正常
      alarmingRoomsRef.current.clear();
      setAcknowledgedRiskRooms((prev: Map<string, number>) =>
        prev.size === 0 ? prev : new Map<string, number>()
      );
      setAlarmModalOpen(false);
      stopAlarmSound();
      setAlarmDevices([]);
    }
  }, [
    deviceVitals,
    lastAlarmTime,
    isAlarmModalOpen,
    acknowledgedRiskRooms,
    playMultipleAlarmSounds,
    stopAlarmSound,
  ]);

  const handleManualRefresh = () => {
    fetchVitals({ showIndicator: true });
  };

  const shouldActivateFromKey = (key: string) => key === 'Enter' || key === ' ' || key === 'Spacebar';

  const handleBackdropKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    action: () => void
  ) => {
    if (event.key === 'Escape' || shouldActivateFromKey(event.key)) {
      event.preventDefault();
      action();
    }
  };

  const handleBackdropClick = (
    event: ReactMouseEvent<HTMLDivElement>,
    action: () => void,
    canClose: () => boolean = () => true
  ) => {
    if (event.target !== event.currentTarget || !canClose()) {
      return;
    }
    action();
  };

  const handleCardClick = (dashboardLink: string | null) => {
    if (dashboardLink) {
      window.location.assign(dashboardLink);
    }
  };

  const handleCardKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    dashboardLink: string | null
  ) => {
    if (!dashboardLink) {
      return;
    }
    if (shouldActivateFromKey(event.key)) {
      event.preventDefault();
      handleCardClick(dashboardLink);
    }
  };

  const openSettingsModal = () => {
    if (!deviceEntities.length) {
      fetchDevices();
    }
    setSettingsDraft(deviceConfigs.map((config: DeviceConfig) => ({ ...config })));
    setSettingsError(null);
    setSettingsNotice(null);
    setSettingsModalOpen(true);
  };

  const addSettingsRow = () => {
    setSettingsDraft((prev: DeviceConfig[]) => [
      ...prev,
      {
        room: `${prev.length + 1}`,
        deviceId: null,
        deviceMac: '',
        deviceType: DEFAULT_DEVICE_TYPE,
        dashboardUid: '',
        dashboardUrl: '',
      },
    ]);
  };

  const updateSettingsRow = (index: number, patch: Partial<DeviceConfig>) => {
    setSettingsDraft((prev: DeviceConfig[]) =>
      prev.map((item: DeviceConfig, itemIndex: number) => (itemIndex === index ? { ...item, ...patch } : item))
    );
  };

  const removeSettingsRow = (index: number) => {
  setSettingsDraft((prev: DeviceConfig[]) => prev.filter((_, itemIndex: number) => itemIndex !== index));
  };

  const handleCardDeviceSelect = (index: number, value: string) => {
    const nextDeviceId = value ? Number(value) : null;
    const selectedDevice = deviceEntities.find((device: DeviceEntity) => device.id === nextDeviceId);

    setSettingsDraft((prev: DeviceConfig[]) =>
      prev.map((item: DeviceConfig, itemIndex: number) =>
        itemIndex === index
          ? {
              ...item,
              deviceId: nextDeviceId,
              deviceMac: selectedDevice?.deviceMac ?? '',
              deviceType: item.deviceType ?? selectedDevice?.deviceType ?? DEFAULT_DEVICE_TYPE,
            }
          : item
      )
    );
  };

  const saveSettings = async () => {
    const cleanedRows: DeviceConfig[] = settingsDraft.map((item): DeviceConfig => ({
      ...item,
      room: item.room.trim(),
      deviceId: item.deviceId ?? null,
      deviceMac: normalizeDeviceMac(item.deviceMac ?? ''),
      deviceType: (item.deviceType ?? DEFAULT_DEVICE_TYPE).trim() || DEFAULT_DEVICE_TYPE,
      dashboardUid: (item.dashboardUid ?? '').trim(),
      dashboardUrl: (item.dashboardUrl ?? '').trim(),
    }));

    if (cleanedRows.length === 0) {
      setSettingsError('Please keep at least one card.');
      return;
    }

    if (cleanedRows.some((item: DeviceConfig) => !item.room || item.deviceId == null)) {
      setSettingsError('请选择卡片绑定的设备。');
      return;
    }

    const uniqueDeviceIds = new Set(cleanedRows.map((item: DeviceConfig) => item.deviceId));
    if (uniqueDeviceIds.size !== cleanedRows.length) {
      setSettingsError('每个设备只能绑定一张卡片。');
      return;
    }

    setIsSavingSettings(true);
    setSettingsError(null);

    try {
      const rowsWithId = cleanedRows.filter(
        (item: DeviceConfig): item is DeviceConfigWithId => typeof item.id === 'number'
      );
      const nextIds = new Set<number>(rowsWithId.map((item: DeviceConfigWithId) => item.id));

      const deletedIds = deviceConfigs
        .filter((item: DeviceConfig): item is DeviceConfigWithId => typeof item.id === 'number')
        .filter((item: DeviceConfigWithId) => !nextIds.has(item.id))
        .map((item: DeviceConfigWithId) => item.id);

      for (const id of deletedIds) {
        await getBackendSrv().delete(`/api/home-page-cards/${id}`);
      }

      for (const item of cleanedRows) {
        const payload = {
          deviceId: item.deviceId,
          deviceMac: item.deviceMac || undefined,
          deviceType: item.deviceType,
          cardName: item.room,
          dashboardUid: item.dashboardUid,
        };

        if (item.id != null) {
          await getBackendSrv().put(`/api/home-page-cards/${item.id}`, payload);
        } else {
          await getBackendSrv().post('/api/home-page-cards', payload);
        }
      }

      await Promise.all([fetchDashboards(), fetchCardConfigs()]);
      setSettingsNotice('Card settings saved.');
      setSettingsModalOpen(false);
    } catch (err) {
      console.error('Failed to save home page card settings:', err);
      setSettingsError(`Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const resetDeviceForm = () => {
    setDeviceFormValues({ name: '', deviceMac: '', deviceType: DEFAULT_DEVICE_TYPE, description: '' });
    setEditingDeviceId(null);
  };

  const handleDeviceFormChange = (field: keyof DeviceFormValues, value: string) => {
    const normalizedValue = field === 'deviceMac' ? value.toUpperCase() : value;
    setDeviceFormValues((prev: DeviceFormValues) => ({ ...prev, [field]: normalizedValue }));
  };

  const startEditDevice = (device: DeviceEntity) => {
    setDeviceManagerOpen(true);
    setDeviceModalError(null);
    setEditingDeviceId(device.id);
    setDeviceFormValues({
      name: device.name,
      deviceMac: device.deviceMac,
      deviceType: device.deviceType ?? DEFAULT_DEVICE_TYPE,
      description: device.description ?? '',
    });
  };

  const handleDeviceFormSubmit = async () => {
    const payload = {
      name: deviceFormValues.name.trim(),
      deviceMac: normalizeDeviceMac(deviceFormValues.deviceMac),
      deviceType: (deviceFormValues.deviceType || DEFAULT_DEVICE_TYPE).trim() || DEFAULT_DEVICE_TYPE,
      description: deviceFormValues.description.trim(),
    };

    if (!payload.name || !payload.deviceMac) {
      setDeviceModalError('请填写设备名称和 MAC。');
      return;
    }

    setIsSavingDevice(true);
    setDeviceModalError(null);

    try {
      if (editingDeviceId) {
        await getBackendSrv().put(`/api/devices/${editingDeviceId}`, payload);
      } else {
        await getBackendSrv().post('/api/devices', payload);
      }
      await fetchDevices();
      await fetchCardConfigs();
      resetDeviceForm();
    } catch (err) {
      console.error('Failed to save device:', err);
      setDeviceModalError(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setIsSavingDevice(false);
    }
  };

  const handleDeviceDelete = async (id: number) => {
    if (!window.confirm('确定要删除该设备吗？删除后需要重新绑定卡片。')) {
      return;
    }

    setDeviceModalError(null);
    try {
      await getBackendSrv().delete(`/api/devices/${id}`);
      await fetchDevices();
      await fetchCardConfigs();
      if (editingDeviceId === id) {
        resetDeviceForm();
      }
    } catch (err) {
      console.error('Failed to delete device:', err);
      setDeviceModalError(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const openDeviceManager = () => {
    fetchDevices();
    setDeviceModalError(null);
    resetDeviceForm();
    setDeviceManagerOpen(true);
  };

  const closeDeviceManager = () => {
    if (isSavingDevice) {
      return;
    }
    setDeviceManagerOpen(false);
    setDeviceModalError(null);
    resetDeviceForm();
  };

  const renderMetric = (
    label: string,
    value: number | null,
    unit: string,
    trend: MetricTrend,
    fractionDigits = 0,
    showTrend = true,
    isStale = false   // true 表示当前显示的是"保持"的旧值（空白帧补偿）
  ) => {
    const hasValue = value !== null && !Number.isNaN(value);
    const arrow = !hasValue || showPlaceholder ? '—' : trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—';
    const arrowColor = arrow === '▲' ? '#28a745' : arrow === '▼' ? '#dc3545' : 'rgba(0, 0, 0, 0.35)';
    // 保持值用灰色显示，提示用户该数据非最新帧
    const valueColor = isStale && hasValue ? 'rgba(0, 0, 0, 0.35)' : 'inherit';

    return (
      <div
        className="hp-metric-item"
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
          {isStale && hasValue && (
            <span
              title="数据短暂缺失，显示最近一次有效值"
              style={{ marginLeft: '4px', fontSize: '11px', color: 'rgba(0,0,0,0.35)', fontWeight: 400 }}
            >
              (保持)
            </span>
          )}
        </span>
        <span
          className="hp-metric-value"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '32px',
            fontWeight: 800,
            marginBottom: '4px',
            color: valueColor,
          }}
        >
          {(() => {
            if (!hasLoadedOnce && loading && !hasValue) {
              return '-';
            }
            return hasValue ? formatMetric(value, fractionDigits) : '-';
          })()}
          {showTrend && <span style={{ fontSize: '18px', color: arrowColor }}>{arrow}</span>}
        </span>
        <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.5)' }}>{unit}</span>
      </div>
    );
  };

  const renderCardHeader = (device: DeviceVitals, dashboardLink: string | null) => (
    <div className="hp-card-header" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '18px', fontWeight: 600 }}>{formatRoomLabel(device.room)}</span>
      <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>设备记录 ID: {device.deviceId ?? '未绑定'}</span>
      <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>设备 MAC: {device.deviceMac || '-'}</span>
      <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>
        设备类型：{DEVICE_TYPE_LABELS[device.deviceType] ?? device.deviceType}
      </span>
      {dashboardLink && <span style={{ fontSize: '12px', color: '#0066cc' }}>点击进入仪表板</span>}
    </div>
  );

  const renderFallDetectionCard = (device: DeviceVitals, dashboardLink: string | null) => {
    const fallStatus = device.fallDetected ? '检测到跌倒' : '正常';
    const fallStatusColor = device.fallDetected ? '#d63342' : '#1f6f43';
    const fallTimerText = formatFallTimer(device.fallTimerSeconds);
    const humanStatus = device.humanPresence == null ? '-' : device.humanPresence ? '有人' : '无人';

    const cardBackgroundColor = device.fallDetected ? 'rgba(220, 53, 69, 0.15)' : 'rgba(0, 0, 0, 0.02)';
    const cardBorderColor = device.fallDetected ? 'rgba(220, 53, 69, 0.4)' : 'rgba(0, 0, 0, 0.08)';

    return (
      <div
        key={device.deviceMac || String(device.deviceId) || device.room}
        className="hp-card hp-card-fall"
        role={dashboardLink ? 'button' : undefined}
        tabIndex={dashboardLink ? 0 : -1}
        onClick={dashboardLink ? () => handleCardClick(dashboardLink) : undefined}
        onKeyDown={dashboardLink ? (event) => handleCardKeyDown(event, dashboardLink) : undefined}
        style={{
          padding: '12px',
          backgroundColor: cardBackgroundColor,
          borderRadius: '6px',
          border: `1px solid ${cardBorderColor}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          cursor: dashboardLink ? 'pointer' : 'default',
          boxShadow: device.fallDetected ? '0 0 12px rgba(214, 51, 66, 0.35)' : undefined,
        }}
      >
        {renderCardHeader(device, dashboardLink)}
        <div
          className="hp-fall-status"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '8px',
          }}
        >
          <div
            style={{
              padding: '10px',
              borderRadius: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 600 }}>跌倒状态</span>
            <span style={{ fontSize: '20px', fontWeight: 700, color: fallStatusColor }}>{fallStatus}</span>
          </div>
          <div
            style={{
              padding: '10px',
              borderRadius: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 600 }}>跌倒计时</span>
            <span style={{ fontSize: '20px', fontWeight: 700 }}>{fallTimerText}</span>
          </div>
          <div
            style={{
              padding: '10px',
              borderRadius: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 600 }}>有人状态</span>
            <span style={{ fontSize: '20px', fontWeight: 700 }}>{showPlaceholder ? '-' : humanStatus}</span>
          </div>
        </div>

        {/* 跌倒卡片仅显示：有人 / 跌倒 / 跌倒计时（不显示心率/呼吸等） */}
      </div>
    );
  };

  // 使用 sessionStorage 持久化音频权限状态，防止切换页面后弹窗重复弹出
  const [isAudioPermissionGranted, setIsAudioPermissionGranted] = useState(() => {
    return sessionStorage.getItem('hp-audio-permission') === 'granted';
  });
  const [showAudioPermissionModal, setShowAudioPermissionModal] = useState(() => {
    // 如果已经授权或已经跳过，就不再弹出
    return sessionStorage.getItem('hp-audio-permission') === null;
  });

  const handleAudioPermissionGrant = useCallback(() => {
    setIsAudioPermissionGranted(true);
    setShowAudioPermissionModal(false);
    sessionStorage.setItem('hp-audio-permission', 'granted');
    // 同时触发首次数据加载
    fetchVitals({ showIndicator: true });
  }, [fetchVitals]);

  // 修改原有的 useEffect，延迟首次加载直到用户授权
  useEffect(() => {
    if (!isAudioPermissionGranted) {
      return;
    }

    // 只有在用户授权后才进行定时更新
    const interval = setInterval(() => {
      fetchVitals();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchVitals, isAudioPermissionGranted]);

  return (
    <Page navId="home">
      {/* ========== 响应式样式 ========== */}
      <style>{`
        /* ---------- 手机竖屏 (≤ 576px) ---------- */
        @media (max-width: 576px) {
          .hp-root {
            padding: 8px 6px 16px 6px !important;
          }
          .hp-title {
            font-size: 22px !important;
            line-height: 1.3 !important;
            margin-bottom: 10px !important;
          }
          .hp-top-buttons {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 6px !important;
          }
          .hp-top-buttons > button {
            width: 100% !important;
            justify-content: center !important;
          }
          .hp-refresh-bar {
            flex-direction: column !important;
            align-items: center !important;
            gap: 8px !important;
          }
          .hp-refresh-bar button {
            margin-left: 0 !important;
            width: 100% !important;
          }
          .hp-card-grid {
            grid-template-columns: repeat(1, minmax(0, 1fr)) !important;
          }
          .hp-card {
            padding: 10px !important;
          }
          .hp-card-header span:first-child {
            font-size: 16px !important;
          }
          .hp-status-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .hp-metrics-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .hp-metric-value {
            font-size: 24px !important;
          }
          /* 弹窗在手机上全宽 */
          .hp-modal-content {
            width: 95% !important;
            max-width: none !important;
            padding: 16px !important;
          }
          .hp-modal-content h2 {
            font-size: 18px !important;
          }
        }

        /* ---------- 手机横屏 / 小平板 (577px – 768px) ---------- */
        @media (min-width: 577px) and (max-width: 768px) {
          .hp-title {
            font-size: 30px !important;
          }
          .hp-card-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .hp-metric-value {
            font-size: 26px !important;
          }
        }

        /* ---------- 平板 (769px – 1024px) ---------- */
        @media (min-width: 769px) and (max-width: 1024px) {
          .hp-title {
            font-size: 36px !important;
          }
          .hp-card-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
      `}</style>

      {/* 音频权限弹窗 */}
      {showAudioPermissionModal && !isAudioPermissionGranted && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            className="hp-modal-content"
            style={{
              backgroundColor: '#fff',
              padding: '32px',
              borderRadius: '8px',
              width: '90%',
              maxWidth: '450px',
              boxShadow: '0 16px 32px rgba(0, 0, 0, 0.3)',
              border: '2px solid #0066cc',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                marginBottom: '16px',
              }}
            >
              <span style={{ fontSize: '28px', marginRight: '12px' }}>🔊</span>
              <h2 style={{ margin: 0, fontSize: '20px' }}>启用音频通知</h2>
            </div>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '16px',
                borderRadius: '4px',
                marginBottom: '20px',
                border: '1px solid #0066cc',
              }}
            >
              <p style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>
                为了在检测到摔倒风险时及时通知您，需要您允许浏览器播放音频。
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => {
                setShowAudioPermissionModal(false);
                sessionStorage.setItem('hp-audio-permission', 'skipped');
              }}>
                暂时跳过
              </Button>
              <Button variant="primary" onClick={handleAudioPermissionGrant}>
                启用音频通知
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 主页面内容 */}
      {!showAudioPermissionModal && (
        <>
          <div className="hp-root">
            <Box
              display="flex"
              direction="column"
              alignItems="center"
              justifyContent="center"
              paddingY={2}
            >
              {/* 顶部操作按钮 */}
              <div
                className="hp-top-buttons"
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
                <Button variant="secondary" onClick={openSettingsModal}>
                  设置
                </Button>
                <Button variant="secondary" onClick={() => setHelpModalOpen(true)}>
                  帮助
                </Button>
                <Button variant="primary" onClick={() => setContactModalOpen(true)}>
                  联系我们
                </Button>
              </div>

              {/* 标题 */}
              <h1
                className="hp-title"
                style={{ fontSize: '48px', marginBottom: '16px', textAlign: 'center' }}
              >
                欢迎来到华康数据可视化平台
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

              {settingsNotice && (
                <div
                  style={{
                    width: '100%',
                    maxWidth: '1200px',
                    padding: '16px',
                    marginBottom: '24px',
                    backgroundColor: 'rgba(40, 167, 69, 0.12)',
                    borderRadius: '4px',
                    border: '1px solid rgba(40, 167, 69, 0.35)',
                    color: '#1f6f43',
                    fontSize: '14px',
                  }}
                >
                  {settingsNotice}
                </div>
              )}

              {/* 刷新状态信息 */}
              <div
                className="hp-refresh-bar"
                style={{
                  width: '100%',
                  maxWidth: '1200px',
                  marginBottom: '24px',
                  fontSize: '12px',
                  color: 'rgba(0, 0, 0, 0.5)',
                  textAlign: 'center',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
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

              {/* 设备类型过滤 */}
              <div
                className="hp-device-filter"
                style={{
                  width: '100%',
                  maxWidth: '1200px',
                  display: 'flex',
                  gap: '8px',
                  justifyContent: 'flex-end',
                  marginBottom: '12px',
                  flexWrap: 'wrap',
                }}
              >
                {deviceFilterOptions.map((option) => (
                  <Button
                    key={option.value}
                    variant={activeDeviceFilter === option.value ? 'primary' : 'secondary'}
                    onClick={() => setActiveDeviceFilter(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              {/* 健康数据面板 */}
              <div
                className="hp-card-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: '12px',
                  width: '100%',
                  maxWidth: '1200px',
                  marginBottom: '24px',
                }}
              >
                {filteredDeviceVitals.map((device: DeviceVitals) => {
                  const dashboardLink = device.deviceMac ? dashboardUrlByDevice.get(device.deviceMac) ?? null : null;

                  if (device.deviceType === 'fall-detection') {
                    return renderFallDetectionCard(device, dashboardLink);
                  }

                  let cardBackgroundColor = 'rgba(0, 0, 0, 0.02)';
                  let cardBorderColor = 'rgba(0, 0, 0, 0.08)';

                  if (device.fallRisk) {
                    cardBackgroundColor = 'rgba(220, 53, 69, 0.12)';
                    cardBorderColor = 'rgba(220, 53, 69, 0.4)';
                  } else if (device.occupied) {
                    cardBackgroundColor = 'rgba(40, 167, 69, 0.15)';
                    cardBorderColor = 'rgba(40, 167, 69, 0.5)';
                  }

                  return (
                    <div
                      key={device.deviceMac || String(device.deviceId) || device.room}
                      className="hp-card"
                      role={dashboardLink ? 'button' : undefined}
                      tabIndex={dashboardLink ? 0 : -1}
                      onClick={dashboardLink ? () => handleCardClick(dashboardLink) : undefined}
                      onKeyDown={dashboardLink ? (event) => handleCardKeyDown(event, dashboardLink) : undefined}
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
                      {renderCardHeader(device, dashboardLink)}

                      {/* 有人状态 / 摔倒风险 */}
                      <div
                        className="hp-status-grid"
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
                            {showPlaceholder ? '-' : device.occupied ? '有人' : '无人'}
                          </span>
                        </div>
                        <div
                          style={{
                            padding: '8px 12px',
                            backgroundColor: device.fallRisk ? 'rgba(220, 53, 69, 0.15)' : 'rgba(0, 0, 0, 0.02)',
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

                      {/* 指标 */}
                      <div
                        className="hp-metrics-grid"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                          gap: '8px',
                        }}
                      >
                        {renderMetric('心率', device.heartRate, 'bpm', device.trends.heartRate, 0, true, !!device.staleFields.heartRate)}
                        {renderMetric('呼吸率', device.respirationRate, 'rpm', device.trends.respirationRate, 0, true, !!device.staleFields.respirationRate)}
                        {renderMetric('距离', device.distanceMin, 'cm', device.trends.distanceMin, 1, false, !!device.staleFields.distanceMin)}
                        {renderMetric('体动值', device.movementAmplitude, '', device.trends.movementAmplitude, 1, false, !!device.staleFields.movementAmplitude)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Box>
          </div>

          {/* 报警弹窗 */}
          {isAlarmModalOpen && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.65)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1400,
              }}
            >
              <div
                className="hp-modal-content"
                style={{
                  backgroundColor: '#fff',
                  padding: '32px',
                  borderRadius: '8px',
                  width: '90%',
                  maxWidth: '450px',
                  boxShadow: '0 16px 32px rgba(0, 0, 0, 0.3)',
                  border: '2px solid #dc3545',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
                  <span style={{ fontSize: '28px', color: '#dc3545', marginRight: '12px' }}>⚠️</span>
                  <h2 style={{ margin: 0, color: '#dc3545', fontSize: '20px' }}>检测到摔倒风险</h2>
                </div>
                <div
                  style={{
                    backgroundColor: '#fee',
                    padding: '16px',
                    borderRadius: '4px',
                    marginBottom: '20px',
                    border: '1px solid #fcc',
                  }}
                >
                  <p style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>以下房间存在风险：</p>
                  <div style={{ fontSize: '14px', color: 'rgba(0, 0, 0, 0.8)' }}>
                    {alarmDevices.map((device, index) => (
                      <div key={index} style={{ marginBottom: '4px' }}>
                        • {device}
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                  <Button variant="secondary" onClick={closeAlarmModal}>
                    关闭警报
                  </Button>
                </div>
              </div>
            </div>
          )}

          {isSettingsModalOpen && (
            <div
              role="button"
              tabIndex={0}
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1350,
              }}
              onClick={(event) =>
                handleBackdropClick(
                  event,
                  () => {
                    setSettingsModalOpen(false);
                  },
                  () => !isSavingSettings
                )
              }
              onKeyDown={(event) =>
                handleBackdropKeyDown(event, () => {
                  if (!isSavingSettings) {
                    setSettingsModalOpen(false);
                  }
                })
              }
            >
              <div
                className="hp-modal-content"
                style={{
                  backgroundColor: '#fff',
                  padding: '24px',
                  borderRadius: '8px',
                  width: '92%',
                  maxWidth: '860px',
                  maxHeight: '85vh',
                  overflowY: 'auto',
                  boxShadow: '0 12px 24px rgba(0, 0, 0, 0.2)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <h2 style={{ margin: 0, marginBottom: '8px' }}>首页卡片设置</h2>
                    <p style={{ margin: 0, fontSize: '13px', color: 'rgba(0, 0, 0, 0.6)' }}>
                      为每张首页卡片选择绑定设备、设备类型和仪表板。
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button variant="secondary" onClick={addSettingsRow}>
                      新增卡片
                    </Button>
                    <Button variant="secondary" onClick={openDeviceManager}>
                      管理设备
                    </Button>
                  </div>
                </div>

                {settingsError && (
                  <div
                    style={{
                      padding: '12px 14px',
                      marginBottom: '16px',
                      backgroundColor: '#fee',
                      border: '1px solid #fcc',
                      borderRadius: '4px',
                      color: '#c33',
                      fontSize: '13px',
                    }}
                  >
                    {settingsError}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {settingsDraft.map((item, index) => {
                    const deviceSelectValue = item.deviceId != null ? String(item.deviceId) : '';
                    const hasDeviceOption = item.deviceId != null && deviceEntities.some((device) => device.id === item.deviceId);
                    const dashboardSelectValue = item.dashboardUid ?? '';
                    const hasDashboardOption =
                      !dashboardSelectValue || dashboards.some((dashboard) => dashboard.uid === dashboardSelectValue);

                    return (
                      <div
                        key={item.id != null ? `card-${item.id}` : `draft-${index}`}
                        style={{
                          border: '1px solid rgba(0, 0, 0, 0.1)',
                          borderRadius: '6px',
                          padding: '16px',
                          backgroundColor: 'rgba(0, 0, 0, 0.015)',
                        }}
                      >
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                            gap: '12px',
                            alignItems: 'end',
                          }}
                        >
                          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>Card name</span>
                            <input
                              value={item.room}
                              onChange={(event) => updateSettingsRow(index, { room: event.target.value })}
                              placeholder="e.g. Room 2"
                              style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid rgba(0, 0, 0, 0.2)' }}
                            />
                          </label>

                          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>绑定设备</span>
                            <select
                              value={deviceSelectValue}
                              onChange={(event) => handleCardDeviceSelect(index, event.target.value)}
                              style={dropdownStyle}
                              disabled={deviceEntities.length === 0}
                            >
                              <option value="">请选择设备</option>
                              {!hasDeviceOption && deviceSelectValue && (
                                <option value={deviceSelectValue}>
                                  {item.deviceMac ? `${item.deviceMac}（未在设备列表）` : '当前设备已不可用'}
                                </option>
                              )}
                              {deviceEntities.map((device) => (
                                <option key={device.id} value={String(device.id)}>
                                  {device.name} ({device.deviceMac})
                                </option>
                              ))}
                            </select>
                            {/* <span style={{ fontSize: '12px', color: 'rgba(0,0,0,0.45)' }}>
                              当前 MAC：{item.deviceMac || '未选择'}
                            </span> */}
                          </label>

                          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>Device type</span>
                            <select
                              value={item.deviceType ?? DEFAULT_DEVICE_TYPE}
                              onChange={(event) => updateSettingsRow(index, { deviceType: event.target.value })}
                              style={dropdownStyle}
                            >
                              {DEVICE_TYPE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                            <span>Dashboard</span>
                            <select
                              value={dashboardSelectValue}
                              onChange={(event) => {
                                const dashboard = dashboardByUid.get(event.target.value);
                                updateSettingsRow(index, {
                                  dashboardUid: event.target.value,
                                  dashboardUrl: dashboard?.url ?? '',
                                });
                              }}
                              style={dropdownStyle}
                            >
                              <option value="">Unbound</option>
                              {!hasDashboardOption && dashboardSelectValue && (
                                <option value={dashboardSelectValue}>
                                  {item.dashboardUrl || `${dashboardSelectValue}（未找到）`}
                                </option>
                              )}
                              {dashboards.map((dashboard) => (
                                <option key={dashboard.uid} value={dashboard.uid}>
                                  {dashboard.title}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', gap: '12px' }}>
                          {/* <span style={{ fontSize: '12px', color: 'rgba(0, 0, 0, 0.55)' }}>
                            Current dashboard UID: {item.dashboardUid || 'Unbound'}
                          </span> */}
                          <Button variant="destructive" size="sm" onClick={() => removeSettingsRow(index)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '20px' }}>
                  <Button
                    variant="secondary"
                    onClick={() => setSettingsModalOpen(false)}
                    disabled={isSavingSettings}
                  >
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={saveSettings} disabled={isSavingSettings}>
                    {isSavingSettings ? 'Saving...' : 'Save settings'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {isDeviceManagerOpen && (
            <div
              role="button"
              tabIndex={0}
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1400,
              }}
              onClick={(event) => handleBackdropClick(event, closeDeviceManager)}
              onKeyDown={(event) => handleBackdropKeyDown(event, closeDeviceManager)}
            >
              <div
                className="hp-modal-content"
                style={{
                  backgroundColor: '#fff',
                  padding: '28px',
                  borderRadius: '10px',
                  width: '94%',
                  maxWidth: '900px',
                  maxHeight: '88vh',
                  overflowY: 'auto',
                  boxShadow: '0 18px 36px rgba(0, 0, 0, 0.25)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
                  <div>
                    <h2 style={{ margin: 0, marginBottom: '6px' }}>{editingDeviceId ? '编辑设备' : '新增设备'}</h2>
                    <p style={{ margin: 0, fontSize: '13px', color: 'rgba(0,0,0,0.6)' }}>
                      维护设备信息，确保首页卡片可以准确绑定。
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {editingDeviceId && (
                      <Button variant="secondary" onClick={resetDeviceForm} disabled={isSavingDevice}>
                        退出编辑
                      </Button>
                    )}
                    <Button variant="secondary" onClick={resetDeviceForm} disabled={isSavingDevice}>
                      新增设备
                    </Button>
                  </div>
                </div>

                {deviceModalError && (
                  <div
                    style={{
                      padding: '10px 12px',
                      marginBottom: '14px',
                      backgroundColor: '#fee',
                      border: '1px solid #fcc',
                      borderRadius: '4px',
                      color: '#c33',
                      fontSize: '13px',
                    }}
                  >
                    {deviceModalError}
                  </div>
                )}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '12px',
                    marginBottom: '18px',
                  }}
                >
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                    <span>设备名称</span>
                    <input
                      value={deviceFormValues.name}
                      onChange={(event) => handleDeviceFormChange('name', event.target.value)}
                      placeholder="如 老人床位 301"
                      style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid rgba(0,0,0,0.2)' }}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                    <span>设备 MAC</span>
                    <input
                      value={deviceFormValues.deviceMac}
                      onChange={(event) => handleDeviceFormChange('deviceMac', event.target.value)}
                      placeholder="B8F862F6BFD8"
                      style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid rgba(0,0,0,0.2)', textTransform: 'uppercase' }}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
                    <span>设备类型</span>
                    <select
                      value={deviceFormValues.deviceType}
                      onChange={(event) => handleDeviceFormChange('deviceType', event.target.value)}
                      style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid rgba(0,0,0,0.2)' }}
                    >
                      {DEVICE_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', gridColumn: '1 / -1' }}>
                    <span>备注</span>
                    <textarea
                      value={deviceFormValues.description}
                      onChange={(event) => handleDeviceFormChange('description', event.target.value)}
                      placeholder="可填写安装位置、备注信息等"
                      rows={2}
                      style={{ padding: '8px 10px', borderRadius: '4px', border: '1px solid rgba(0,0,0,0.2)', resize: 'vertical' }}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginBottom: '20px' }}>
                  <Button variant="secondary" onClick={closeDeviceManager} disabled={isSavingDevice}>
                    关闭
                  </Button>
                  <Button variant="primary" onClick={handleDeviceFormSubmit} disabled={isSavingDevice}>
                    {isSavingDevice ? '保存中...' : editingDeviceId ? '更新设备' : '保存设备'}
                  </Button>
                </div>

                <div>
                  <h3 style={{ marginTop: 0, marginBottom: '10px', fontSize: '16px' }}>设备列表</h3>
                  {deviceEntities.length === 0 ? (
                    <div style={{ padding: '16px', border: '1px dashed rgba(0,0,0,0.2)', borderRadius: '6px', fontSize: '13px', color: 'rgba(0,0,0,0.6)' }}>
                      暂无设备，请先添加。
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ backgroundColor: 'rgba(0,0,0,0.04)' }}>
                            <th style={{ textAlign: 'left', padding: '8px 6px' }}>名称</th>
                            <th style={{ textAlign: 'left', padding: '8px 6px' }}>MAC</th>
                            <th style={{ textAlign: 'left', padding: '8px 6px' }}>类型</th>
                            <th style={{ textAlign: 'left', padding: '8px 6px' }}>备注</th>
                            <th style={{ textAlign: 'right', padding: '8px 6px' }}>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deviceEntities.map((device) => (
                            <tr key={device.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                              <td style={{ padding: '10px 6px', fontWeight: 600 }}>{device.name}</td>
                              <td style={{ padding: '10px 6px', fontFamily: 'monospace' }}>{device.deviceMac}</td>
                              <td style={{ padding: '10px 6px' }}>{DEVICE_TYPE_LABELS[device.deviceType ?? DEFAULT_DEVICE_TYPE] ?? device.deviceType}</td>
                              <td style={{ padding: '10px 6px', color: 'rgba(0,0,0,0.7)' }}>{device.description || '-'}</td>
                              <td style={{ padding: '10px 6px' }}>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                  <Button variant="secondary" size="sm" onClick={() => startEditDevice(device)} disabled={isSavingDevice}>
                                    编辑
                                  </Button>
                                  <Button variant="destructive" size="sm" onClick={() => handleDeviceDelete(device.id)} disabled={isSavingDevice}>
                                    删除
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 帮助弹窗 */}
          {isHelpModalOpen && (
            <div
              role="button"
              tabIndex={0}
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1300,
              }}
              onClick={(event) => handleBackdropClick(event, () => setHelpModalOpen(false))}
              onKeyDown={(event) => handleBackdropKeyDown(event, () => setHelpModalOpen(false))}
            >
              <div
                className="hp-modal-content"
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
              >
                <h2 style={{ marginBottom: '12px' }}>界面使用教程</h2>
                <ol style={{ fontSize: '14px', lineHeight: 1.6, paddingLeft: '18px', marginBottom: '16px' }}>
                  <li>顶部按钮支持快速跳转平台、查看帮助与联系我们信息。</li>
                  <li>房间卡片展示实时健康数据，可点击进入对应仪表板。</li>
                  <li>使用“手动刷新”按钮获取最新数据，或等待系统自动更新。</li>
                  <li>卡片颜色指示状态：绿色表示有人且无风险，红色表示检测到摔倒风险。</li>
                  <li>目前如果1分钟内有任何风险值，都会提示存在风险。</li>
                </ol>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="secondary" onClick={() => setHelpModalOpen(false)}>
                    关闭
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 联系我们弹窗 */}
          {isContactModalOpen && (
            <div
              role="button"
              tabIndex={0}
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1300,
              }}
              onClick={(event) => handleBackdropClick(event, () => setContactModalOpen(false))}
              onKeyDown={(event) => handleBackdropKeyDown(event, () => setContactModalOpen(false))}
            >
              <div
                className="hp-modal-content"
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
              >
                <h2 style={{ marginBottom: '12px' }}>联系我们</h2>
                <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
                  如果您对我们的 &quot;人工智能 + 边缘计算&quot; 相关产品与服务感兴趣，或有合作意向，欢迎通过以下方式与我们联系：
                </p>
                <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>团队背景</h3>
                <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
                  我们是华侨大学华大智语 &amp; 清大华宇联合团队。华大智语由华侨大学王华珍副教授领衔，近 60
                  名师生组成，学术研发实力强劲；清大华宇是清华海峡研究院团队，拥有十多年产业化经验，提供算力和产品支撑。双方协同构建产学研协同基底，形成全链条技术闭环、学术与产业双轮驱动、&quot;0→1
                  研发到 1→N 落地&quot;
                  的核心优势，在华文教育机器人出海、智算中心服务等领域成果斐然。
                </p>
                <h3 style={{ fontSize: '16px', marginBottom: '8px' }}>联系方式</h3>
                <p style={{ fontSize: '14px', lineHeight: 1.6, marginBottom: '12px' }}>
                  版权所有：华侨大学华大智语 | 清大华宇（厦门）数字科技有限公司
                  <br />
                  地址：福建省厦门市集美区集美大道 668 号
                  <br />
                  联系：wanghuazhen@hqu.edu.cn；lucky@lanhc.com
                  <br />
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
        </>
      )}
    </Page>
  );
}
