"""Integration checks for the LSTM candidate in the existing forecasting pipeline."""

import os
import tempfile
import unittest
from unittest.mock import patch

import joblib
import numpy as np
import pandas as pd

from models import LSTMWrapper
from pipeline import ForecastingPipeline


class LSTMIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.csv_path = os.path.join(self.temp.name, "weekly.csv")
        dates = pd.date_range("2020-01-03", periods=72, freq="W-FRI")
        values = 100 + np.arange(72) * .2 + 8 * np.sin(np.arange(72) * 2 * np.pi / 13)
        pd.DataFrame({"date": dates, "sales": values}).to_csv(self.csv_path, index=False)

    def pipeline(self, name, selected_models):
        return ForecastingPipeline(
            file_path=self.csv_path, date_column="date", target_column="sales",
            frequency="W-FRI", user_id="test", job_id=name, horizon=12,
            selected_models=selected_models, output_dir=os.path.join(self.temp.name, name, "output"),
            models_dir=os.path.join(self.temp.name, name, "models"))

    def test_chronological_windows_and_training_only_scaler(self):
        p = self.pipeline("selected", ["LSTM"])
        p.step1_load()
        p.step2_validate()
        self.assertTrue(p.step3_check_eligibility()["LSTM"]["eligible"])
        p.step5_split()
        self.assertLess(p.train_df.date.max(), p.holdout_df.date.min())
        training_mean = float(p.train_df.sales.mean())
        p.holdout_df.loc[:, "sales"] = 1000000.0
        results = p.step6_train_and_evaluate()
        lstm = next(row for row in results if row["model_name"] == "LSTM")
        self.assertEqual(lstm["status"], "ok")
        self.assertEqual(len(p.holdout_predictions["LSTM"]), len(p.holdout_df))
        self.assertAlmostEqual(lstm["model_instance"].scaler_mean, training_mean)
        self.assertNotAlmostEqual(lstm["model_instance"].scaler_mean, float(p.df.sales.mean()))
        self.assertTrue(all(lstm[metric] is not None for metric in ("mae", "rmse", "smape", "mape", "mase")))
        x, y = LSTMWrapper._make_sequences(np.arange(36, dtype=np.float32), 24)
        self.assertEqual(x.shape, (12, 24, 1))
        self.assertEqual(float(x[0, -1, 0]), 23.0)
        self.assertEqual(float(y[0, 0]), 24.0)
        self.assertEqual(float(x[1, 0, 0]), 1.0)

    def test_unselected_lstm_is_skipped(self):
        p = self.pipeline("unselected", [])
        report = p.run()
        lstm = next(row for row in report["model_leaderboard"] if row["model_name"] == "LSTM")
        self.assertEqual(lstm["status"], "skipped")
        self.assertNotIn("LSTM", p.holdout_predictions)
        self.assertEqual(report["winner_model"], "Seasonal Naive")

    def test_lstm_failure_is_isolated(self):
        p = self.pipeline("failure", ["LSTM"])
        with patch("pipeline.LSTMWrapper.fit", side_effect=RuntimeError("deliberate LSTM failure")):
            report = p.run()
        lstm = next(row for row in report["model_leaderboard"] if row["model_name"] == "LSTM")
        self.assertEqual(lstm["status"], "failed")
        self.assertIn("deliberate LSTM failure", lstm["skip_reason"])
        self.assertEqual(report["winner_model"], "Seasonal Naive")

    def test_lstm_winner_refits_and_exports(self):
        p = self.pipeline("winner", ["LSTM"])
        p.step1_load()
        p.step2_validate()
        p.step3_check_eligibility()
        p.step4_feature_engineering_info()
        p.step5_split()
        p.step6_train_and_evaluate()
        for row in p.model_results:
            if row["model_name"] == "LSTM":
                row["rmse"] = 0.0
        p.step8_select_winner()
        self.assertEqual(p.winner_model_name, "LSTM")
        future = p.step9_refit_and_forecast()
        self.assertEqual(len(future), 12)
        self.assertTrue(np.isfinite(future["forecast"]).all())
        self.assertAlmostEqual(p.winner_model_obj.scaler_mean, float(p.df.sales.mean()))
        p.step10_export()
        artifact = joblib.load(os.path.join(p.models_dir, "model.joblib"))
        self.assertEqual(artifact["model_name"], "LSTM")
        self.assertIn("lstm.weight_ih_l0", artifact["state_dict"])


if __name__ == "__main__":
    unittest.main()
