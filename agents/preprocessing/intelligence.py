"""Deterministic explanations and diagnostics for preprocessing reports."""

import math
import re
import numpy as np
import pandas as pd


def _round(value, digits=1):
    return round(float(value), digits) if pd.notna(value) and math.isfinite(float(value)) else 0.0


def detect_roles(df):
    """Rank date/target candidates without silently promoting ID-like columns."""
    dates, targets, dimensions = [], [], []
    n = len(df)
    for col in df.columns:
        s = df[col]
        name = str(col).lower()
        tokens = set(re.split(r"[^a-z0-9]+", name))
        missing = float(s.isna().mean()) if n else 1.0
        distinct = int(s.nunique(dropna=True))
        valid = s.dropna()
        date_name = bool(tokens & {"date", "time", "timestamp", "day", "month", "year", "period", "dt"})
        parsed = pd.to_datetime(valid.head(100), errors="coerce", format="mixed") if date_name or not pd.api.types.is_numeric_dtype(s) else pd.Series(dtype="datetime64[ns]")
        parseability = float(parsed.notna().mean()) if len(parsed) else 0.0
        chronological = float(parsed.dropna().is_monotonic_increasing) if len(parsed.dropna()) > 1 else 0.0
        date_score = min(100, round(35 * date_name + 35 * parseability + 10 * min(1, distinct / max(1, n * .5)) + 10 * chronological + 10 * (1 - missing)))
        if date_name or parseability >= .8:
            dates.append({"column": col, "confidence": date_score, "reasons": [r for ok, r in [(date_name, "Date-like name"), (parseability >= .8, "Values parse as dates"), (chronological == 1, "Chronological order"), (missing < .1, "Low missingness")] if ok]})

        numeric = pd.to_numeric(s, errors="coerce")
        numeric_rate = float(numeric.notna().sum() / max(1, valid.size))
        id_like = bool(tokens & {"id", "identifier", "key", "code"}) or name.endswith("_id")
        target_name = bool(tokens & {"sales", "revenue", "demand", "quantity", "amount", "orders", "units", "count", "total", "volume", "profit", "gmv", "price", "target"})
        variation = numeric.dropna().nunique() > 1
        sequential_id = False
        if id_like and len(numeric.dropna()) > 2:
            ordered = numeric.dropna().to_numpy(dtype=float)
            sequential_id = bool(np.allclose(np.diff(ordered), 1))
        target_score = max(0, min(100, round(25 * (numeric_rate >= .9) + 35 * target_name + 15 * variation + 15 * (1 - missing) + 10 * (distinct >= 3) - 70 * id_like - 15 * sequential_id - 40 * date_name)))
        if numeric_rate >= .7 and not date_name:
            targets.append({"column": col, "confidence": target_score, "reasons": [r for ok, r in [(numeric_rate >= .9, "Numeric values"), (target_name, "Target-like name"), (variation, "Good variation"), (missing < .1, "Low missingness"), (id_like, "ID-like column: review required")] if ok]})

        business_name = bool(tokens & {"store", "product", "region", "category", "segment", "channel", "brand", "market", "branch"})
        if not date_name and not target_name and (business_name or (not pd.api.types.is_numeric_dtype(s) and 1 < distinct < max(3, n * .5))):
            dimensions.append({"column": col, "confidence": min(98, round(55 + 25 * business_name + 15 * (1 - missing))), "reasons": ["Business dimension name" if business_name else "Repeated categories"]})
    dates.sort(key=lambda item: item["confidence"], reverse=True)
    targets.sort(key=lambda item: item["confidence"], reverse=True)
    dimensions.sort(key=lambda item: item["confidence"], reverse=True)
    return {"date_candidates": dates, "target_candidates": targets, "business_dimensions": dimensions}


def time_health(df, date_col, target_col, frequency=None):
    dates = pd.to_datetime(df[date_col], errors="coerce") if date_col in df else pd.Series(dtype="datetime64[ns]")
    freq = str(frequency or "").upper()
    if freq.startswith("W"):
        dates = dates.dt.to_period(freq if "-" in freq else "W-SUN").dt.end_time.dt.normalize()
    elif freq in ("MS", "QS", "YS"):
        dates = dates.dt.to_period({"MS": "M", "QS": "Q", "YS": "Y"}[freq]).dt.to_timestamp()
    invalid = int(dates.isna().sum())
    valid = dates.dropna().sort_values().drop_duplicates()
    duplicates = int(dates.dropna().duplicated().sum())
    target = pd.to_numeric(df[target_col], errors="coerce") if target_col in df else pd.Series(dtype=float)
    result = {"invalid_dates": invalid, "duplicate_dates": duplicates, "missing_periods": 0, "missing_dates": [], "largest_gap": 0, "longest_continuous_run": len(valid), "expected_observations": len(valid), "observed_observations": len(valid), "date_start": str(valid.iloc[0].date()) if len(valid) else None, "date_end": str(valid.iloc[-1].date()) if len(valid) else None, "frequency": frequency or "unknown", "target_constant": target.dropna().nunique() <= 1, "sufficient_history": len(valid) >= 24, "frequency_regular": True}
    if len(valid) < 2 or not frequency or frequency == "irregular":
        return result
    try:
        calendar = pd.date_range(valid.iloc[0], valid.iloc[-1], freq=frequency)
        observed = set(valid)
        present = [point in observed for point in calendar]
        gaps = [point for point, seen in zip(calendar, present) if not seen]
        result["expected_observations"] = len(calendar)
        result["observed_observations"] = sum(present)
        result["missing_periods"] = len(gaps)
        result["frequency_regular"] = len(gaps) == 0
        result["missing_dates"] = [str(point.date()) for point in gaps[:500]]
        run = longest = gap = largest = 0
        for seen in present:
            if seen:
                run += 1
                longest = max(longest, run)
                gap = 0
            else:
                gap += 1
                largest = max(largest, gap)
                run = 0
        result["largest_gap"] = largest
        result["longest_continuous_run"] = longest
    except (TypeError, ValueError):
        pass
    return result


def forecastability(df, date_col, target_col, frequency):
    y = pd.to_numeric(df[target_col], errors="coerce").dropna() if target_col in df else pd.Series(dtype=float)
    n = len(y)
    if n < 2:
        return {"score": 0, "trend": "Unknown", "seasonality": "Unknown", "variation": "Insufficient", "history": n, "autocorrelation": "Unknown", "details": {}}
    values = y.to_numpy(dtype=float)
    mean_abs = max(abs(float(np.mean(values))), 1e-9)
    cv = float(np.std(values) / mean_abs)
    slope = float(np.polyfit(np.arange(n), values, 1)[0]) if n > 2 else 0.0
    trend_strength = abs(slope * n) / max(float(np.std(values)), 1e-9)
    lag = {"D": 7, "W": 52, "M": 12, "Q": 4}.get(str(frequency or "D")[0].upper(), 1)
    def corr(k):
        if n <= 2 * k or np.std(values[:-k]) < 1e-9 or np.std(values[k:]) < 1e-9:
            return 0.0
        return float(np.corrcoef(values[:-k], values[k:])[0, 1])
    autocorr = corr(1)
    seasonal = corr(lag) if lag > 1 else 0.0
    valid_variation = np.isfinite(cv) and cv > 1e-6
    regular = not pd.to_datetime(df[date_col], errors="coerce").isna().any() and not df[date_col].duplicated().any()
    score = min(100, round(25 * min(1, n / 50) + 20 * valid_variation + 20 * regular + 15 * min(1, abs(autocorr) / .3) + 20 * min(1, abs(seasonal) / .4)))
    return {"score": score, "trend": "Strong" if trend_strength >= 1 else "Weak", "seasonality": "Detected" if abs(seasonal) >= .4 else "Not detected", "variation": "Good" if valid_variation else "Insufficient", "history": n, "autocorrelation": "Strong" if abs(autocorr) >= .5 else "Moderate" if abs(autocorr) >= .2 else "Weak", "details": {"coefficient_of_variation": _round(cv, 3), "trend_slope_per_period": _round(slope, 4), "lag_1_correlation": _round(autocorr, 3), "seasonal_lag": lag, "seasonal_correlation": _round(seasonal, 3), "score_method": "Deterministic heuristic: history 25, variation 20, date integrity 20, autocorrelation 15, seasonal correlation 20"}}
