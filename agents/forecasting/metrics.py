"""
Evaluation metrics for time-series forecasting.
Includes MAE, RMSE, MAPE (with zero-handling), sMAPE, and MASE.
"""

from typing import Dict, Any, Optional
import numpy as np


def calculate_mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted)))


def calculate_rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((actual - predicted) ** 2)))


def calculate_mape(actual: np.ndarray, predicted: np.ndarray) -> Optional[float]:
    """
    Computes Mean Absolute Percentage Error (MAPE).
    If any actual value is 0, returns None to avoid division by zero.
    """
    if np.any(actual == 0):
        return None
    return float(np.mean(np.abs((actual - predicted) / actual)) * 100.0)


def calculate_smape(actual: np.ndarray, predicted: np.ndarray) -> float:
    """
    Computes Symmetric Mean Absolute Percentage Error (sMAPE) as a percentage (0-100%).
    Formula: 100 * mean(2 * |y - yhat| / (|y| + |yhat|))
    """
    denominator = (np.abs(actual) + np.abs(predicted)) / 2.0
    # Avoid zero division when both actual and predicted are 0
    valid_idx = denominator != 0
    if not np.any(valid_idx):
        return 0.0
    smape_vals = np.abs(predicted[valid_idx] - actual[valid_idx]) / denominator[valid_idx]
    return float(np.mean(smape_vals) * 100.0)


def calculate_mase(
    actual_holdout: np.ndarray,
    predicted_holdout: np.ndarray,
    train_series: np.ndarray,
    seasonal_period: int = 1
) -> float:
    """
    Computes Mean Absolute Scaled Error (MASE) relative to a Seasonal Naive baseline on training data.
    MASE < 1 means the model outperforms the in-sample naive baseline.
    MASE >= 1 means the model does not outperform the baseline.
    """
    mae_holdout = calculate_mae(actual_holdout, predicted_holdout)

    m = max(1, seasonal_period)
    if len(train_series) <= m:
        m = 1  # Fallback to non-seasonal lag-1 if train series is shorter than seasonal period

    # In-sample seasonal differences on training set
    diffs = np.abs(train_series[m:] - train_series[:-m])
    mean_abs_diff = float(np.mean(diffs)) if len(diffs) > 0 else 0.0

    if mean_abs_diff == 0.0 or np.isnan(mean_abs_diff):
        # Fallback to non-seasonal diff or 1.0 to avoid zero division
        non_seasonal_diff = np.abs(train_series[1:] - train_series[:-1])
        mean_abs_diff = float(np.mean(non_seasonal_diff)) if len(non_seasonal_diff) > 0 else 1.0
        if mean_abs_diff == 0.0:
            mean_abs_diff = 1.0

    return float(mae_holdout / mean_abs_diff)


def evaluate_forecast(
    actual: np.ndarray,
    predicted: np.ndarray,
    train_series: np.ndarray,
    seasonal_period: int = 1
) -> Dict[str, Any]:
    """
    Calculates full metric suite on holdout actuals vs predictions.
    """
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    train_series = np.asarray(train_series, dtype=float)

    mae = calculate_mae(actual, predicted)
    rmse = calculate_rmse(actual, predicted)
    mape = calculate_mape(actual, predicted)
    smape = calculate_smape(actual, predicted)
    mase = calculate_mase(actual, predicted, train_series, seasonal_period)
    beats_baseline = bool(mase < 1.0)

    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "mape": round(mape, 4) if mape is not None else None,
        "smape": round(smape, 4),
        "mase": round(mase, 4),
        "beats_baseline": beats_baseline
    }
