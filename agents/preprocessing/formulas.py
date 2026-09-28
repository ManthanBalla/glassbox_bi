"""
Data Quality Score and Forecast Readiness Score computation algorithms.
Both scores are deterministic, bounded 0-100, and fully explainable.
"""

from typing import Dict, Any, List, Tuple
import pandas as pd
import numpy as np


def compute_data_quality_score(df: pd.DataFrame) -> Dict[str, Any]:
    """
    Computes a Data Quality Score (0–100) based on 5 quality dimensions:
    - Missing Values Penalty (up to 40 pts)
    - Duplicate Rows Penalty (up to 20 pts)
    - Constant Columns Penalty (up to 15 pts)
    - Severe Missingness Columns Penalty (>50% missing) (up to 15 pts)
    - Mixed / Dirty Type Penalty (up to 10 pts)

    Formula:
      Score = 100 - (missing_penalty + dup_penalty + const_penalty + severe_missing_penalty + dirty_type_penalty)
      Clamped to [0.0, 100.0]
    """
    total_rows = len(df)
    total_cols = len(df.columns)

    if total_rows == 0 or total_cols == 0:
        return {"score": 0.0, "breakdown": {"reason": "Empty dataset"}}

    # 1. Missing Values Penalty (0 - 40 pts)
    total_cells = total_rows * total_cols
    missing_cells = int(df.isna().sum().sum())
    missing_ratio = missing_cells / total_cells if total_cells > 0 else 0
    missing_penalty = min(40.0, missing_ratio * 40.0)

    # 2. Duplicate Rows Penalty (0 - 20 pts)
    dup_rows = int(df.duplicated().sum())
    dup_ratio = dup_rows / total_rows if total_rows > 0 else 0
    dup_penalty = min(20.0, dup_ratio * 40.0)

    # 3. Constant Columns Penalty (0 - 15 pts)
    constant_cols = 0
    for col in df.columns:
        if df[col].nunique(dropna=False) <= 1:
            constant_cols += 1
    const_ratio = constant_cols / total_cols if total_cols > 0 else 0
    const_penalty = min(15.0, const_ratio * 25.0)

    # 4. Severe Missingness (>50% missing in a column) (0 - 15 pts)
    severe_cols = 0
    for col in df.columns:
        col_missing_ratio = df[col].isna().sum() / total_rows
        if col_missing_ratio > 0.50:
            severe_cols += 1
    severe_ratio = severe_cols / total_cols if total_cols > 0 else 0
    severe_missing_penalty = min(15.0, severe_ratio * 30.0)

    # 5. Dirty / Mixed string indicators in candidate numeric columns (0 - 10 pts)
    dirty_type_penalty = 0.0
    for col in df.columns:
        if df[col].dtype == object:
            sample_vals = df[col].dropna().astype(str).head(50)
            has_currency = any(any(c in s for c in ['$', '€', '£', '¥']) for s in sample_vals)
            has_pct = any('%' in s for s in sample_vals)
            has_placeholders = any(s.strip().lower() in ['n/a', 'na', 'null', 'none', '-', '?'] for s in sample_vals)
            if has_currency or has_pct or has_placeholders:
                dirty_type_penalty = min(10.0, dirty_type_penalty + 2.5)

    deductions = missing_penalty + dup_penalty + const_penalty + severe_missing_penalty + dirty_type_penalty
    score = max(0.0, min(100.0, round(100.0 - deductions, 1)))

    return {
        "score": score,
        "breakdown": {
            "missing_cells": missing_cells,
            "missing_pct": round(missing_ratio * 100, 2),
            "missing_penalty": round(missing_penalty, 1),
            "duplicate_rows": dup_rows,
            "duplicate_penalty": round(dup_penalty, 1),
            "constant_columns": constant_cols,
            "constant_penalty": round(const_penalty, 1),
            "severe_missing_columns": severe_cols,
            "severe_missing_penalty": round(severe_missing_penalty, 1),
            "dirty_type_penalty": round(dirty_type_penalty, 1),
            "total_deductions": round(deductions, 1)
        }
    }


def compute_forecast_readiness_score(
    df: pd.DataFrame,
    date_col: str,
    target_col: str,
    frequency: str = None
) -> Dict[str, Any]:
    """
    Evaluates whether the dataset is ready for time-series forecasting.
    Produces a Forecast Readiness Score (0-100) and an explainable checklist
    with pass/warn/fail status for each dimension.

    Checklist Dimensions:
    1. Observation Count (25 pts): >=50 (pass), 30-49 (warn), <30 (fail)
    2. Target Completeness & Variance (25 pts): no nulls, std > 0
    3. Temporal Monotonicity & Completeness (25 pts): date strictly increasing, 0 nulls
    4. Frequency Regularity (15 pts): uniform time delta between steps
    5. Outlier Control (10 pts): values bounded and clean
    """
    checklist: List[Dict[str, Any]] = []
    points = 0.0

    total_rows = len(df)

    # 1. Observation Count (Max 25 pts)
    if total_rows >= 50:
        points += 25.0
        checklist.append({
            "check": "Observation Count",
            "status": "pass",
            "score": 25,
            "max_score": 25,
            "reason": f"Sufficient observations for statistical & ML forecasting ({total_rows} rows)."
        })
    elif total_rows >= 30:
        points += 15.0
        checklist.append({
            "check": "Observation Count",
            "status": "warn",
            "score": 15,
            "max_score": 25,
            "reason": f"Moderate observation count ({total_rows} rows). Recommended >= 50 for deep models."
        })
    else:
        points += 0.0
        checklist.append({
            "check": "Observation Count",
            "status": "fail",
            "score": 0,
            "max_score": 25,
            "reason": f"Insufficient observations ({total_rows} rows). At least 30 rows required for time-series forecasting."
        })

    # 2. Target Column Completeness & Variance (Max 25 pts)
    if target_col not in df.columns:
        checklist.append({
            "check": "Target Column Integrity",
            "status": "fail",
            "score": 0,
            "max_score": 25,
            "reason": f"Target column '{target_col}' not found in dataset."
        })
    else:
        target_series = pd.to_numeric(df[target_col], errors='coerce')
        target_nulls = int(target_series.isna().sum())
        std_val = float(target_series.std()) if len(target_series) > 1 else 0.0

        if target_nulls > 0:
            checklist.append({
                "check": "Target Column Integrity",
                "status": "fail",
                "score": 5,
                "max_score": 25,
                "reason": f"Target column '{target_col}' contains {target_nulls} missing values."
            })
            points += 5.0
        elif np.isnan(std_val) or std_val <= 1e-9:
            checklist.append({
                "check": "Target Column Integrity",
                "status": "fail",
                "score": 5,
                "max_score": 25,
                "reason": f"Target column '{target_col}' is constant (zero variance). Cannot forecast flat signal."
            })
            points += 5.0
        else:
            points += 25.0
            checklist.append({
                "check": "Target Column Integrity",
                "status": "pass",
                "score": 25,
                "max_score": 25,
                "reason": f"Target '{target_col}' is complete, non-zero variance (std={round(std_val, 2)}), with 0 missing values."
            })

    # 3. Temporal Monotonicity & Completeness (Max 25 pts)
    if date_col not in df.columns:
        checklist.append({
            "check": "Temporal Index Integrity",
            "status": "fail",
            "score": 0,
            "max_score": 25,
            "reason": f"Date column '{date_col}' not found."
        })
    else:
        date_series = pd.to_datetime(df[date_col], errors='coerce')
        date_nulls = int(date_series.isna().sum())
        is_monotonic = bool(date_series.is_monotonic_increasing)
        has_duplicate_dates = bool(date_series.duplicated().any())

        if date_nulls > 0:
            checklist.append({
                "check": "Temporal Index Integrity",
                "status": "fail",
                "score": 5,
                "max_score": 25,
                "reason": f"Date column contains {date_nulls} invalid or unparseable timestamps."
            })
            points += 5.0
        elif has_duplicate_dates:
            checklist.append({
                "check": "Temporal Index Integrity",
                "status": "warn",
                "score": 15,
                "max_score": 25,
                "reason": f"Date column contains duplicate timestamps. Timestamp aggregation recommended."
            })
            points += 15.0
        elif not is_monotonic:
            checklist.append({
                "check": "Temporal Index Integrity",
                "status": "warn",
                "score": 15,
                "max_score": 25,
                "reason": f"Timeline is not sorted in strictly ascending chronological order."
            })
            points += 15.0
        else:
            points += 25.0
            checklist.append({
                "check": "Temporal Index Integrity",
                "status": "pass",
                "score": 25,
                "max_score": 25,
                "reason": "Date index is strictly monotonic increasing with 0 nulls and unique timestamps."
            })

    # 4. Frequency Regularity (Max 15 pts)
    if date_col in df.columns:
        dates = pd.to_datetime(df[date_col], errors='coerce').dropna()
        if len(dates) > 2:
            diffs = dates.diff().dropna()
            unique_diff_counts = diffs.value_counts()
            dominant_diff_ratio = unique_diff_counts.iloc[0] / len(diffs) if len(diffs) > 0 else 0

            if dominant_diff_ratio >= 0.90:
                points += 15.0
                checklist.append({
                    "check": "Frequency Regularity",
                    "status": "pass",
                    "score": 15,
                    "max_score": 15,
                    "reason": f"Regular interval frequency detected ({round(dominant_diff_ratio * 100, 1)}% uniform spacing: {frequency or 'detected'})."
                })
            elif dominant_diff_ratio >= 0.70:
                points += 10.0
                checklist.append({
                    "check": "Frequency Regularity",
                    "status": "warn",
                    "score": 10,
                    "max_score": 15,
                    "reason": f"Slightly irregular intervals detected ({round(dominant_diff_ratio * 100, 1)}% uniform). Time-series alignment applied."
                })
            else:
                points += 5.0
                checklist.append({
                    "check": "Frequency Regularity",
                    "status": "warn",
                    "score": 5,
                    "max_score": 15,
                    "reason": "Variable time intervals detected between consecutive observations."
                })
        else:
            checklist.append({
                "check": "Frequency Regularity",
                "status": "warn",
                "score": 5,
                "max_score": 15,
                "reason": "Insufficient dates to determine interval frequency."
            })
            points += 5.0

    # 5. Outlier Control & Bounding (Max 10 pts)
    if target_col in df.columns:
        target_series = pd.to_numeric(df[target_col], errors='coerce').dropna()
        if len(target_series) >= 10:
            q1 = target_series.quantile(0.25)
            q3 = target_series.quantile(0.75)
            iqr = q3 - q1
            if iqr > 0:
                outliers = target_series[(target_series < q1 - 3 * iqr) | (target_series > q3 + 3 * iqr)]
                if len(outliers) == 0:
                    points += 10.0
                    checklist.append({
                        "check": "Outlier Containment",
                        "status": "pass",
                        "score": 10,
                        "max_score": 10,
                        "reason": "No extreme unbounded anomalies detected in target series."
                    })
                else:
                    points += 6.0
                    checklist.append({
                        "check": "Outlier Containment",
                        "status": "warn",
                        "score": 6,
                        "max_score": 10,
                        "reason": f"Detected {len(outliers)} extreme value(s) in target column outside 3x IQR envelope."
                    })
            else:
                points += 10.0
                checklist.append({
                    "check": "Outlier Containment",
                    "status": "pass",
                    "score": 10,
                    "max_score": 10,
                    "reason": "Target variance is tight with no outlier spread."
                })
        else:
            points += 10.0
            checklist.append({
                "check": "Outlier Containment",
                "status": "pass",
                "score": 10,
                "max_score": 10,
                "reason": "Sample size too small for statistical outlier isolation."
            })

    final_score = max(0.0, min(100.0, round(points, 1)))

    # Determine overall status
    has_fail = any(item["status"] == "fail" for item in checklist)
    has_warn = any(item["status"] == "warn" for item in checklist)

    if has_fail:
        overall_status = "FAIL"
    elif has_warn:
        overall_status = "WARN"
    else:
        overall_status = "READY"

    return {
        "readiness_score": final_score,
        "overall_status": overall_status,
        "checklist": checklist
    }
