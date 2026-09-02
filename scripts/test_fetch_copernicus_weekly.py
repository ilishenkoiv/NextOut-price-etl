from __future__ import annotations

import csv
import importlib.util
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path


SCRIPT = Path(__file__).with_name("fetch-copernicus-weekly.py")
SPEC = importlib.util.spec_from_file_location("fetch_copernicus_weekly", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FetchCopernicusWeeklyTests(unittest.TestCase):
    def test_request_is_bounded_to_baseline_and_uses_point_location(self) -> None:
        request = MODULE.request_for(52.52, 13.405)

        self.assertEqual(request["location"], {"latitude": 52.52, "longitude": 13.405})
        self.assertEqual(request["date"], ["1991-01-01/2020-12-31"])
        self.assertNotIn("area", request)

        probe = MODULE.probe_request_for(43.5, 16.5)
        self.assertEqual(probe["location"], {"latitude": 43.5, "longitude": 16.5})
        self.assertEqual(probe["date"], ["2020-01-01/2020-01-02"])
        self.assertNotIn("area", probe)

    def test_nearby_grid_locations_are_nearest_first_and_skip_requested_cell(self) -> None:
        points = MODULE.nearby_grid_locations(43.508, 16.44)

        self.assertNotIn((43.5, 16.4), points)
        self.assertEqual(points[0], (43.5, 16.5))
        self.assertEqual(MODULE.LAND_PROBE_LIMIT, 4)
        self.assertEqual(MODULE.GLOBAL_DATASET, "reanalysis-era5-single-levels-timeseries")

    def test_deaccumulated_hourly_rain_is_not_subtracted_twice(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.csv"
            start = datetime(1991, 1, 1)
            with path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=[
                        "valid_time",
                        "2m_temperature",
                        "total_precipitation",
                        "surface_solar_radiation_downwards",
                    ],
                )
                writer.writeheader()
                for hour in range(24):
                    writer.writerow(
                        {
                            "valid_time": (start + timedelta(hours=hour)).isoformat(),
                            "2m_temperature": "280",
                            "total_precipitation": "0.001" if hour in (4, 5) else "0",
                            "surface_solar_radiation_downwards": "720000" if hour in (12, 13) else "0",
                        }
                    )

            rows = MODULE.reduce_download(path)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["precipMm"], 2.0)
        self.assertEqual(rows[0]["rainHours"], 2)
        self.assertEqual(rows[0]["sunHours"], 2)
        self.assertTrue(rows[0]["briefShower"])

    def test_nearest_land_location_ignores_empty_sea_cells(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "probe.csv"
            with path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["valid_time", "t2m", "latitude", "longitude"],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "valid_time": "2020-01-01 00:00:00",
                        "t2m": "",
                        "latitude": "43.5",
                        "longitude": "16.4",
                    }
                )
                writer.writerow(
                    {
                        "valid_time": "2020-01-01 00:00:00",
                        "t2m": "280",
                        "latitude": "43.5",
                        "longitude": "16.5",
                    }
                )
                writer.writerow(
                    {
                        "valid_time": "2020-01-01 00:00:00",
                        "t2m": "279",
                        "latitude": "43.7",
                        "longitude": "16.4",
                    }
                )

            point = MODULE.nearest_land_location(path, 43.508, 16.44)

        self.assertEqual(point, (43.5, 16.5))


if __name__ == "__main__":
    unittest.main()
