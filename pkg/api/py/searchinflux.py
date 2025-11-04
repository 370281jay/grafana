# class InfluxProcessor:
#     def __init__(self):
#         # InfluxDB Configuration (复用 subscriber.py 的环境变量)
#         self.influxdb_url = os.getenv('INFLUXDB_URL', 'http://influxdb:8086')
#         self.influxdb_token = os.getenv('INFLUXDB_TOKEN', 'ld6002h-admin-token')
#         self.influxdb_org = os.getenv('INFLUXDB_ORG', 'ld6002h')
#         self.influxdb_bucket = os.getenv('INFLUXDB_BUCKET', 'vitals_data')
        
#         self.influxdb_client = None
#         self.write_api = None
#         self._initialize_influxdb()

import os
import math
import time
import json
import requests
from typing import Optional, Dict, Any
import random
import logging

import influxdb_client
# from influxdb_client.client.write_api import SYNCHRONOUS  # 如需写入再启用

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 环境变量配置（请按实际填写）
# 使用环境变量（优先），在 docker-compose 中将 INFLUXDB_URL 设置为 http://influxdb:8086
INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://influxdb:8086")
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN", os.getenv("DOCKER_INFLUXDB_INIT_ADMIN_TOKEN", "ld6002h-admin-token"))
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "ld6002h")
BUCKET = os.getenv("INFLUXDB_BUCKET", "vitals_data")
DEVICE_ID = os.getenv("DEVICE_ID", "84F7035346E0")
# MEASUREMENT = os.getenv("INFLUX_MEASUREMENT", "")  # 若需限定 measurement，可设置

# 阈值（可按需调整）
HR_ABS = float(os.getenv("HR_ABS", "20"))   # 心率绝对偏差阈值（bpm）
HR_REL = float(os.getenv("HR_REL", "0.30")) # 心率相对偏差阈值
RR_ABS = float(os.getenv("RR_ABS", "5"))    # 呼吸绝对偏差阈值（rpm）
RR_REL = float(os.getenv("RR_REL", "0.35")) # 呼吸相对偏差阈值

# 全局变量 存储连续异常
HR_ALERT_COUNT = 0
RR_ALERT_COUNT = 0
ALERT_THRESHOLD = 3

# def _filter_measurement():
#     return f'|> filter(fn: (r) => r._measurement == "{MEASUREMENT}")\n' if MEASUREMENT else ""

def _flux_sample_tma_2m(bucket: str, device_id: str, field: str,n: int = 1) -> str:
    # 过去12小时，10m 频率，5 分钟滚动均值，返回整个序列；
    return f'''from(bucket: "{bucket}")
  |> range(start: -12h)
  |> filter(fn: (r) => r["device_id"] == "{device_id}")
  |> filter(fn: (r) => r["_field"] == "{field}")
  |> filter(fn: (r) => r._value != 0)
  |> timedMovingAverage(every: 5m, period: 10m)
  |> filter(fn: (r) => r._value != 0)
  '''

def _flux_mean_5m(bucket: str, device_id: str, field: str) -> str:
    # 过去2分钟整体均值（对齐当前时刻）
    return f'''from(bucket: "{bucket}")
  |> range(start: -2m)
  |> filter(fn: (r) => r["device_id"] == "{device_id}")
  |> filter(fn: (r) => r["_field"] == "{field}")
  |> filter(fn: (r) => r._value != 0)
  |> mean()'''

def _query_single_value(client: influxdb_client.InfluxDBClient, flux: str) -> Optional[float]:
    """返回查询到的第一个数值（或 None）"""
    try:
        tables = client.query_api().query(org=INFLUXDB_ORG, query=flux)
        for table in tables:
            for record in table.records:
                try:
                    return float(record.get_value())
                except Exception:
                    # 兼容 record._value 或其他字段
                    try:
                        return float(record.values.get("_value"))
                    except Exception:
                        continue
    except Exception as e:
        logger.exception("查询单值失败: %s", e)
    return None

def _query_values(client: influxdb_client.InfluxDBClient, flux: str):
    """返回查询到的数值列表（可能为空）"""
    vals = []
    try:
        tables = client.query_api().query(org=INFLUXDB_ORG, query=flux)
        for table in tables:
            for record in table.records:
                try:
                    v = record.get_value()
                    vals.append(float(v))
                except Exception:
                    try:
                        vals.append(float(record.values.get("_value")))
                    except Exception:
                        continue
    except Exception as e:
        logger.exception("查询序列失败: %s", e)
    return vals

# 新增：对序列排序并取中间 n 个值求平均（中位截尾方式）
def _middle_n_mean(vals: list, n: int = 10) -> Optional[float]:
    """
    对 vals 做排序，取中间 n 个值求平均（去掉两端极端值）。
    如果 vals 为空返回 None；若 len(vals) < n，则返回全部值的平均。
    """
    if not vals:
        return None
    vals_sorted = sorted(vals)
    L = len(vals_sorted)
    if L <= n:
        return sum(vals_sorted) / L
    # 计算中间 n 个元素的起始索引，向下取整以居中
    start = (L - n) // 2
    middle_slice = vals_sorted[start:start + n]
    return sum(middle_slice) / len(middle_slice)

def query_and_judge():
    global HR_ALERT_COUNT, RR_ALERT_COUNT
    logger.info("开始执行 searchinflux.query_and_judge()")
    if not INFLUXDB_TOKEN:
        logger.warning("缺少 INFLUXDB_TOKEN 环境变量，跳过查询")
        return

    try:
        with influxdb_client.InfluxDBClient(url=INFLUXDB_URL, token=INFLUXDB_TOKEN, org=INFLUXDB_ORG) as client:
            logger.debug("InfluxDBClient 已创建，开始查询心率/呼吸数据")
            hr_series = _query_values(client, _flux_sample_tma_2m(BUCKET, DEVICE_ID, "heart_rate_bpm"))
            # 使用中间 10 个值求平均，降低离群点影响
            hr2m = _middle_n_mean(hr_series, n=10)
            logger.info("hr2m_sampled_avg=%s series_len=%d", hr2m, len(hr_series))

            hr5m = _query_single_value(client, _flux_mean_5m(BUCKET, DEVICE_ID, "heart_rate_bpm"))
            logger.info("hr5m=%s", hr5m)

            rr_series = _query_values(client, _flux_sample_tma_2m(BUCKET, DEVICE_ID, "respiration_bpm"))
            rr2m = _middle_n_mean(rr_series, n=10)
            logger.info("rr2m_avg5=%s series_len=%d", rr2m, len(rr_series))

            rr5m = _query_single_value(client, _flux_mean_5m(BUCKET, DEVICE_ID, "respiration_bpm"))
            logger.info("rr5m=%s", rr5m)
    except Exception as e:
        logger.exception("连接或查询 InfluxDB 时出错: %s", e)
        return
    

    # 处理最近 5 分钟无数据的情况
    no_recent_hr = (hr5m is None) and (not hr_series)
    no_recent_rr = (rr5m is None) and (not rr_series)

    if no_recent_hr and no_recent_rr:
        logger.warning("设备 %s 在最近 5 分钟内无心率和呼吸数据，跳过阈值判断（可视为离线）", DEVICE_ID)
        return

    hr_alert = False
    rr_alert = False
    alerts = []
    # 心率异常判断（仅当有足够数据时）
    if no_recent_hr:
        logger.info("设备 %s 心率最近 5 分钟无数据，跳过心率判断", DEVICE_ID)
    else:
        if hr2m is None or hr5m is None:
            logger.info("心率数据不足 hr2m=%s hr5m=%s", hr2m, hr5m)
        else:
            hr_absdiff = abs(hr2m - hr5m)
            hr_reldiff = hr_absdiff / hr5m if hr5m else 0
            logger.info("心率对比 hr2m=%.2f hr5m=%.2f abs=%.2f rel=%.3f", hr2m, hr5m, hr_absdiff, hr_reldiff)
            if hr_absdiff > HR_ABS or hr_reldiff > HR_REL:
                hr_alert = True
                alerts.append(f"HR异常: hr2m={hr2m:.1f} hr5m={hr5m:.1f} abs={hr_absdiff:.1f} rel={hr_reldiff:.2f}")

    # 呼吸异常判断（仅当有足够数据时）
    if no_recent_rr:
        logger.info("设备 %s 呼吸最近 5 分钟无数据，跳过呼吸判断", DEVICE_ID)
    else:
        if rr2m is None or rr5m is None:
            logger.info("呼吸数据不足 rr2m=%s rr5m=%s", rr2m, rr5m)
        else:
            rr_absdiff = abs(rr2m - rr5m)
            rr_reldiff = rr_absdiff / rr5m if rr5m else 0
            logger.info("呼吸对比 rr2m=%.2f rr5m=%.2f abs=%.2f rel=%.3f", rr2m, rr5m, rr_absdiff, rr_reldiff)
            if rr_absdiff > RR_ABS or rr_reldiff > RR_REL:
                rr_alert = True
                alerts.append(f"RR异常: rr2m={rr2m:.1f} rr5m={rr5m:.1f} abs={rr_absdiff:.1f} rel={rr_reldiff:.2f}")
    if hr_alert:
        HR_ALERT_COUNT +=1
    else:
        HR_ALERT_COUNT = 0

    if rr_alert:
        RR_ALERT_COUNT += 1
    else:
        RR_ALERT_COUNT = 0
    
    #检查是否连续异常阈值 任意数值连续三次异常
    if HR_ALERT_COUNT >= ALERT_THRESHOLD or RR_ALERT_COUNT >= ALERT_THRESHOLD:
        logger.warning("ALERT: 老人身体异常 连续 %d 次心率或呼吸异常")
        HR_ALERT_COUNT = 0  # 重置计数器
        RR_ALERT_COUNT = 0

    if alerts:
        for a in alerts:
            logger.warning("ALERT: %s", a)
    else:
        logger.info("无异常 (alerts empty)")

    logger.info("searchinflux.query_and_judge() 执行结束")

if __name__ == "__main__":
    query_and_judge()