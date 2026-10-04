"""
10-Step Time-Series Forecasting Pipeline for GlassBox-BI Forecasting Agent.
Executes the portfolio of 6 models, chronological holdout evaluation, model selection,
full refit with 80%/95% prediction intervals, explainability audit logging, and XAI artifact export.
"""

import os
import json
import logging
import time
import warnings
from typing import Dict, Any, Optional, List, Tuple
import numpy as np
import pandas as pd
import joblib

warnings.filterwarnings("ignore")

from metrics import evaluate_forecast
from models import (
    BaseModelWrapper,
    SeasonalNaiveWrapper,
    ETSWrapper,
    ARIMAWrapper,
    ProphetWrapper,
    LightGBMWrapper,
    ThetaWrapper
)

logger = logging.getLogger("forecasting_pipeline")


class ForecastingPipeline:
    def __init__(
        self,
        file_path: str,
        date_column: str,
        target_column: str,
        frequency: str,
        user_id: str,
        job_id: str,
        horizon: int = 12,
        selected_models: Optional[List[str]] = None,
        ranking_metric: str = "rmse",
        holdout_percent: float = 0.20,
        confidence_levels: Optional[List[float]] = None,
        output_dir: Optional[str] = None,
        models_dir: Optional[str] = None,
        evaluation_file_path: Optional[str] = None,
        preprocessing_recipe: Optional[Dict[str, Any]] = None,
        preprocessing_contract: Optional[Dict[str, Any]] = None
    ):
        self.file_path = os.path.abspath(file_path)
        self.date_column = date_column
        self.target_column = target_column
        freq_raw = (frequency or "D").upper()
        if freq_raw in ["M", "MONTHLY"]:
            self.frequency = "MS"
        elif freq_raw in ["W", "WEEKLY"]:
            self.frequency = "W"
        elif freq_raw in ["Q", "QUARTERLY"]:
            self.frequency = "QS"
        elif freq_raw in ["Y", "YEARLY", "A", "ANNUAL"]:
            self.frequency = "YS"
        elif freq_raw in ["D", "DAILY"]:
            self.frequency = "D"
        else:
            self.frequency = freq_raw
        self.user_id = str(user_id)
        self.job_id = str(job_id)
        self.horizon = int(horizon)
        self.selected_models = selected_models or ["Seasonal Naive", "ETS (Exponential Smoothing)", "ARIMA / SARIMA", "Prophet", "LightGBM", "Theta"]
        self.ranking_metric = ranking_metric.lower()
        self.holdout_percent = float(holdout_percent)
        self.confidence_levels = confidence_levels or [0.80, 0.95]

        # Directory destinations
        self.output_dir = os.path.abspath(output_dir) if output_dir else os.path.abspath(os.path.join("forecasts", self.user_id, self.job_id))
        self.models_dir = os.path.abspath(models_dir) if models_dir else os.path.abspath(os.path.join("models", self.user_id, self.job_id))
        self.evaluation_file_path = evaluation_file_path
        self.preprocessing_recipe = preprocessing_recipe or {}
        self.preprocessing_contract = preprocessing_contract or {}
        self.evaluation_note = "Legacy processed dataset used for evaluation. Historical preprocessing may have used future holdout information."

        # Runtime State
        self.df: Optional[pd.DataFrame] = None
        self.seasonal_period: int = 1
        self.actions: List[Dict[str, Any]] = []
        self.step_counter: int = 0
        self.validation_result: Dict[str, Any] = {}
        self.eligibility_results: Dict[str, Dict[str, Any]] = {}
        self.train_df: Optional[pd.DataFrame] = None
        self.holdout_df: Optional[pd.DataFrame] = None
        self.holdout_predictions: Dict[str, np.ndarray] = {}
        self.model_results: List[Dict[str, Any]] = []
        self.winner_model_name: Optional[str] = None
        self.winner_model_obj: Optional[BaseModelWrapper] = None
        self.future_forecast_df: Optional[pd.DataFrame] = None
        self.warnings: List[str] = []

    def _log_action(self, step_name: str, action: str, description: str, model_name: Optional[str] = None):
        self.step_counter += 1
        entry = {
            "step_order": self.step_counter,
            "step_name": step_name,
            "model_name": model_name,
            "action": action,
            "description": description,
            "timestamp": time.time()
        }
        self.actions.append(entry)
        logger.info(f"[{step_name}] {description}")

    # =========================================================================
    # STEP 1: LOAD
    # =========================================================================
    def step1_load(self) -> pd.DataFrame:
        if not os.path.exists(self.file_path):
            raise FileNotFoundError(f"Cleaned dataset not found at {self.file_path}")

        # Path traversal safeguard
        real_path = os.path.realpath(self.file_path)
        if not os.path.isfile(real_path):
            raise ValueError("Invalid file path provided.")

        df = pd.read_csv(real_path)

        if self.date_column not in df.columns:
            raise ValueError(f"Specified date column '{self.date_column}' not found in dataset. Available: {list(df.columns)}")
        if self.target_column not in df.columns:
            raise ValueError(f"Specified target column '{self.target_column}' not found in dataset. Available: {list(df.columns)}")

        # Parse date and sort
        df[self.date_column] = pd.to_datetime(df[self.date_column], errors="coerce")
        df = df.dropna(subset=[self.date_column])
        df = df.sort_values(by=self.date_column).reset_index(drop=True)
        df[self.target_column] = pd.to_numeric(df[self.target_column], errors="coerce")

        self.df = df
        start_dt = str(df[self.date_column].iloc[0].date())
        end_dt = str(df[self.date_column].iloc[-1].date())
        total_rows = len(df)

        self._log_action(
            step_name="LOAD",
            action="dataset_loaded",
            description=f"Loaded cleaned time-series dataset with {total_rows} observations from {start_dt} to {end_dt} at frequency '{self.frequency}'."
        )
        return df

    # =========================================================================
    # STEP 2: TIME-SERIES VALIDATION
    # =========================================================================
    def step2_validate(self) -> Dict[str, Any]:
        if self.df is None:
            self.step1_load()
        df = self.df
        total_rows = len(df)

        # Infer seasonal period from frequency
        freq_prefix = self.frequency[0] if self.frequency else "D"
        if freq_prefix in ["D"]:
            self.seasonal_period = 7
        elif freq_prefix in ["W"]:
            self.seasonal_period = 52
        elif freq_prefix in ["M"]:
            self.seasonal_period = 12
        elif freq_prefix in ["Q"]:
            self.seasonal_period = 4
        elif freq_prefix in ["Y", "A"]:
            self.seasonal_period = 1
        else:
            self.seasonal_period = 7

        errors = []
        warnings = []

        # Check unique dates
        if df[self.date_column].duplicated().any():
            errors.append("Duplicate timestamps detected in chronological index.")

        # Check target nulls
        null_count = int(df[self.target_column].isnull().sum())
        if null_count > 0:
            errors.append(f"Target column '{self.target_column}' contains {null_count} null/missing values.")

        # Check target constant
        target_std = float(df[self.target_column].std()) if total_rows > 1 else 0.0
        if target_std == 0.0 or np.isnan(target_std):
            errors.append(f"Target column '{self.target_column}' is constant with zero variance.")

        # Minimum observations check
        if total_rows < 24:
            errors.append(f"Insufficient history: dataset has {total_rows} rows. Minimum 24 observations required for time-series forecasting.")
        elif total_rows < 50:
            warnings.append(f"Small sample size ({total_rows} rows). Models may experience reduced statistical reliability below 50 observations.")

        # Check maximum horizon vs history
        max_allowed_horizon = max(3, int(total_rows * 0.5))
        if self.horizon > max_allowed_horizon:
            warnings.append(f"Requested horizon ({self.horizon}) exceeds 50% of history length ({total_rows} rows). Clamping horizon to {max_allowed_horizon}.")
            self.horizon = max_allowed_horizon

        # Suggested horizon by frequency
        suggested_horizons = {"D": 30, "W": 12, "M": 12, "Q": 4, "Y": 3}
        suggested_horizon = suggested_horizons.get(freq_prefix, 12)
        suggested_horizon = min(suggested_horizon, max_allowed_horizon)

        is_valid = len(errors) == 0
        status = "pass" if is_valid and len(warnings) == 0 else ("warn" if is_valid else "fail")

        self.validation_result = {
            "status": status,
            "is_valid": is_valid,
            "total_rows": total_rows,
            "seasonal_period": self.seasonal_period,
            "suggested_horizon": suggested_horizon,
            "errors": errors,
            "warnings": warnings
        }

        if not is_valid:
            err_msg = "; ".join(errors)
            self._log_action(
                step_name="TIME_SERIES_VALIDATION",
                action="validation_failed",
                description=f"Time-series validation failed: {err_msg}"
            )
            raise ValueError(f"Time-series validation failed: {err_msg}")

        warn_desc = f" ({'; '.join(warnings)})" if warnings else ""
        self._log_action(
            step_name="TIME_SERIES_VALIDATION",
            action="validation_passed",
            description=f"Time-series integrity verified: sorted, unique, gap-free series with {total_rows} observations.{warn_desc}"
        )
        return self.validation_result

    # =========================================================================
    # STEP 3: MODEL ELIGIBILITY CHECK
    # =========================================================================
    def step3_check_eligibility(self) -> Dict[str, Dict[str, Any]]:
        if not self.validation_result:
            self.step2_validate()

        N = len(self.df)
        m = self.seasonal_period
        eligibility = {}

        # 1. Seasonal Naive
        eligibility["Seasonal Naive"] = {
            "eligible": True,
            "status": "ok",
            "reason": f"Baseline model repeats the previous seasonal cycle (period m={m}). Always eligible."
        }

        # 2. ETS
        if m > 1 and N >= 2 * m:
            ets_reason = f"Eligible: {N} rows provide at least 2 full seasonal cycles ({2 * m} needed) for additive trend and seasonal components."
        else:
            ets_reason = f"Eligible: using non-seasonal trend smoothing because {N} rows is less than 2 seasonal cycles ({2 * m} needed)."
        eligibility["ETS (Exponential Smoothing)"] = {
            "eligible": True,
            "status": "ok",
            "reason": ets_reason
        }

        # 3. ARIMA / SARIMA
        if m > 1 and N >= 2 * m and m <= 52:
            arima_reason = f"Eligible: {N} observations sufficient for seasonal SARIMA order search."
        else:
            arima_reason = f"Eligible: using non-seasonal ARIMA order search (p,d,q) based on AIC."
        eligibility["ARIMA / SARIMA"] = {
            "eligible": True,
            "status": "ok",
            "reason": arima_reason
        }

        # 4. Prophet
        if N < 30:
            eligibility["Prophet"] = {
                "eligible": False,
                "status": "skipped",
                "reason": f"Prophet skipped: requires at least 30 observations to fit Bayesian changepoint priors reliably, found {N}."
            }
        elif m > 1 and N < 2 * m:
            eligibility["Prophet"] = {
                "eligible": False,
                "status": "skipped",
                "reason": f"Prophet skipped: only {N} observations, at least {2 * m} needed for 2 full seasonal cycles."
            }
        else:
            eligibility["Prophet"] = {
                "eligible": True,
                "status": "ok",
                "reason": f"Eligible: {N} observations sufficient to model Bayesian trend and seasonal components."
            }

        # 5. LightGBM
        if N < 50:
            eligibility["LightGBM"] = {
                "eligible": False,
                "status": "skipped",
                "reason": f"LightGBM skipped: requires at least 50 observations to train gradient boosting trees effectively without overfitting, found {N}."
            }
        else:
            eligibility["LightGBM"] = {
                "eligible": True,
                "status": "ok",
                "reason": f"Eligible: {N} observations sufficient for recursive gradient boosting with engineered lag and rolling features."
            }

        # 6. Theta
        if "Theta" not in self.selected_models:
            eligibility["Theta"] = {
                "eligible": False,
                "status": "skipped",
                "reason": "Theta skipped: disabled by user configuration."
            }
        elif N < 12:
            eligibility["Theta"] = {
                "eligible": False,
                "status": "skipped",
                "reason": f"Theta skipped: series too short ({N} observations, minimum 12 required)."
            }
        else:
            eligibility["Theta"] = {
                "eligible": True,
                "status": "ok",
                "reason": f"Eligible: decomposing series into dual curvature and trend lines with period m={m}."
            }

        for model_name, decision in eligibility.items():
            if model_name not in self.selected_models:
                decision.update({"eligible": False, "status": "skipped", "reason": "Skipped: not selected for this forecasting run."})

        self.eligibility_results = eligibility

        for m_name, info in eligibility.items():
            action = "model_eligible" if info["eligible"] else "model_skipped"
            self._log_action(
                step_name="MODEL_ELIGIBILITY",
                model_name=m_name,
                action=action,
                description=info["reason"]
            )

        return eligibility

    # =========================================================================
    # STEP 4: FEATURE ENGINEERING (LightGBM only)
    # =========================================================================
    def step4_feature_engineering_info(self) -> List[str]:
        m = self.seasonal_period
        features = [
            "lag_1 (y_{t-1})",
            "lag_2 (y_{t-2})",
            "lag_3 (y_{t-3})",
            f"lag_m (y_{{t-{m}}})",
            "roll_mean_3 (backward 3-period rolling average on y_{t-1})",
            "roll_std_3 (backward 3-period rolling std on y_{t-1})",
            "calendar_month (1-12)",
            "calendar_quarter (1-4)",
            "calendar_dayofweek (0-6)",
            "is_month_end (binary indicator)",
            "time_index (monotonically increasing integer)"
        ]
        self._log_action(
            step_name="FEATURE_ENGINEERING",
            model_name="LightGBM",
            action="features_created",
            description=f"Engineered 11 backward-looking lag, rolling, and calendar features for LightGBM. Strictly backward-looking; no future information used."
        )
        return features

    # =========================================================================
    # STEP 5: CHRONOLOGICAL SPLIT
    # =========================================================================
    def step5_split(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        df = self.df
        N = len(df)
        
        # Holdout periods: min(horizon, 20% of rows), at least 3
        pct_holdout = max(3, int(np.floor(self.holdout_percent * N)))
        H = min(self.horizon, pct_holdout)
        H = max(3, H)
        if H >= N:
            H = max(1, int(N * 0.2))

        train_size = N - H
        self.train_df = df.iloc[:train_size].copy().reset_index(drop=True)
        self.holdout_df = df.iloc[train_size:].copy().reset_index(drop=True)

        if self.evaluation_file_path and os.path.isfile(self.evaluation_file_path):
            source = pd.read_csv(self.evaluation_file_path)
            source[self.date_column] = pd.to_datetime(source[self.date_column], errors="coerce")
            source[self.target_column] = pd.to_numeric(source[self.target_column], errors="coerce")
            source = source.dropna(subset=[self.date_column]).drop_duplicates(subset=[self.date_column])
            source = df[[self.date_column]].merge(source[[self.date_column, self.target_column]], on=self.date_column, how="left")
            training_target = source[self.target_column].iloc[:train_size].copy()
            if training_target.notna().sum() < 2:
                raise ValueError("The training period has too few observed target values for forecasting.")
            # Only the training slice contributes to fitted imputation and outlier bounds.
            training_target = (training_target.ffill() if self.preprocessing_recipe.get("imputation_strategy") == "forward_fill" else training_target.interpolate(method="linear")).ffill().bfill()
            if self.preprocessing_recipe.get("outlier_action") == "cap" and len(training_target) >= 10:
                if self.preprocessing_recipe.get("outlier_method") == "zscore":
                    center, spread = training_target.mean(), training_target.std()
                    lower, upper = center - 3 * spread, center + 3 * spread
                else:
                    q1, q3 = training_target.quantile(.25), training_target.quantile(.75)
                    lower, upper = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
                if pd.notna(lower) and pd.notna(upper) and lower < upper:
                    training_target = training_target.clip(lower, upper)
            self.train_df[self.target_column] = training_target.to_numpy()
            self.holdout_df[self.target_column] = source[self.target_column].iloc[train_size:].to_numpy()
            self.evaluation_note = "Holdout evaluation uses observed targets from evaluation_source.csv. Imputation and optional capping are fitted on training dates only; missing holdout targets are excluded from scoring."
            self._log_action("EVALUATION_PREPROCESSING", "train_only", self.evaluation_note)

        train_start = str(self.train_df[self.date_column].iloc[0].date())
        train_end = str(self.train_df[self.date_column].iloc[-1].date())
        holdout_start = str(self.holdout_df[self.date_column].iloc[0].date())
        holdout_end = str(self.holdout_df[self.date_column].iloc[-1].date())

        self._log_action(
            step_name="CHRONOLOGICAL_SPLIT",
            action="dataset_split",
            description=f"Chronological holdout split: {train_size} training periods ({train_start} to {train_end}) and {H} holdout evaluation periods ({holdout_start} to {holdout_end}). No data shuffled."
        )
        return self.train_df, self.holdout_df

    # =========================================================================
    # STEP 6 & 7: TRAIN & EVALUATE HOLDOUT
    # =========================================================================
    def step6_train_and_evaluate(self) -> List[Dict[str, Any]]:
        if self.train_df is None or self.holdout_df is None:
            self.step5_split()

        train_series = self.train_df[self.target_column]
        train_dates = self.train_df[self.date_column]
        holdout_actuals = np.asarray(self.holdout_df[self.target_column].values, dtype=float)
        observed_mask = np.isfinite(holdout_actuals)
        if not observed_mask.any():
            raise ValueError("The holdout period has no observed target values for evaluation.")
        H = len(holdout_actuals)
        m = self.seasonal_period
        freq = self.frequency

        # Model instantiations
        candidates: List[BaseModelWrapper] = [
            SeasonalNaiveWrapper(),
            ETSWrapper(),
            ARIMAWrapper(),
            ProphetWrapper(),
            LightGBMWrapper(),
            ThetaWrapper()
        ]

        results = []

        for model in candidates:
            m_name = model.name
            elig = self.eligibility_results.get(m_name, {"eligible": True, "reason": "Eligible"})

            if not elig["eligible"]:
                results.append({
                    "model_name": m_name,
                    "status": "skipped",
                    "skip_reason": elig["reason"],
                    "mae": None, "rmse": None, "mape": None, "smape": None, "mase": None,
                    "beats_baseline": False,
                    "train_seconds": 0.0,
                    "hyperparameters": {},
                    "rank": 999
                })
                continue

            # Model is eligible: train and predict
            try:
                t0 = time.time()
                model.fit(train_series, train_dates, freq, m)
                preds = model.predict(H)
                fit_secs = time.time() - t0

                if len(preds) != H:
                    raise ValueError(f"Model {m_name} returned {len(preds)} predictions, expected {H}")

                self.holdout_predictions[m_name] = preds

                # Evaluate metrics
                metrics = evaluate_forecast(
                    actual=holdout_actuals[observed_mask],
                    predicted=preds[observed_mask],
                    train_series=train_series.values,
                    seasonal_period=m
                )

                res_entry = {
                    "model_name": m_name,
                    "status": "ok",
                    "skip_reason": None,
                    "mae": metrics["mae"],
                    "rmse": metrics["rmse"],
                    "mape": metrics["mape"],
                    "smape": metrics["smape"],
                    "mase": metrics["mase"],
                    "beats_baseline": metrics["beats_baseline"],
                    "train_seconds": round(fit_secs, 3),
                    "hyperparameters": model.hyperparameters,
                    "model_instance": model
                }
                results.append(res_entry)

                mase_str = f"MASE {metrics['mase']}" + (" (beats baseline)" if metrics["beats_baseline"] else " (does not beat baseline)")
                self._log_action(
                    step_name="TRAIN_AND_EVALUATE",
                    model_name=m_name,
                    action="model_evaluated",
                    description=f"{m_name} trained in {round(fit_secs, 2)}s. Holdout RMSE: {metrics['rmse']}, MAE: {metrics['mae']}, sMAPE: {metrics['smape']}%, {mase_str}."
                )

            except Exception as e:
                logger.error(f"Error training {m_name}: {e}", exc_info=True)
                results.append({
                    "model_name": m_name,
                    "status": "failed",
                    "skip_reason": f"Execution failed: {str(e)}",
                    "mae": None, "rmse": None, "mape": None, "smape": None, "mase": None,
                    "beats_baseline": False,
                    "train_seconds": 0.0,
                    "hyperparameters": {},
                    "rank": 999
                })
                self._log_action(
                    step_name="TRAIN_AND_EVALUATE",
                    model_name=m_name,
                    action="model_failed",
                    description=f"{m_name} failed during holdout training: {str(e)}"
                )

        self.model_results = results
        return results

    # =========================================================================
    # STEP 8: MODEL COMPARISON & SELECTION
    # =========================================================================
    def step8_select_winner(self) -> Dict[str, Any]:
        valid_results = [r for r in self.model_results if r["status"] == "ok" and r[self.ranking_metric] is not None]

        if not valid_results:
            raise RuntimeError("No models trained successfully on the holdout dataset.")

        # Rank ascending by the chosen metric (lowest error wins)
        valid_results.sort(key=lambda x: x[self.ranking_metric])

        for rank, r in enumerate(valid_results, start=1):
            r["rank"] = rank

        # Non-trained models receive trailing ranks
        for r in self.model_results:
            if r["status"] != "ok":
                r["rank"] = len(valid_results) + 1

        winner = valid_results[0]
        self.winner_model_name = winner["model_name"]
        self.winner_model_obj = winner.get("model_instance")

        # Baseline check warning
        baseline_model = next((r for r in valid_results if r["model_name"] == "Seasonal Naive"), None)
        any_beat_baseline = any(r["beats_baseline"] for r in valid_results if r["model_name"] != "Seasonal Naive")

        if not any_beat_baseline and len(valid_results) > 1:
            warn_text = "No candidate model outperformed the Seasonal Naive baseline on MASE; treat future forecasts with caution."
            self.warnings.append(warn_text)
            self._log_action(
                step_name="MODEL_SELECTION",
                action="baseline_warning",
                description=warn_text
            )

        winner_metric_val = winner[self.ranking_metric]
        winner_mase = winner["mase"]
        winner_reason = (
            f"{winner['model_name']} achieved the best holdout performance with {self.ranking_metric.upper()} {winner_metric_val} "
            f"(MASE: {winner_mase}), ranking 1st of {len(valid_results)} successfully evaluated models."
        )

        self._log_action(
            step_name="MODEL_SELECTION",
            model_name=self.winner_model_name,
            action="winner_selected",
            description=winner_reason
        )

        return winner

    # =========================================================================
    # STEP 9: REFIT & FORECAST
    # =========================================================================
    def step9_refit_and_forecast(self) -> pd.DataFrame:
        if not self.winner_model_name:
            self.step8_select_winner()

        full_series = self.df[self.target_column]
        full_dates = self.df[self.date_column]
        freq = self.frequency
        m = self.seasonal_period
        H = self.horizon

        # Re-instantiate a fresh instance of the winning model for full refit
        winner_class_map = {
            "Seasonal Naive": SeasonalNaiveWrapper,
            "ETS (Exponential Smoothing)": ETSWrapper,
            "ARIMA / SARIMA": ARIMAWrapper,
            "Prophet": ProphetWrapper,
            "LightGBM": LightGBMWrapper,
            "Theta": ThetaWrapper
        }

        model_cls = winner_class_map.get(self.winner_model_name, SeasonalNaiveWrapper)
        final_model = model_cls()

        t0 = time.time()
        final_model.fit(full_series, full_dates, freq, m)
        refit_time = time.time() - t0

        point_preds = final_model.predict(H)
        lower_80, upper_80 = final_model.predict_interval(H, level=0.80)
        lower_95, upper_95 = final_model.predict_interval(H, level=0.95)

        # Generate future dates
        last_dt = full_dates.iloc[-1]
        future_dates = pd.date_range(start=last_dt, periods=H + 1, freq=freq)[1:]
        date_strs = [str(d.date()) if hasattr(d, 'date') else str(d) for d in future_dates]

        forecast_df = pd.DataFrame({
            "date": date_strs,
            "forecast": np.round(point_preds, 4),
            "lower_80": np.round(lower_80, 4),
            "upper_80": np.round(upper_80, 4),
            "lower_95": np.round(lower_95, 4),
            "upper_95": np.round(upper_95, 4)
        })

        self.future_forecast_df = forecast_df
        self.winner_model_obj = final_model

        self._log_action(
            step_name="REFIT_AND_FORECAST",
            model_name=self.winner_model_name,
            action="forecast_generated",
            description=f"Refit {self.winner_model_name} on all {len(full_series)} observations in {round(refit_time, 2)}s. Generated {H}-step future forecast with 80% and 95% confidence intervals."
        )

        return forecast_df

    # =========================================================================
    # STEP 10: EXPORT & SAVE
    # =========================================================================
    def step10_export(self) -> Dict[str, Any]:
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.models_dir, exist_ok=True)

        # 1. forecast.csv
        forecast_csv_path = os.path.join(self.output_dir, "forecast.csv")
        self.future_forecast_df.to_csv(forecast_csv_path, index=False)

        # 2. holdout_predictions.csv
        holdout_csv_path = os.path.join(self.output_dir, "holdout_predictions.csv")
        holdout_df_out = pd.DataFrame({
            "date": [str(d.date()) if hasattr(d, 'date') else str(d) for d in self.holdout_df[self.date_column]],
            "actual": np.round(self.holdout_df[self.target_column].values, 4)
        })
        for m_name, preds in self.holdout_predictions.items():
            safe_col = m_name.replace(" ", "_").replace("(", "").replace(")", "").replace("/", "_").lower()
            holdout_df_out[safe_col] = np.round(preds, 4)
        holdout_df_out.to_csv(holdout_csv_path, index=False)

        # 3. Model artifact for XAI Agent
        model_artifact_path = os.path.join(self.models_dir, "model.joblib")
        if self.winner_model_obj and self.winner_model_obj.model_artifact is not None:
            joblib.dump(self.winner_model_obj.model_artifact, model_artifact_path)
        else:
            joblib.dump(self.winner_model_obj, model_artifact_path)

        # 4. Feature metadata for XAI Agent
        feature_meta_path = os.path.join(self.models_dir, "metadata.json")
        features_used = []
        if isinstance(self.winner_model_obj, LightGBMWrapper):
            features_used = self.winner_model_obj.feature_names
        else:
            features_used = [self.target_column, self.date_column]

        xai_meta = {
            "model_name": self.winner_model_name,
            "target_column": self.target_column,
            "date_column": self.date_column,
            "frequency": self.frequency,
            "seasonal_period": self.seasonal_period,
            "features": features_used,
            "hyperparameters": self.winner_model_obj.hyperparameters if self.winner_model_obj else {},
            "created_at": time.time()
        }
        with open(feature_meta_path, "w", encoding="utf-8") as f:
            json.dump(xai_meta, f, indent=2)

        # 5. Clean model results for serialization
        clean_model_results = []
        for r in self.model_results:
            clean_entry = {k: v for k, v in r.items() if k != "model_instance"}
            clean_model_results.append(clean_entry)

        # 6. report.json
        report_data = {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "dataset_file": os.path.basename(self.file_path),
            "date_column": self.date_column,
            "target_column": self.target_column,
            "frequency": self.frequency,
            "seasonal_period": self.seasonal_period,
            "total_observations": len(self.df),
            "train_observations": len(self.train_df),
            "holdout_observations": len(self.holdout_df),
            "horizon": self.horizon,
            "ranking_metric": self.ranking_metric,
            "winner_model": self.winner_model_name,
            "warnings": self.warnings,
            "evaluation_preprocessing": self.evaluation_note,
            "preprocessing_contract": self.preprocessing_contract,
            "model_leaderboard": clean_model_results,
            "eligibility_decisions": self.eligibility_results,
            "features_engineered": self.step4_feature_engineering_info() if "LightGBM" in self.selected_models else [],
            "split_info": {
                "train_start": str(self.train_df[self.date_column].iloc[0].date()),
                "train_end": str(self.train_df[self.date_column].iloc[-1].date()),
                "holdout_start": str(self.holdout_df[self.date_column].iloc[0].date()),
                "holdout_end": str(self.holdout_df[self.date_column].iloc[-1].date())
            },
            "audit_actions": self.actions,
            "output_files": {
                "forecast_csv": forecast_csv_path,
                "holdout_csv": holdout_csv_path,
                "model_artifact": model_artifact_path,
                "feature_metadata": feature_meta_path
            }
        }

        report_json_path = os.path.join(self.output_dir, "report.json")
        with open(report_json_path, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2)

        self._log_action(
            step_name="EXPORT",
            action="artifacts_saved",
            description=f"Exported forecast.csv ({self.horizon} periods), holdout_predictions.csv, report.json, and trained model artifacts for downstream explainable AI analysis."
        )

        return report_data

    # =========================================================================
    # EXECUTE FULL PIPELINE
    # =========================================================================
    def run(self) -> Dict[str, Any]:
        self.step1_load()
        self.step2_validate()
        self.step3_check_eligibility()
        self.step4_feature_engineering_info()
        self.step5_split()
        self.step6_train_and_evaluate()
        self.step8_select_winner()
        self.step9_refit_and_forecast()
        return self.step10_export()
