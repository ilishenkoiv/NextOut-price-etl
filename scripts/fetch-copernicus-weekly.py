"""Download ERA5-Land point time-series and reduce them to daily weather facts.

Requires a free Copernicus CDS account, accepted dataset licence, and ~/.cdsapirc:
  pip install "cdsapi>=0.7.7"
  python scripts/fetch-copernicus-weekly.py

The script never prints the CDS token. Raw downloads and daily intermediates are local generated
artifacts and are not committed. Only 1991-2020 rows are retained after each point is processed.
"""
from __future__ import annotations

import csv
import json
import math
import re
import shutil
import sys
import tempfile
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

try:
    import cdsapi
except ImportError as exc:
    raise SystemExit('cdsapi is missing. Install with: pip install "cdsapi>=0.7.7"') from exc

try:
    import truststore
except ImportError as exc:
    raise SystemExit(
        'truststore is missing. Install weather dependencies from '
        'requirements-copernicus-weather.txt'
    ) from exc

# The bundled Windows Python runtime does not automatically use the operating
# system certificate store. Keep HTTPS verification enabled and delegate trust
# decisions to Windows instead of disabling certificate checks.
truststore.inject_into_ssl()

ROOT = Path(__file__).resolve().parents[1]
COORDS_JS = ROOT / "src" / "data" / "coords.js"
OUT = ROOT / "data" / "copernicus-weekly"
RAW = OUT / "raw"
DAILY = OUT / "daily"
MANIFEST = OUT / "manifest.json"
RESOLVED_POINTS = OUT / "resolved-points.json"
START_YEAR, END_YEAR = 1991, 2020
MIN_DAILY_ROWS = 10_900
LAND_DATASET = "reanalysis-era5-land-timeseries"
GLOBAL_DATASET = "reanalysis-era5-single-levels-timeseries"
LAND_PROBE_LIMIT = 4
VARIABLES = ["2m_temperature", "total_precipitation", "surface_solar_radiation_downwards"]


def coordinates() -> dict[str, tuple[float, float]]:
    text = COORDS_JS.read_text(encoding="utf-8")
    body = text.split("export const DEST_COORDS = {", 1)[1].split("};", 1)[0]
    return {
        iata: (float(lat), float(lng))
        for iata, lat, lng in re.findall(r"^\s*([A-Z]{3}):\s*\[(-?[0-9.]+),\s*(-?[0-9.]+)\]", body, re.M)
    }


def coord_key(lat: float, lng: float) -> str:
    return f"{lat:.3f}_{lng:.3f}".replace("-", "m").replace(".", "p")


def request_for(lat: float, lng: float) -> dict[str, object]:
    return {
        "variable": VARIABLES,
        "data_format": "csv",
        "location": {"latitude": lat, "longitude": lng},
        "date": [f"{START_YEAR}-01-01/{END_YEAR}-12-31"],
    }


def probe_request_for(lat: float, lng: float) -> dict[str, object]:
    return {
        "variable": ["2m_temperature"],
        "data_format": "csv",
        "location": {"latitude": lat, "longitude": lng},
        "date": ["2020-01-01/2020-01-02"],
    }


def nearby_grid_locations(lat: float, lng: float) -> list[tuple[float, float]]:
    base_lat, base_lng = round(lat, 1), round(lng, 1)
    longitude_scale = math.cos(math.radians(lat))
    points = {
        (round(base_lat + lat_step / 10, 1), round(base_lng + lng_step / 10, 1))
        for lat_step in range(-3, 4)
        for lng_step in range(-3, 4)
        if (lat_step, lng_step) != (0, 0)
        and -90 <= base_lat + lat_step / 10 <= 90
        and -180 <= base_lng + lng_step / 10 <= 179.9
    }
    return sorted(
        points,
        key=lambda point: (point[0] - lat) ** 2 + ((point[1] - lng) * longitude_scale) ** 2,
    )


def first(row: dict[str, str], aliases: tuple[str, ...]) -> float | None:
    lowered = {key.lower().replace(" ", "_"): value for key, value in row.items()}
    for alias in aliases:
        value = lowered.get(alias)
        if value not in (None, ""):
            try:
                return float(value)
            except ValueError:
                pass
    return None


def timestamp(row: dict[str, str]) -> str | None:
    lowered = {key.lower().replace(" ", "_"): value for key, value in row.items()}
    for key in ("valid_time", "time", "date", "datetime"):
        value = lowered.get(key)
        if value:
            return value.replace(" ", "T").replace("Z", "")[:16]
    return None


def csv_paths(download: Path, temp: Path) -> list[Path]:
    if zipfile.is_zipfile(download):
        with zipfile.ZipFile(download) as archive:
            archive.extractall(temp)
        return list(temp.rglob("*.csv"))
    target = temp / "data.csv"
    shutil.copy2(download, target)
    return [target]


def nearest_land_location(download: Path, requested_lat: float, requested_lng: float) -> tuple[float, float] | None:
    candidates: set[tuple[float, float]] = set()
    with tempfile.TemporaryDirectory() as tmp:
        for path in csv_paths(download, Path(tmp)):
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    if first(row, ("2m_temperature", "t2m")) is None:
                        continue
                    lat = first(row, ("latitude", "lat"))
                    lng = first(row, ("longitude", "lon", "lng"))
                    if lat is not None and lng is not None:
                        candidates.add((lat, lng))
    if not candidates:
        return None
    longitude_scale = math.cos(math.radians(requested_lat))
    return min(
        candidates,
        key=lambda point: (point[0] - requested_lat) ** 2
        + ((point[1] - requested_lng) * longitude_scale) ** 2,
    )


def daily_file_complete(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
        return isinstance(rows, list) and len(rows) >= MIN_DAILY_ROWS
    except (OSError, json.JSONDecodeError):
        return False


def reduce_download(download: Path) -> list[dict[str, object]]:
    merged: dict[str, dict[str, float]] = defaultdict(dict)
    with tempfile.TemporaryDirectory() as tmp:
        for path in csv_paths(download, Path(tmp)):
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    ts = timestamp(row)
                    if not ts or not (START_YEAR <= int(ts[:4]) <= END_YEAR):
                        continue
                    temp_k = first(row, ("2m_temperature", "t2m"))
                    precip = first(row, ("total_precipitation", "tp"))
                    solar = first(row, ("surface_solar_radiation_downwards", "ssrd"))
                    if temp_k is not None:
                        merged[ts]["temp"] = temp_k - 273.15 if temp_k > 150 else temp_k
                    if precip is not None:
                        merged[ts]["precip_raw"] = precip
                    if solar is not None:
                        merged[ts]["solar_raw"] = solar

    days: dict[str, dict[str, float]] = defaultdict(lambda: {
        "tmax": -math.inf, "tmin": math.inf, "precip_mm": 0.0, "rain_hours": 0.0,
        "sun_hours": 0.0, "hours": 0.0,
    })
    for ts in sorted(merged):
        values = merged[ts]
        if "temp" not in values:
            continue
        raw_precip = values.get("precip_raw", 0.0)
        raw_solar = values.get("solar_raw", 0.0)
        # The ERA5-Land time-series catalogue already de-accumulates precipitation
        # and radiation to one value per hour. Do not subtract adjacent samples a
        # second time: that would erase consecutive rainy/sunny hours.
        precip_mm = max(0.0, raw_precip * 1000.0)  # hourly metres → mm
        solar_wm2 = max(0.0, raw_solar / 3600.0)   # hourly J/m² → mean W/m²
        date = ts[:10]
        day = days[date]
        day["tmax"] = max(day["tmax"], values["temp"])
        day["tmin"] = min(day["tmin"], values["temp"])
        day["precip_mm"] += precip_mm
        day["rain_hours"] += 1 if precip_mm >= 0.1 else 0
        day["sun_hours"] += 1 if solar_wm2 >= 120 else 0
        day["hours"] += 1

    result = []
    for date, day in sorted(days.items()):
        if day["hours"] < 18:
            continue
        wet = day["precip_mm"] >= 1
        result.append({
            "date": date,
            "tmax": round(day["tmax"], 3),
            "tmin": round(day["tmin"], 3),
            "precipMm": round(day["precip_mm"], 3),
            "rainHours": int(day["rain_hours"]),
            "sunHours": int(day["sun_hours"]),
            "hours": int(day["hours"]),
            "wet": wet,
            "briefShower": wet and day["rain_hours"] <= 2,
            "changeable": wet and 3 <= day["rain_hours"] <= 5,
            "rainy": wet and day["rain_hours"] >= 6,
            "heavy": day["precip_mm"] >= 10,
        })
    return result


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    DAILY.mkdir(parents=True, exist_ok=True)
    points: dict[str, list[str]] = defaultdict(list)
    try:
        resolved_points = json.loads(RESOLVED_POINTS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        resolved_points = {}
    coords = coordinates()
    for iata, (lat, lng) in coords.items():
        points[f"{lat:.3f},{lng:.3f}"].append(iata)
    MANIFEST.write_text(json.dumps({key: value for key, value in points.items()}, indent=2), encoding="utf-8")
    client = cdsapi.Client()
    for index, (point, iatas) in enumerate(points.items(), 1):
        lat, lng = map(float, point.split(","))
        key = coord_key(lat, lng)
        daily_path = DAILY / f"{key}.json"
        if daily_file_complete(daily_path):
            print(f"[{index}/{len(points)}] {'+'.join(iatas)} already reduced")
            continue
        raw_path = RAW / f"{key}.download"
        if not raw_path.exists():
            print(f"[{index}/{len(points)}] downloading {'+'.join(iatas)} {point}")
            client.retrieve(LAND_DATASET, request_for(lat, lng), str(raw_path))
        rows = reduce_download(raw_path)
        resolved_lat, resolved_lng = lat, lng
        source_dataset = LAND_DATASET
        if len(rows) < MIN_DAILY_ROWS:
            nearest = None
            print(f"[{index}/{len(points)}] probing nearest land cell for {'+'.join(iatas)}")
            for candidate_lat, candidate_lng in nearby_grid_locations(lat, lng)[:LAND_PROBE_LIMIT]:
                candidate_key = coord_key(candidate_lat, candidate_lng)
                probe_path = RAW / f"{key}.land-probe-{candidate_key}"
                if not probe_path.exists():
                    client.retrieve(
                        LAND_DATASET,
                        probe_request_for(candidate_lat, candidate_lng),
                        str(probe_path),
                    )
                nearest = nearest_land_location(probe_path, lat, lng)
                if nearest is not None:
                    break
            if nearest is not None:
                resolved_lat, resolved_lng = nearest
                land_raw_path = RAW / f"{key}.land.download"
                if not land_raw_path.exists():
                    print(
                        f"[{index}/{len(points)}] downloading nearest land cell "
                        f"{resolved_lat:.3f},{resolved_lng:.3f} for {'+'.join(iatas)}"
                    )
                    client.retrieve(
                        LAND_DATASET,
                        request_for(resolved_lat, resolved_lng),
                        str(land_raw_path),
                    )
                rows = reduce_download(land_raw_path)
            else:
                source_dataset = GLOBAL_DATASET
                global_raw_path = RAW / f"{key}.era5.download"
                if not global_raw_path.exists():
                    print(
                        f"[{index}/{len(points)}] no nearby ERA5-Land cell; "
                        f"downloading global ERA5 for {'+'.join(iatas)}"
                    )
                    client.retrieve(
                        GLOBAL_DATASET,
                        request_for(lat, lng),
                        str(global_raw_path),
                    )
                rows = reduce_download(global_raw_path)
        if len(rows) < MIN_DAILY_ROWS:
            raise RuntimeError(
                f"Incomplete ERA5-Land series for {'+'.join(iatas)}: {len(rows)} daily rows"
            )
        daily_path.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")
        resolved_points[key] = {
            "iata": iatas,
            "dataset": source_dataset,
            "requested": {"latitude": lat, "longitude": lng},
            "resolved": {"latitude": resolved_lat, "longitude": resolved_lng},
        }
        RESOLVED_POINTS.write_text(json.dumps(resolved_points, indent=2), encoding="utf-8")
        print(f"[{index}/{len(points)}] {'+'.join(iatas)} -> {len(rows)} daily rows")


if __name__ == "__main__":
    main()
