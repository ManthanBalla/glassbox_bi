"""
Portfolio of 6 Forecasting Models for GlassBox-BI Forecasting Agent.
Provides a unified wrapper interface: fit, predict, predict_interval, get_metadata.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, Tuple, List
import warnings
import logging
import time
import numpy as np
import pandas as pd
from scipy import stats

warnings.filterwarnings("ignore")
logger = logging.getLogger("forecasting_models")


class BaseModelWrapper(ABC):
    """Common interface for all time-series forecasting model wrappers."""
    
    def __init__(self, name: str):
        self.name = name
        self.is_fitted = False
        self.fit_time_seconds = 0.0
        self.hyperparameters: Dict[str, Any] = {}
        self.status = "ok"  # 'ok', 'skipped', 'failed', 'unavailable'
        self.skip_reason: Optional[str] = None
        self.error_message: Optional[str] = None
        self.model_artifact: Any = None
        self.train_residuals: Optional[np.ndarray] = None
        self.train_std: float = 1.0

    @abstractmethod
    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        pass

    @abstractmethod
    def predict(self, horizon: int) -> np.ndarray:
        pass

    @abstractmethod
    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        pass

    def get_metadata(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "skip_reason": self.skip_reason,
            "error_message": self.error_message,
            "fit_time_seconds": round(self.fit_time_seconds, 3),
            "hyperparameters": self.hyperparameters
        }


# ============================================================================
# 1. Seasonal Naive Model (Baseline)
# ============================================================================
class SeasonalNaiveWrapper(BaseModelWrapper):
    """
    Seasonal Naive baseline model.
    Repeats the observation from the previous seasonal cycle: y_{T+h} = y_{T+h - m*k}.
    Always eligible; serves as the benchmark for MASE.
    """
    def __init__(self):
        super().__init__("Seasonal Naive")
        self.seasonal_period = 1
        self.last_cycle_values: np.ndarray = np.array([])
        self.last_value: float = 0.0

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        y = np.asarray(series.values, dtype=float)
        self.seasonal_period = max(1, seasonal_period)
        m = self.seasonal_period

        if len(y) >= m:
            self.last_cycle_values = y[-m:]
        else:
            self.last_cycle_values = y
            self.seasonal_period = len(y)

        self.last_value = float(y[-1]) if len(y) > 0 else 0.0

        # In-sample seasonal residuals for prediction intervals
        if len(y) > m:
            residuals = y[m:] - y[:-m]
            self.train_residuals = residuals
            self.train_std = float(np.std(residuals)) if len(residuals) > 0 else 1.0
        else:
            self.train_residuals = np.array([0.0])
            self.train_std = float(np.std(y)) if len(y) > 1 else 1.0

        if self.train_std == 0.0:
            self.train_std = 1.0

        self.hyperparameters = {
            "seasonal_period": self.seasonal_period,
            "baseline_type": "seasonal_naive" if m > 1 else "naive"
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        m = self.seasonal_period
        if m <= 0 or len(self.last_cycle_values) == 0:
            return np.full(horizon, self.last_value)

        # Tile last cycle values to cover horizon
        reps = int(np.ceil(horizon / m))
        preds = np.tile(self.last_cycle_values, reps)[:horizon]
        return preds

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        preds = self.predict(horizon)
        z = float(stats.norm.ppf(0.5 + level / 2.0))
        m = max(1, self.seasonal_period)
        
        # Standard error grows with forecast steps spanning seasons
        k = np.floor((np.arange(horizon)) / m) + 1.0
        se = self.train_std * np.sqrt(k)
        lower = preds - z * se
        upper = preds + z * se
        return lower, upper


# ============================================================================
# 2. ETS / Exponential Smoothing (statsmodels)
# ============================================================================
class ETSWrapper(BaseModelWrapper):
    """
    ETS (Error, Trend, Seasonal) exponential smoothing model using statsmodels.
    Selects trend and seasonal components automatically based on cycle eligibility.
    """
    def __init__(self):
        super().__init__("ETS (Exponential Smoothing)")
        self.model_res = None
        self.trend = None
        self.seasonal = None
        self.seasonal_period = 1

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        y = np.asarray(series.values, dtype=float)
        N = len(y)
        m = seasonal_period

        # Determine trend and seasonal configuration
        use_seasonal = (m > 1) and (N >= 2 * m)
        trend_type = "add" if N >= 8 else None
        seasonal_type = "add" if use_seasonal else None

        fitted = False
        candidates = []
        if use_seasonal:
            candidates.append({"trend": "add", "seasonal": "add", "seasonal_periods": m})
            candidates.append({"trend": None, "seasonal": "add", "seasonal_periods": m})
        candidates.append({"trend": "add", "seasonal": None, "seasonal_periods": None})
        candidates.append({"trend": None, "seasonal": None, "seasonal_periods": None})

        last_err = None
        for cfg in candidates:
            try:
                mod = ExponentialSmoothing(
                    y,
                    trend=cfg["trend"],
                    seasonal=cfg["seasonal"],
                    seasonal_periods=cfg["seasonal_periods"],
                    initialization_method="estimated"
                )
                self.model_res = mod.fit(optimized=True)
                self.trend = cfg["trend"]
                self.seasonal = cfg["seasonal"]
                self.seasonal_period = cfg["seasonal_periods"] or 1
                fitted = True
                break
            except Exception as e:
                last_err = e
                continue

        if not fitted or self.model_res is None:
            raise RuntimeError(f"ETS fitting failed across all candidates: {last_err}")

        # Compute in-sample residual std
        fitted_vals = np.asarray(self.model_res.fittedvalues)
        if len(fitted_vals) == len(y):
            residuals = y - fitted_vals
            self.train_residuals = residuals
            self.train_std = float(np.std(residuals)) if len(residuals) > 0 else 1.0
        else:
            self.train_std = float(np.std(y)) if len(y) > 1 else 1.0

        if self.train_std == 0.0:
            self.train_std = 1.0

        self.model_artifact = self.model_res
        self.hyperparameters = {
            "trend": self.trend,
            "seasonal": self.seasonal,
            "seasonal_period": self.seasonal_period,
            "smoothing_level": getattr(self.model_res.params, 'get', lambda k: None)('smoothing_level'),
            "smoothing_trend": getattr(self.model_res.params, 'get', lambda k: None)('smoothing_trend'),
            "smoothing_seasonal": getattr(self.model_res.params, 'get', lambda k: None)('smoothing_seasonal')
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        if not self.is_fitted or self.model_res is None:
            raise RuntimeError("ETS model is not fitted")
        forecasts = self.model_res.forecast(horizon)
        return np.asarray(forecasts, dtype=float)

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        preds = self.predict(horizon)
        z = float(stats.norm.ppf(0.5 + level / 2.0))
        # Cumulative error variance for ETS steps
        se = self.train_std * np.sqrt(np.arange(1, horizon + 1))
        lower = preds - z * se
        upper = preds + z * se
        return lower, upper


# ============================================================================
# 3. ARIMA / SARIMA (statsmodels)
# ============================================================================
class ARIMAWrapper(BaseModelWrapper):
    """
    ARIMA / SARIMA model using statsmodels SARIMAX with AIC-based order search.
    """
    def __init__(self):
        super().__init__("ARIMA / SARIMA")
        self.model_res = None
        self.order = (1, 1, 1)
        self.seasonal_order = (0, 0, 0, 0)

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        y = np.asarray(series.values, dtype=float)
        N = len(y)
        m = seasonal_period
        use_seasonal = (m > 1) and (N >= 2 * m) and (m <= 52)

        # Candidate order grid to search for best AIC without excessive lag
        non_seasonal_orders = [(1, 1, 1), (0, 1, 1), (1, 1, 0), (2, 1, 1), (1, 0, 1), (0, 1, 0)]
        if use_seasonal:
            seasonal_orders = [(1, 0, 0, m), (0, 1, 1, m), (0, 0, 0, 0)]
        else:
            seasonal_orders = [(0, 0, 0, 0)]

        best_aic = float("inf")
        best_res = None
        best_order = (1, 1, 1)
        best_s_order = (0, 0, 0, 0)

        for p_d_q in non_seasonal_orders:
            for P_D_Q_m in seasonal_orders:
                try:
                    mod = SARIMAX(
                        y,
                        order=p_d_q,
                        seasonal_order=P_D_Q_m,
                        enforce_stationarity=True,
                        enforce_invertibility=False
                    )
                    res = mod.fit(disp=False, maxiter=40)
                    if res.aic < best_aic and not np.isnan(res.aic):
                        best_aic = res.aic
                        best_res = res
                        best_order = p_d_q
                        best_s_order = P_D_Q_m
                except Exception:
                    continue

        # Fallback to simple AR(1) or Random Walk if search failed
        if best_res is None:
            try:
                mod = SARIMAX(y, order=(1, 1, 0), enforce_stationarity=True, enforce_invertibility=False)
                best_res = mod.fit(disp=False, maxiter=30)
                best_order = (1, 1, 0)
                best_s_order = (0, 0, 0, 0)
            except Exception as e:
                raise RuntimeError(f"ARIMA fitting failed: {e}")

        self.model_res = best_res
        self.order = best_order
        self.seasonal_order = best_s_order
        self.model_artifact = self.model_res

        self.hyperparameters = {
            "order": list(self.order),
            "seasonal_order": list(self.seasonal_order),
            "aic": round(float(self.model_res.aic), 2) if hasattr(self.model_res, 'aic') else None
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        if not self.is_fitted or self.model_res is None:
            raise RuntimeError("ARIMA model is not fitted")
        forecast = self.model_res.forecast(steps=horizon)
        arr = np.asarray(forecast, dtype=float)
        return np.clip(arr, -1e9, 1e9)

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        if not self.is_fitted or self.model_res is None:
            raise RuntimeError("ARIMA model is not fitted")
        alpha = 1.0 - level
        pred_res = self.model_res.get_forecast(steps=horizon)
        conf_int = pred_res.conf_int(alpha=alpha)
        lower = np.asarray(conf_int[:, 0], dtype=float)
        upper = np.asarray(conf_int[:, 1], dtype=float)
        return lower, upper


# ============================================================================
# 4. Prophet Model
# ============================================================================
class ProphetWrapper(BaseModelWrapper):
    """
    Facebook Prophet model wrapper for trend + seasonality forecasting.
    """
    def __init__(self):
        super().__init__("Prophet")
        self.prophet_model = None
        self.freq_str = "D"
        self.last_date = None

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        import prophet
        import logging
        # Suppress noisy prophet/cmdstanpy output
        logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
        logging.getLogger('prophet').setLevel(logging.WARNING)

        df = pd.DataFrame({
            "ds": pd.to_datetime(dates),
            "y": np.asarray(series.values, dtype=float)
        })

        self.last_date = df["ds"].iloc[-1]
        self.freq_str = freq if freq else "D"

        # Determine seasonalities based on frequency
        has_weekly = freq.upper().startswith("D")
        has_yearly = len(df) >= 2 * seasonal_period and seasonal_period > 1

        m = prophet.Prophet(
            interval_width=0.95,
            yearly_seasonality=has_yearly,
            weekly_seasonality=has_weekly,
            daily_seasonality=False
        )
        m.fit(df)

        self.prophet_model = m
        self.model_artifact = m
        self.hyperparameters = {
            "yearly_seasonality": has_yearly,
            "weekly_seasonality": has_weekly,
            "changepoint_prior_scale": 0.05
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        if not self.is_fitted or self.prophet_model is None:
            raise RuntimeError("Prophet model is not fitted")
        future = self.prophet_model.make_future_dataframe(periods=horizon, freq=self.freq_str)
        fcst = self.prophet_model.predict(future)
        return np.asarray(fcst["yhat"].iloc[-horizon:].values, dtype=float)

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        if not self.is_fitted or self.prophet_model is None:
            raise RuntimeError("Prophet model is not fitted")
        
        future = self.prophet_model.make_future_dataframe(periods=horizon, freq=self.freq_str)
        fcst = self.prophet_model.predict(future)
        yhat = np.asarray(fcst["yhat"].iloc[-horizon:].values, dtype=float)
        yhat_lower_95 = np.asarray(fcst["yhat_lower"].iloc[-horizon:].values, dtype=float)
        yhat_upper_95 = np.asarray(fcst["yhat_upper"].iloc[-horizon:].values, dtype=float)

        if abs(level - 0.95) < 0.01:
            return yhat_lower_95, yhat_upper_95
        
        # Scale 95% interval width to desired level (e.g. 80%) assuming Gaussian errors
        z_95 = stats.norm.ppf(0.975)
        z_target = stats.norm.ppf(0.5 + level / 2.0)
        ratio = z_target / z_95

        half_width = (yhat_upper_95 - yhat_lower_95) / 2.0 * ratio
        lower = yhat - half_width
        upper = yhat + half_width
        return lower, upper


# ============================================================================
# 5. LightGBM Model (Engineered Lag / Rolling / Calendar Features)
# ============================================================================
class LightGBMWrapper(BaseModelWrapper):
    """
    LightGBM gradient boosted regression with strictly backward-looking engineered features:
    lags (1, 2, 3, m), rolling mean/std on shifted data, calendar features, and recursive multi-step forecasting.
    """
    def __init__(self):
        super().__init__("LightGBM")
        self.model = None
        self.feature_names: List[str] = []
        self.seasonal_period = 1
        self.freq_str = "D"
        self.history_y: np.ndarray = np.array([])
        self.history_dates: pd.Series = pd.Series(dtype='datetime64[ns]')

    def _extract_calendar(self, dt: pd.Timestamp) -> Dict[str, float]:
        return {
            "month": float(dt.month),
            "quarter": float(dt.quarter),
            "dayofweek": float(dt.dayofweek),
            "is_month_end": 1.0 if dt.is_month_end else 0.0
        }

    def _create_feature_matrix(self, y: np.ndarray, dates: pd.Series, m: int) -> Tuple[pd.DataFrame, np.ndarray]:
        """
        Builds backward-looking features for each observation t:
        Lags 1, 2, 3, seasonal lag m.
        Rolling mean (window 3) and std (window 3) on shifted series (y_{t-1}, y_{t-2}, y_{t-3}).
        Calendar attributes and time index.
        """
        N = len(y)
        max_lag = max(3, m)
        rows = []
        targets = []

        for i in range(max_lag, N):
            dt = pd.to_datetime(dates.iloc[i])
            feats = {
                "lag_1": float(y[i - 1]),
                "lag_2": float(y[i - 2]),
                "lag_3": float(y[i - 3]),
                "lag_m": float(y[i - m]),
                "roll_mean_3": float(np.mean(y[i - 3:i])),
                "roll_std_3": float(np.std(y[i - 3:i])),
                "time_index": float(i)
            }
            feats.update(self._extract_calendar(dt))
            rows.append(feats)
            targets.append(y[i])

        X = pd.DataFrame(rows)
        Y = np.array(targets, dtype=float)
        return X, Y

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        import lightgbm as lgb

        y = np.asarray(series.values, dtype=float)
        self.seasonal_period = max(1, seasonal_period)
        self.freq_str = freq
        self.history_y = y.copy()
        self.history_dates = pd.to_datetime(dates).copy()

        m = self.seasonal_period
        X, Y = self._create_feature_matrix(y, dates, m)
        self.feature_names = list(X.columns)

        reg = lgb.LGBMRegressor(
            n_estimators=100,
            learning_rate=0.05,
            num_leaves=15,
            min_child_samples=5,
            random_state=42,
            verbosity=-1
        )
        reg.fit(X, Y)
        self.model = reg
        self.model_artifact = reg

        # In-sample residuals for prediction interval estimation
        in_sample_preds = reg.predict(X)
        residuals = Y - in_sample_preds
        self.train_residuals = residuals
        self.train_std = float(np.std(residuals)) if len(residuals) > 0 else 1.0
        if self.train_std == 0.0:
            self.train_std = 1.0

        self.hyperparameters = {
            "n_estimators": 100,
            "learning_rate": 0.05,
            "num_leaves": 15,
            "features_engineered": self.feature_names
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        """
        Recursive multi-step forecast: each step feeds into the lag buffer
        without ever seeing actual future ground-truth.
        """
        if not self.is_fitted or self.model is None:
            raise RuntimeError("LightGBM model is not fitted")

        y_buffer = list(self.history_y)
        last_dt = self.history_dates.iloc[-1]
        freq = self.freq_str
        preds = []
        m = self.seasonal_period

        # Generate future dates
        future_dates = pd.date_range(start=last_dt, periods=horizon + 1, freq=freq)[1:]

        for step in range(horizon):
            dt = future_dates[step]
            curr_idx = len(y_buffer)

            row_feats = {
                "lag_1": float(y_buffer[-1]),
                "lag_2": float(y_buffer[-2]),
                "lag_3": float(y_buffer[-3]),
                "lag_m": float(y_buffer[-m]),
                "roll_mean_3": float(np.mean(y_buffer[-3:])),
                "roll_std_3": float(np.std(y_buffer[-3:])),
                "time_index": float(curr_idx)
            }
            row_feats.update(self._extract_calendar(dt))

            row_df = pd.DataFrame([row_feats])[self.feature_names]
            y_pred = float(self.model.predict(row_df)[0])
            preds.append(y_pred)
            y_buffer.append(y_pred)

        return np.array(preds, dtype=float)

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        preds = self.predict(horizon)
        z = float(stats.norm.ppf(0.5 + level / 2.0))
        # Recursive uncertainty compound factor sqrt(1 + 0.1 * step)
        step_mult = np.sqrt(1.0 + 0.15 * np.arange(horizon))
        se = self.train_std * step_mult
        lower = preds - z * se
        upper = preds + z * se
        return lower, upper


# ============================================================================
# 6. Theta Model (statsmodels)
# ============================================================================
class ThetaWrapper(BaseModelWrapper):
    """
    Theta method time-series forecasting model from statsmodels.
    Decomposes series into dynamic theta lines; robust against seasonal noise.
    """
    def __init__(self):
        super().__init__("Theta")
        self.model_res = None
        self.seasonal_period = 1

    def fit(self, series: pd.Series, dates: pd.Series, freq: str, seasonal_period: int):
        t0 = time.time()
        from statsmodels.tsa.forecasting.theta import ThetaModel

        y = np.asarray(series.values, dtype=float)
        N = len(y)
        m = seasonal_period
        use_seasonal = (m > 1) and (N >= 2 * m)
        period = m if use_seasonal else 1

        mod = ThetaModel(y, period=period)
        self.model_res = mod.fit()
        self.seasonal_period = period
        self.model_artifact = self.model_res

        self.hyperparameters = {
            "period": period,
            "deseasonalize": use_seasonal
        }
        self.fit_time_seconds = time.time() - t0
        self.is_fitted = True

    def predict(self, horizon: int) -> np.ndarray:
        if not self.is_fitted or self.model_res is None:
            raise RuntimeError("Theta model is not fitted")
        fcst = self.model_res.forecast(horizon)
        return np.asarray(fcst, dtype=float)

    def predict_interval(self, horizon: int, level: float) -> Tuple[np.ndarray, np.ndarray]:
        if not self.is_fitted or self.model_res is None:
            raise RuntimeError("Theta model is not fitted")
        alpha = 1.0 - level
        intervals = self.model_res.prediction_intervals(steps=horizon, alpha=alpha)
        lower = np.asarray(intervals["lower"].values, dtype=float)
        upper = np.asarray(intervals["upper"].values, dtype=float)
        return lower, upper
