"""
Comprehensive Unit Tests for Forecasting Agent Pipeline, Metrics, and Feature Engineering.
Validates:
- Time-series integrity validation (length, constant variance, nulls)
- Model eligibility rules and reason logs
- Chronological split without data leakage
- Feature engineering strictly backward-looking
- Metric calculations (MAE, RMSE, sMAPE, MASE, zero-actual MAPE)
- Model ranking and selection logic
"""

import unittest
import os
import tempfile
import numpy as np
import pandas as pd

from metrics import (
    calculate_mae,
    calculate_rmse,
    calculate_mape,
    calculate_smape,
    calculate_mase,
    evaluate_forecast
)
from models import (
    SeasonalNaiveWrapper,
    ETSWrapper,
    ARIMAWrapper,
    ProphetWrapper,
    LightGBMWrapper,
    ThetaWrapper
)
from pipeline import ForecastingPipeline


class TestForecastingAgent(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()

        # Create standard synthetic monthly dataset (60 periods, linear trend + seasonality)
        dates = pd.date_range("2020-01-01", periods=60, freq="MS")
        trend = np.linspace(100, 250, 60)
        seasonality = 20 * np.sin(np.arange(60) * 2 * np.pi / 12)
        noise = np.random.normal(0, 3, 60)
        values = trend + seasonality + noise

        self.synth_df = pd.DataFrame({
            "order_date": dates,
            "revenue": values
        })
        self.csv_path = os.path.join(self.temp_dir.name, "cleaned_series.csv")
        self.synth_df.to_csv(self.csv_path, index=False)

    def tearDown(self):
        self.temp_dir.cleanup()

    # -------------------------------------------------------------------------
    # 1. METRICS SUITE TESTS
    # -------------------------------------------------------------------------
    def test_metrics_calculation(self):
        actual = np.array([100.0, 110.0, 120.0, 130.0])
        predicted = np.array([105.0, 108.0, 122.0, 125.0])
        train_series = np.array([70.0, 80.0, 90.0, 100.0])

        mae = calculate_mae(actual, predicted)
        self.assertAlmostEqual(mae, 3.5, places=2)

        rmse = calculate_rmse(actual, predicted)
        self.assertAlmostEqual(rmse, 3.8079, places=2)

        smape = calculate_smape(actual, predicted)
        self.assertTrue(0 < smape < 100)

        # Zero actual MAPE handling: returns None without raising ZeroDivisionError
        actual_with_zero = np.array([0.0, 10.0, 20.0])
        pred_with_zero = np.array([1.0, 10.0, 20.0])
        mape_zero = calculate_mape(actual_with_zero, pred_with_zero)
        self.assertIsNone(mape_zero)

        # Non-zero MAPE
        mape_clean = calculate_mape(actual, predicted)
        self.assertIsNotNone(mape_clean)
        self.assertTrue(mape_clean > 0)

        # MASE
        mase = calculate_mase(actual, predicted, train_series, seasonal_period=1)
        self.assertTrue(mase > 0)

    # -------------------------------------------------------------------------
    # 2. TIME-SERIES VALIDATION TESTS
    # -------------------------------------------------------------------------
    def test_validation_insufficient_rows(self):
        short_df = self.synth_df.iloc[:20].copy()
        short_csv = os.path.join(self.temp_dir.name, "short.csv")
        short_df.to_csv(short_csv, index=False)

        pipeline = ForecastingPipeline(
            file_path=short_csv,
            date_column="order_date",
            target_column="revenue",
            frequency="M",
            user_id="test",
            job_id="test_short"
        )
        pipeline.step1_load()
        with self.assertRaises(ValueError) as ctx:
            pipeline.step2_validate()
        self.assertIn("Minimum 24 observations required", str(ctx.exception))

    def test_validation_constant_target(self):
        const_df = self.synth_df.copy()
        const_df["revenue"] = 100.0  # constant
        const_csv = os.path.join(self.temp_dir.name, "const.csv")
        const_df.to_csv(const_csv, index=False)

        pipeline = ForecastingPipeline(
            file_path=const_csv,
            date_column="order_date",
            target_column="revenue",
            frequency="M",
            user_id="test",
            job_id="test_const"
        )
        pipeline.step1_load()
        with self.assertRaises(ValueError) as ctx:
            pipeline.step2_validate()
        self.assertIn("constant with zero variance", str(ctx.exception))

    # -------------------------------------------------------------------------
    # 3. MODEL ELIGIBILITY RULES
    # -------------------------------------------------------------------------
    def test_eligibility_rules(self):
        # 35-row series: Prophet eligible (>= 30, but check seasonal cycles), LightGBM skipped (< 50)
        mid_df = self.synth_df.iloc[:35].copy()
        mid_csv = os.path.join(self.temp_dir.name, "mid.csv")
        mid_df.to_csv(mid_csv, index=False)

        pipeline = ForecastingPipeline(
            file_path=mid_csv,
            date_column="order_date",
            target_column="revenue",
            frequency="M",
            user_id="test",
            job_id="test_elig"
        )
        pipeline.step1_load()
        pipeline.step2_validate()
        elig = pipeline.step3_check_eligibility()

        self.assertTrue(elig["Seasonal Naive"]["eligible"])
        self.assertTrue(elig["ETS (Exponential Smoothing)"]["eligible"])
        self.assertTrue(elig["ARIMA / SARIMA"]["eligible"])
        # LightGBM must be skipped when rows < 50
        self.assertFalse(elig["LightGBM"]["eligible"])
        self.assertIn("at least 50 observations", elig["LightGBM"]["reason"])

    # -------------------------------------------------------------------------
    # 4. CHRONOLOGICAL SPLIT & NO LEAKAGE
    # -------------------------------------------------------------------------
    def test_chronological_split_no_leakage(self):
        pipeline = ForecastingPipeline(
            file_path=self.csv_path,
            date_column="order_date",
            target_column="revenue",
            frequency="M",
            user_id="test",
            job_id="test_split",
            horizon=6,
            holdout_percent=0.20
        )
        pipeline.step1_load()
        pipeline.step2_validate()
        train_df, holdout_df = pipeline.step5_split()

        self.assertEqual(len(train_df) + len(holdout_df), len(self.synth_df))
        self.assertGreaterEqual(len(holdout_df), 3)

        # Confirm strictly chronological: train max date strictly before holdout min date
        max_train_date = train_df["order_date"].max()
        min_holdout_date = holdout_df["order_date"].min()
        self.assertLess(max_train_date, min_holdout_date)

    # -------------------------------------------------------------------------
    # 5. LIGHTGBM FEATURE ENGINEERING BACKWARD-LOOKING TEST
    # -------------------------------------------------------------------------
    def test_lightgbm_features_backward_looking(self):
        lgb_model = LightGBMWrapper()
        y = np.arange(10, 70, dtype=float)
        dates = pd.date_range("2020-01-01", periods=60, freq="D")
        m = 7

        X, Y = lgb_model._create_feature_matrix(y, pd.Series(dates), m)

        # For the first row created at index i = max(3, 7) = 7:
        # lag_1 must be y[6], lag_2 must be y[5], lag_3 must be y[4], lag_m must be y[0]
        first_row = X.iloc[0]
        self.assertEqual(first_row["lag_1"], y[6])
        self.assertEqual(first_row["lag_2"], y[5])
        self.assertEqual(first_row["lag_3"], y[4])
        self.assertEqual(first_row["lag_m"], y[0])

        # Target must be y[7]
        self.assertEqual(Y[0], y[7])

        # roll_mean_3 must be mean of y[4:7] (indices 4, 5, 6)
        expected_roll = float(np.mean(y[4:7]))
        self.assertAlmostEqual(first_row["roll_mean_3"], expected_roll, places=4)

    # -------------------------------------------------------------------------
    # 6. FULL PIPELINE RUN & MODEL SELECTION
    # -------------------------------------------------------------------------
    def test_full_pipeline_run(self):
        out_dir = os.path.join(self.temp_dir.name, "out")
        models_dir = os.path.join(self.temp_dir.name, "mod")

        pipeline = ForecastingPipeline(
            file_path=self.csv_path,
            date_column="order_date",
            target_column="revenue",
            frequency="M",
            user_id="test_user",
            job_id="test_run_1",
            horizon=6,
            ranking_metric="rmse",
            output_dir=out_dir,
            models_dir=models_dir
        )

        report = pipeline.run()

        self.assertIn("winner_model", report)
        self.assertIsNotNone(report["winner_model"])
        self.assertEqual(len(report["model_leaderboard"]), 7)

        # Check export files exist
        self.assertTrue(os.path.exists(os.path.join(out_dir, "forecast.csv")))
        self.assertTrue(os.path.exists(os.path.join(out_dir, "holdout_predictions.csv")))
        self.assertTrue(os.path.exists(os.path.join(out_dir, "report.json")))
        self.assertTrue(os.path.exists(os.path.join(models_dir, "model.joblib")))
        self.assertTrue(os.path.exists(os.path.join(models_dir, "metadata.json")))

        # Check forecast.csv structure
        f_df = pd.read_csv(os.path.join(out_dir, "forecast.csv"))
        self.assertEqual(len(f_df), 6)
        for col in ["date", "forecast", "lower_80", "upper_80", "lower_95", "upper_95"]:
            self.assertIn(col, f_df.columns)
            self.assertFalse(f_df[col].isnull().any())


if __name__ == "__main__":
    unittest.main()
