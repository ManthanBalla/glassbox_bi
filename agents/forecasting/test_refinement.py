"""Contract checks for the compact forecasting workflow and its exports."""

import csv
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from pipeline import ForecastingPipeline


class ForecastRefinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = os.path.join(self.temp.name, "cleaned.csv")
        dates = pd.date_range("2022-01-01", periods=70, freq="D")
        pd.DataFrame({"date": dates, "quantity": 100 + np.arange(70) * .3 + np.sin(np.arange(70) * 2 * np.pi / 7) * 8}).to_csv(self.source, index=False)

    def pipeline(self, name="run", **kwargs):
        return ForecastingPipeline(
            file_path=self.source, date_column="date", target_column="quantity",
            frequency="D", user_id="test", job_id=name,
            output_dir=os.path.join(self.temp.name, name, "output"),
            models_dir=os.path.join(self.temp.name, name, "models"), **kwargs
        )

    def test_selection_keeps_baseline_and_skips_unselected_candidates(self):
        pipeline = self.pipeline(selected_models=["ETS (Exponential Smoothing)"])
        pipeline.step1_load()
        pipeline.step2_validate()
        decisions = pipeline.step3_check_eligibility()
        self.assertTrue(decisions["Seasonal Naive"]["eligible"])
        self.assertTrue(decisions["ETS (Exponential Smoothing)"]["eligible"])
        self.assertFalse(decisions["LightGBM"]["eligible"])
        self.assertIn("not selected", decisions["LightGBM"]["reason"])

    def test_95_only_changes_export_and_handoff(self):
        pipeline = self.pipeline(selected_models=[], confidence_levels=[0.95], horizon=8, ranking_metric="mae")
        report = pipeline.run()
        with open(os.path.join(pipeline.output_dir, "forecast.csv"), newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(list(rows[0]), ["date", "forecast", "lower_95", "upper_95"])
        self.assertEqual(len(rows), 8)
        self.assertEqual(report["winner_model"], "Seasonal Naive")
        self.assertEqual(report["confidence_levels"], [0.95])
        self.assertEqual(report["ranking_metric"], "mae")
        self.assertEqual(report["handoff"]["prediction_intervals"], [0.95])
        with open(os.path.join(pipeline.output_dir, "forecast_metadata.json"), encoding="utf-8") as handle:
            metadata = json.load(handle)
        self.assertEqual(metadata["prediction_levels"], [0.95])
        self.assertEqual(metadata["selected_models"], ["Seasonal Naive"])

    def test_horizon_adjustment_is_recorded(self):
        pipeline = self.pipeline(selected_models=[], horizon=100)
        report = pipeline.run()
        self.assertEqual(report["requested_horizon"], 100)
        self.assertEqual(report["horizon"], 35)
        self.assertTrue(pipeline.validation_result["horizon_adjusted"])
        self.assertTrue(any("Clamping horizon" in warning for warning in report["warnings"]))

    def test_one_model_failure_does_not_stop_baseline_forecast(self):
        pipeline = self.pipeline(selected_models=["ETS (Exponential Smoothing)"])
        with patch("pipeline.ETSWrapper.fit", side_effect=RuntimeError("deliberate fit failure")):
            report = pipeline.run()
        results = {row["model_name"]: row for row in report["model_leaderboard"]}
        self.assertEqual(results["ETS (Exponential Smoothing)"]["status"], "failed")
        self.assertEqual(report["winner_model"], "Seasonal Naive")
        self.assertTrue(os.path.exists(os.path.join(pipeline.output_dir, "forecast.csv")))

    def test_precheck_warns_on_missing_periods(self):
        frame = pd.read_csv(self.source).drop(index=[10, 11])
        frame.to_csv(self.source, index=False)
        pipeline = self.pipeline()
        pipeline.step1_load()
        validation = pipeline.step2_validate()
        self.assertEqual(validation["status"], "warn")
        self.assertEqual(validation["checks"]["missing_periods"], 2)

    def test_frequency_cycles_and_ranking_metrics(self):
        for frequency, expected in [("D", 7), ("W", 52), ("M", 12)]:
            pipeline = self.pipeline(name=frequency, selected_models=[], ranking_metric="smape")
            pipeline.frequency = "MS" if frequency == "M" else frequency
            pipeline.step1_load()
            pipeline.step2_validate()
            self.assertEqual(pipeline.seasonal_period, expected)

        pipeline = self.pipeline(name="ranking", selected_models=["ETS (Exponential Smoothing)"], ranking_metric="mae")
        pipeline.model_results = [
            {"model_name": "Seasonal Naive", "status": "ok", "mae": 12.0, "rmse": 9.0, "smape": 10.0, "mase": 1.2, "beats_baseline": False},
            {"model_name": "ETS (Exponential Smoothing)", "status": "ok", "mae": 8.0, "rmse": 11.0, "smape": 12.0, "mase": 0.8, "beats_baseline": True},
        ]
        winner = pipeline.step8_select_winner()
        self.assertEqual(winner["model_name"], "ETS (Exponential Smoothing)")

    def test_invalid_dates_are_rejected(self):
        frame = pd.read_csv(self.source)
        frame.loc[3, "date"] = "not-a-date"
        frame.to_csv(self.source, index=False)
        with self.assertRaisesRegex(ValueError, "invalid dates"):
            self.pipeline().step1_load()


if __name__ == "__main__":
    unittest.main()
