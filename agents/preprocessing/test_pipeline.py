"""
Unit tests for the GlassBox-BI Data Preprocessing Agent pipeline.
Validates each transformation step on controlled sample datasets.
"""

import os
import shutil
import tempfile
import unittest
import pandas as pd
import numpy as np

from pipeline import PreprocessingPipeline, to_snake_case
from formulas import compute_data_quality_score, compute_forecast_readiness_score


class TestPreprocessingPipeline(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_snake_case_conversion(self):
        self.assertEqual(to_snake_case("Order Date"), "order_date")
        self.assertEqual(to_snake_case("Revenue ($)"), "revenue")
        self.assertEqual(to_snake_case("Total-Sales_2024"), "total_sales_2024")
        self.assertEqual(to_snake_case("   Trim  Me   "), "trim_me")

    def test_standardize_types_and_placeholders(self):
        csv_path = os.path.join(self.test_dir, "test_dirty.csv")
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write('Date,Revenue,Discount Pct,Status\n')
            f.write('2024-01-01,"$1,200.50",10%,ACTIVE\n')
            f.write('2024-01-02,"$1,350.00",5%,N/A\n')
            f.write('2024-01-03,null,0%,ACTIVE\n')
            f.write('2024-01-04,"$1,500.00",-,null\n')

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df = pipeline.step1_load()
        df_clean = pipeline.step3_standardize(df)

        # Columns snake_case
        self.assertIn("date", df_clean.columns)
        self.assertIn("revenue", df_clean.columns)
        self.assertIn("discount_pct", df_clean.columns)

        # Currency and percent cleaned to numeric float
        self.assertTrue(pd.api.types.is_numeric_dtype(df_clean["revenue"]))
        self.assertEqual(df_clean["revenue"].iloc[0], 1200.50)

        # Placeholders converted to NaN
        self.assertTrue(pd.isna(df_clean["revenue"].iloc[2]))
        self.assertTrue(pd.isna(df_clean["status"].iloc[1]))

    def test_column_auto_detection(self):
        csv_path = os.path.join(self.test_dir, "test_detect.csv")
        dates = pd.date_range("2024-01-01", periods=40, freq="D")
        sales = np.random.normal(500, 50, 40)
        df = pd.DataFrame({
            "order_date": dates.strftime("%Y-%m-%d"),
            "daily_sales": sales,
            "region": ["North"] * 40
        })
        df.to_csv(csv_path, index=False)

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df_loaded = pipeline.step1_load()
        df_std = pipeline.step3_standardize(df_loaded)
        date_col, target_col = pipeline.step4_detect_columns(df_std)

        self.assertEqual(date_col, "order_date")
        self.assertEqual(target_col, "daily_sales")

    def test_duplicate_removal_and_timestamp_aggregation(self):
        csv_path = os.path.join(self.test_dir, "test_dups.csv")
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write("date,sales\n")
            f.write("2024-01-01,100\n")
            f.write("2024-01-01,100\n")  # Exact duplicate
            f.write("2024-01-02,200\n")
            f.write("2024-01-02,300\n")  # Duplicate timestamp

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df = pipeline.step1_load()
        df_dedup = pipeline.step5_duplicates(df, date_col="date", target_col="sales", agg_method="sum")

        # 2024-01-01 exact duplicate dropped -> 100
        # 2024-01-02 timestamp aggregated (sum: 200 + 300) -> 500
        self.assertEqual(len(df_dedup), 2)
        row_02 = df_dedup[df_dedup["date"] == pd.Timestamp("2024-01-02")]
        self.assertEqual(row_02["sales"].iloc[0], 500)

    def test_missing_values_time_series_interpolation(self):
        csv_path = os.path.join(self.test_dir, "test_missing.csv")
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write("date,sales,almost_all_empty\n")
            f.write("2024-01-01,100,null\n")
            f.write("2024-01-02,,null\n")  # Middle missing -> linear interpolation to 200
            f.write("2024-01-03,300,null\n")
            f.write("2024-01-04,400,test\n")

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df = pipeline.step1_load()
        df = pipeline.step3_standardize(df)
        df_imputed = pipeline.step6_missing_values(df, date_col="date", target_col="sales", drop_threshold_pct=60.0)

        # almost_all_empty has 75% missing -> dropped
        self.assertNotIn("almost_all_empty", df_imputed.columns)
        # sales middle missing interpolated: (100 + 300) / 2 = 200
        self.assertEqual(df_imputed["sales"].iloc[1], 200.0)
        self.assertEqual(df_imputed["sales"].isna().sum(), 0)

    def test_outlier_capping_winsorize(self):
        csv_path = os.path.join(self.test_dir, "test_outlier.csv")
        np.random.seed(42)
        normal_vals = list(np.random.normal(100, 5, 30))
        # Add extreme outlier
        normal_vals.append(99999.0)
        df = pd.DataFrame({"sales": normal_vals})
        df.to_csv(csv_path, index=False)

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df_loaded = pipeline.step1_load()
        df_capped = pipeline.step7_outliers(df_loaded, target_col="sales", method="iqr", action="cap")

        # Row must not be deleted
        self.assertEqual(len(df_capped), 31)
        # Outlier capped well below 99999
        self.assertLess(df_capped["sales"].max(), 200.0)

    def test_time_series_gap_alignment(self):
        csv_path = os.path.join(self.test_dir, "test_gaps.csv")
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write("date,sales\n")
            f.write("2024-01-01,100\n")
            f.write("2024-01-02,200\n")
            # Gap: 2024-01-03 missing
            f.write("2024-01-04,400\n")

        pipeline = PreprocessingPipeline(csv_path, "u1", "j1")
        df = pipeline.step1_load()
        df_aligned, freq = pipeline.step8_time_series_alignment(df, date_col="date", target_col="sales", frequency="D")

        # 3 rows + 1 inserted row for Jan 03 = 4 rows
        self.assertEqual(len(df_aligned), 4)
        # The interpolated value for Jan 03 should be 300
        row_03 = df_aligned[df_aligned["date"] == pd.Timestamp("2024-01-03")]
        self.assertEqual(len(row_03), 1)
        self.assertEqual(row_03["sales"].iloc[0], 300.0)

    def test_forecast_readiness_score(self):
        dates = pd.date_range("2024-01-01", periods=60, freq="D")
        sales = np.random.normal(500, 25, 60)
        df = pd.DataFrame({"date": dates, "sales": sales})

        res = compute_forecast_readiness_score(df, date_col="date", target_col="sales", frequency="D")
        self.assertGreaterEqual(res["readiness_score"], 85.0)
        self.assertEqual(res["overall_status"], "READY")

    def test_full_pipeline_run_on_messy_ecommerce(self):
        sample_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "samples", "messy_ecommerce.csv"))
        self.assertTrue(os.path.exists(sample_path))

        out_dir = os.path.join(self.test_dir, "processed_run")
        pipeline = PreprocessingPipeline(
            file_path=sample_path,
            user_id="test_user",
            job_id="test_job_123",
            config={
                "date_column": "order_date",
                "target_column": "revenue",
                "frequency": "D",
                "outlier_action": "cap"
            }
        )
        result = pipeline.run_pipeline(output_dir=out_dir)

        self.assertTrue(result["success"])
        self.assertTrue(os.path.exists(result["cleaned_csv_path"]))
        self.assertTrue(os.path.exists(result["report_json_path"]))
        self.assertGreater(result["quality_score_after"], result["quality_score_before"])
        self.assertGreater(len(result["audit_log"]), 5)
        self.assertIn("checklist", result)

    def test_full_pipeline_run_on_clean_sales(self):
        sample_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "samples", "clean_sales.csv"))
        out_dir = os.path.join(self.test_dir, "processed_clean")
        pipeline = PreprocessingPipeline(sample_path, "u1", "j_clean", config={"date_column": "date", "target_column": "sales"})
        result = pipeline.run_pipeline(output_dir=out_dir)
        self.assertTrue(result["success"])
        self.assertGreaterEqual(result["readiness_score"], 80.0)
        self.assertEqual(result["rows_after"], 55)

    def test_full_pipeline_run_on_gap_demand(self):
        sample_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "samples", "gap_demand.csv"))
        out_dir = os.path.join(self.test_dir, "processed_gap")
        pipeline = PreprocessingPipeline(sample_path, "u1", "j_gap", config={"date_column": "timestamp", "target_column": "power_demand_mw", "frequency": "D"})
        result = pipeline.run_pipeline(output_dir=out_dir)
        self.assertTrue(result["success"])
        # Gap days should have been inserted and interpolated
        self.assertGreater(result["rows_after"], result["rows_before"])
        self.assertGreaterEqual(result["readiness_score"], 70.0)


if __name__ == "__main__":
    unittest.main()
