"""Garmin Connect Personal API から睡眠と運動のデータを取得し、頭痛ノートに読み込めるJSONを書き出す。

使い方:
    python garmin_sync/fetch_garmin.py              # 直近30日
    python garmin_sync/fetch_garmin.py --days 90
    python garmin_sync/fetch_garmin.py --save-raw   # APIの生の応答も raw/ に保存（形式の確認用）

APIキーは環境変数 GARMIN_PERSONAL_API_KEY か、~/.config/garmin/connect-personal-api-key
（Windowsでは %USERPROFILE%\\.config\\garmin\\connect-personal-api-key）から読む。
Garmin公式クライアント garmin/connect-personal-api-python と同じ置き場所。
必要なのは requests だけ（Python 3.9以上）。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

import requests

BASE_URL = os.environ.get("GARMIN_PERSONAL_API_BASE_URL", "https://personal.connectapi.garmin.com").rstrip("/")
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
KEY_ENV = "GARMIN_PERSONAL_API_KEY"
KEY_FILE = Path("~/.config/garmin/connect-personal-api-key").expanduser()
TOKEN_CACHE = Path("~/.config/garmin/headache-note-bearer-token.json").expanduser()
HERE = Path(__file__).resolve().parent
TIMEOUT = 30


# ---------- 認証 ----------
def read_api_key() -> str:
    v = os.environ.get(KEY_ENV)
    if v and v.strip():
        return v.strip()
    if KEY_FILE.exists():
        v = KEY_FILE.read_text(encoding="utf-8").strip()
        if v:
            return v
    sys.exit(
        f"APIキーが見つかりません。環境変数 {KEY_ENV} を設定するか、\n"
        f"{KEY_FILE} にキーだけを書いたファイルを置いてください。"
    )


def jwt_exp(token: str) -> float:
    try:
        payload = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
    except Exception:
        return time.time() + 3600  # 期限が読めなければ1時間だけ使う


def bearer_token(session: requests.Session, key: str) -> str:
    # キーそのものは保存しない。キャッシュにはキーのハッシュとアクセストークンだけを置く
    import hashlib

    fp = hashlib.sha256(f"{BASE_URL}\0{key}".encode()).hexdigest()
    try:
        c = json.loads(TOKEN_CACHE.read_text(encoding="utf-8"))
        if c.get("fingerprint") == fp and c["expires_at"] - time.time() > 3600:
            return c["access_token"]
    except (FileNotFoundError, ValueError, KeyError):
        pass
    r = session.post(BASE_URL + TOKEN_PATH, headers={"Accept": "*/*", "Authorization": f"ApiKey {key}"}, timeout=TIMEOUT)
    if r.status_code in (401, 403):
        sys.exit(f"APIキーが受け付けられませんでした（HTTP {r.status_code}）。期限切れか、コピーの誤りがないか確認してください。")
    r.raise_for_status()
    token = r.text.strip()
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(json.dumps({"fingerprint": fp, "access_token": token, "expires_at": jwt_exp(token)}), encoding="utf-8")
    return token


class Api:
    def __init__(self, session: requests.Session, token: str, raw_dir: Path | None):
        self.s = session
        self.h = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        self.raw_dir = raw_dir

    def get(self, path: str, params: dict | None = None, raw_name: str | None = None) -> Any:
        r = self.s.get(BASE_URL + path, headers=self.h, params=params, timeout=TIMEOUT)
        if r.status_code == 429:
            time.sleep(10)
            r = self.s.get(BASE_URL + path, headers=self.h, params=params, timeout=TIMEOUT)
        if not r.ok:
            raise RuntimeError(f"GET {path} が HTTP {r.status_code} を返しました: {r.text[:200]}")
        data = r.json() if r.content else None
        if self.raw_dir and raw_name:
            self.raw_dir.mkdir(parents=True, exist_ok=True)
            (self.raw_dir / f"{raw_name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return data


# ---------- 応答の読み取り ----------
# 応答の形が公開資料に載っていないため、calendarDate を持つ辞書を探して読む
def records_with_date(obj: Any) -> Iterator[dict]:
    if isinstance(obj, dict):
        if "calendarDate" in obj:
            yield obj
        for v in obj.values():
            if isinstance(v, (dict, list)):
                yield from records_with_date(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from records_with_date(v)


def num(d: dict, *names: str) -> float | None:
    for n in names:
        v = d.get(n)
        if isinstance(v, (int, float)):
            return v
    return None


def local_hm(ms: float | None) -> str | None:
    # Garminの *TimestampLocal は「現地時刻をUTCとして表したミリ秒」
    if ms is None:
        return None
    return datetime.utcfromtimestamp(ms / 1000).strftime("%H:%M")


def parse_sleep(rec: dict) -> dict | None:
    secs = num(rec, "sleepTimeSeconds", "totalSleepSeconds", "sleepTimeInSeconds", "durationInSeconds")
    if not secs:
        return None
    out = {"sleepMin": round(secs / 60)}
    for key, names in {
        "deepMin": ("deepSleepSeconds", "deepSleepDurationInSeconds"),
        "remMin": ("remSleepSeconds", "remSleepInSeconds", "remSleepDurationInSeconds"),
        "lightMin": ("lightSleepSeconds", "lightSleepDurationInSeconds"),
        "awakeMin": ("awakeSleepSeconds", "awakeDurationInSeconds"),
    }.items():
        v = num(rec, *names)
        if v is not None:
            out[key] = round(v / 60)
    score = rec.get("sleepScores") or {}
    overall = score.get("overall") if isinstance(score, dict) else None
    if isinstance(overall, dict) and isinstance(overall.get("value"), (int, float)):
        out["sleepScore"] = overall["value"]
    elif isinstance(rec.get("sleepScore"), (int, float)):
        out["sleepScore"] = rec["sleepScore"]
    bed = local_hm(num(rec, "sleepStartTimestampLocal"))
    wake = local_hm(num(rec, "sleepEndTimestampLocal"))
    if bed:
        out["bedtime"] = bed
    if wake:
        out["wake"] = wake
    return out


def fetch_sleep(api: Api, start: date, end: date) -> dict[str, dict]:
    days: dict[str, dict] = {}
    try:
        data = api.get("/sleep-service/sleep/dailySleepSummariesByDate",
                       {"startDate": start.isoformat(), "endDate": end.isoformat()}, "sleep_summaries")
        for rec in records_with_date(data):
            s = parse_sleep(rec)
            if s:
                days[rec["calendarDate"]] = s
    except RuntimeError as e:
        print("  睡眠サマリーの一括取得に失敗したため、1日ずつ取得します:", e)
    if days:
        return days
    d = start
    while d <= end:
        data = api.get("/sleep-service/sleep/dailySleep", {"date": d.isoformat()}, f"sleep_{d.isoformat()}")
        for rec in records_with_date(data):
            s = parse_sleep(rec)
            if s:
                days[rec["calendarDate"]] = s
                break
        d += timedelta(days=1)
    return days


def fetch_daily(api: Api, start: date, end: date) -> dict[str, dict]:
    data = api.get("/usersummary-service/v2/dailysummaries",
                   {"startDate": start.isoformat(), "endDate": end.isoformat()}, "daily_summaries")
    days: dict[str, dict] = {}
    for rec in records_with_date(data):
        out = {}
        steps = num(rec, "totalSteps", "steps")
        if steps is not None:
            out["steps"] = int(steps)
        mod = num(rec, "moderateIntensityMinutes", "moderateIntensityDurationInMinutes")
        vig = num(rec, "vigorousIntensityMinutes", "vigorousIntensityDurationInMinutes")
        if mod is not None or vig is not None:
            out["intensityMin"] = int((mod or 0) + (vig or 0))
        stress = num(rec, "averageStressLevel")
        if stress is not None and stress >= 0:
            out["stressAvg"] = int(stress)
        if out:
            days.setdefault(rec["calendarDate"], {}).update(out)
    return days


def fetch_activities(api: Api, start: date, end: date) -> dict[str, list]:
    days: dict[str, list] = {}
    offset = 0
    while True:
        data = api.get("/activitylist-service/activities/search/activities",
                       {"start": offset, "limit": 100, "startDate": start.isoformat(), "endDate": end.isoformat()},
                       f"activities_{offset}")
        items = data if isinstance(data, list) else (data or {}).get("activityList", [])
        for a in items:
            st = a.get("startTimeLocal")
            dur = num(a, "duration", "elapsedDuration", "movingDuration")
            if not st or not dur:
                continue
            t = a.get("activityType")
            days.setdefault(st[:10], []).append({
                "type": t.get("typeKey") if isinstance(t, dict) else None,
                "name": a.get("activityName"),
                "start": st[11:16],
                "min": round(dur / 60),
            })
        if len(items) < 100:
            break
        offset += 100
    return days


def main() -> None:
    ap = argparse.ArgumentParser(description="Garminの睡眠・運動データを頭痛ノート用JSONに書き出す")
    ap.add_argument("--days", type=int, default=30, help="今日から何日さかのぼるか（初期値30）")
    ap.add_argument("--out", type=Path, default=HERE / "out", help="書き出し先フォルダ")
    ap.add_argument("--save-raw", action="store_true", help="APIの生の応答を raw/ に保存する")
    args = ap.parse_args()

    end = date.today()
    start = end - timedelta(days=args.days - 1)
    session = requests.Session()
    api = Api(session, bearer_token(session, read_api_key()), HERE / "raw" if args.save_raw else None)

    print(f"{start}〜{end} のデータを取得します")
    sleep = fetch_sleep(api, start, end)
    print(f"  睡眠: {len(sleep)}日分")
    daily = fetch_daily(api, start, end)
    print(f"  日次サマリー: {len(daily)}日分")
    acts = fetch_activities(api, start, end)
    print(f"  アクティビティ: {sum(len(v) for v in acts.values())}件")

    days = []
    for k in sorted(set(sleep) | set(daily) | set(acts)):
        rec: dict[str, Any] = {"date": k}
        rec.update(sleep.get(k, {}))
        rec.update(daily.get(k, {}))
        # アクティビティを記録しなかった日は運動0分として書く
        rec["exerciseMin"] = sum(a["min"] for a in acts.get(k, []))
        if k in acts:
            rec["activities"] = acts[k]
        days.append(rec)

    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"garmin-{end.strftime('%Y%m%d')}.json"
    path.write_text(json.dumps({
        "format": "headache-note-daily", "version": 1, "source": "garmin",
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "range": [start.isoformat(), end.isoformat()], "days": days,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"書き出しました: {path}")
    if not sleep and not daily and not acts:
        print("データが1件も読めませんでした。--save-raw を付けて再実行し、raw/ の中身を確認してください。")


if __name__ == "__main__":
    main()
