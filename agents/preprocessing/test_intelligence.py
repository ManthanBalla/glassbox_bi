"""Scenario checks for the preprocessing handoff and compact BI diagnostics."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

from pipeline import PreprocessingPipeline
from intelligence import detect_roles


class IntelligenceScenarios(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def run_case(self, frame, config=None, excel=False):
        source = os.path.join(self.tmp.name, 'input.xlsx' if excel else 'input.csv')
        if excel:
            frame.to_excel(source, index=False)
        else:
            frame.to_csv(source, index=False)
        output = os.path.join(self.tmp.name, 'output')
        result = PreprocessingPipeline(source, 'test', 'test', config or {'date_column': 'date', 'target_column': 'quantity', 'frequency': 'D'}).run_pipeline(output)
        with open(os.path.join(output, 'report.json'), encoding='utf-8') as handle:
            report = json.load(handle)
        return result, report, output

    def test_clean_csv_and_excel_contract(self):
        dates = pd.date_range('2024-01-01', periods=60)
        frame = pd.DataFrame({'date': dates, 'quantity': np.arange(60) + 10, 'store': ['North', 'South'] * 30})
        for excel in (False, True):
            with self.subTest(excel=excel):
                result, report, output = self.run_case(frame, excel=excel)
                self.assertTrue(result['success'])
                self.assertEqual(report['data_contract']['observations'], 60)
                with open(os.path.join(output, 'progress.json'), encoding='utf-8') as progress_file:
                    self.assertEqual(json.load(progress_file)['stage'], 'complete')
                self.assertIn('store', report['data_contract']['business_dimensions'])
                for name in ('cleaned_data.csv', 'schema.json', 'data_quality.json', 'forecast_readiness.json', 'forecastability.json', 'transformation_log.json', 'data_contract.json', 'preprocessing_metadata.json', 'evaluation_source.csv'):
                    self.assertTrue(os.path.isfile(os.path.join(output, name)), name)

    def test_gaps_duplicates_missing_outlier_and_sparse_column(self):
        dates = list(pd.date_range('2024-01-01', periods=61))
        dates.pop(10)
        frame = pd.DataFrame({'date': dates, 'quantity': [100 + (i % 5) for i in range(60)], 'store': ['A', 'B'] * 30, 'sparse': [None] * 50 + ['x'] * 10})
        frame.loc[4, 'quantity'] = np.nan
        frame.loc[35, 'quantity'] = 900
        frame = pd.concat([frame, pd.DataFrame([{'date': dates[0], 'quantity': 7, 'store': 'C', 'sparse': None}])], ignore_index=True)
        result, report, output = self.run_case(frame)
        cleaned = pd.read_csv(result['cleaned_csv_path'])
        evaluation = pd.read_csv(os.path.join(output, 'evaluation_source.csv'))
        self.assertGreater(report['time_health']['missing_periods'], 0)
        self.assertGreater(report['time_health']['duplicate_dates'], 0)
        self.assertNotIn('sparse', cleaned)
        self.assertIn('quantity_outlier', cleaned)
        self.assertGreater(report['comparison']['outliers']['flagged'], 0)
        self.assertEqual(float(cleaned['quantity'].max()), 900.0)
        self.assertTrue(evaluation['quantity'].isna().any())
        self.assertEqual(report['comparison']['missing_values']['after'], 0)
        self.assertIsInstance(report['audit_log'], list)

    def test_invalid_dates_small_and_constant(self):
        invalid = pd.DataFrame({'date': ['2024-01-01', 'bad-date', '2024-01-03'], 'quantity': [10, 20, 30]})
        _, report, _ = self.run_case(invalid)
        self.assertEqual(report['comparison']['invalid_dates']['before'], 1)
        self.assertEqual(report['comparison']['rows']['after'], 3)  # one invalid row removed, one gap inserted
        small = pd.DataFrame({'date': pd.date_range('2024-01-01', periods=5), 'quantity': [4] * 5})
        _, report, _ = self.run_case(small)
        self.assertEqual(report['overall_status'], 'FAIL')
        self.assertEqual(report['forecastability']['variation'], 'Insufficient')

    def test_no_numeric_target_has_actionable_error(self):
        frame = pd.DataFrame({'date': pd.date_range('2024-01-01', periods=3), 'quantity': ['a', 'b', 'c']})
        with self.assertRaisesRegex(ValueError, 'no usable numeric values'):
            self.run_case(frame)

    def test_forward_fill_remains_available_as_advanced_choice(self):
        frame = pd.DataFrame({'date': pd.date_range('2024-01-01', periods=5), 'quantity': [10, np.nan, 30, 40, 50]})
        config = {'date_column': 'date', 'target_column': 'quantity', 'frequency': 'D', 'imputation_strategy': 'forward_fill'}
        result, report, _ = self.run_case(frame, config=config)
        cleaned = pd.read_csv(result['cleaned_csv_path'])
        self.assertEqual(cleaned['quantity'].iloc[1], 10)
        self.assertEqual(report['transformation_recipe']['imputation_strategy'], 'forward_fill')

    def test_id_column_is_not_high_confidence_target(self):
        frame = pd.DataFrame({'transaction_date': pd.date_range('2024-01-01', periods=60).astype(str), 'customer_id': np.arange(1, 61)})
        roles = detect_roles(frame)
        self.assertLess(roles['target_candidates'][0]['confidence'], 35)

    def test_fixed_monthly_frequency_aggregates_daily_rows(self):
        frame = pd.DataFrame({'date': pd.date_range('2024-01-02', periods=60), 'quantity': [2] * 60})
        config = {'date_column': 'date', 'target_column': 'quantity', 'frequency': 'monthly', 'duplicate_aggregation': 'sum'}
        result, report, output = self.run_case(frame, config=config)
        cleaned = pd.read_csv(result['cleaned_csv_path'])
        evaluation = pd.read_csv(os.path.join(output, 'evaluation_source.csv'))
        self.assertEqual(result['frequency'], 'MS')
        self.assertEqual(len(cleaned), 3)
        self.assertEqual(cleaned['quantity'].sum(), 120)
        self.assertEqual(evaluation['quantity'].sum(), 120)
        self.assertEqual(report['time_health']['expected_observations'], 3)

    def test_forecasting_split_uses_unfilled_holdout(self):
        dates = pd.date_range('2024-01-01', periods=60)
        frame = pd.DataFrame({'date': dates, 'quantity': np.arange(60, dtype=float) + 10})
        frame.loc[55, 'quantity'] = np.nan
        result, prep_report, output = self.run_case(frame)
        forecast_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'forecasting'))
        sys.path.insert(0, forecast_dir)
        spec = importlib.util.spec_from_file_location('forecasting_pipeline_test', os.path.join(forecast_dir, 'pipeline.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        forecast = module.ForecastingPipeline(result['cleaned_csv_path'], 'date', 'quantity', 'D', 'test', 'forecast', horizon=12, evaluation_file_path=os.path.join(output, 'evaluation_source.csv'))
        forecast.step1_load()
        forecast.step2_validate()
        train, holdout = forecast.step5_split()
        self.assertFalse(train['quantity'].isna().any())
        self.assertTrue(holdout['quantity'].isna().any())
        self.assertIn('training dates only', forecast.evaluation_note)
        full_run = module.ForecastingPipeline(result['cleaned_csv_path'], 'date', 'quantity', 'D', 'test', 'forecast_run', horizon=12, selected_models=['Seasonal Naive'], evaluation_file_path=os.path.join(output, 'evaluation_source.csv'), preprocessing_contract=prep_report['data_contract'], output_dir=os.path.join(self.tmp.name, 'forecasts'), models_dir=os.path.join(self.tmp.name, 'models'))
        report = full_run.run()
        self.assertEqual(report['winner_model'], 'Seasonal Naive')
        self.assertEqual(report['horizon'], 12)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, 'forecasts', 'forecast.csv')))
        self.assertIn('training dates only', report['evaluation_preprocessing'])
        self.assertEqual(report['preprocessing_contract']['target_column'], 'quantity')


if __name__ == '__main__':
    unittest.main()
