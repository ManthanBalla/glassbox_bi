"""
Preprocessing Pipeline for GlassBox-BI Data Preprocessing Agent.
Executes a 10-step, time-series aware, explainable transformation pipeline.
DOES NOT normalize/scale data (leaves scaling to Forecasting Agent).
"""

import os
import re
import csv
import json
import logging
from typing import Dict, Any, List, Optional, Tuple
import pandas as pd
import numpy as np

from formulas import compute_data_quality_score, compute_forecast_readiness_score
from intelligence import detect_roles, time_health, forecastability

logger = logging.getLogger("preprocessing_pipeline")


def to_snake_case(text: str) -> str:
    """Normalizes string to clean snake_case."""
    s = re.sub(r'[\s\-]+', '_', text.strip())
    s = re.sub(r'[^\w_]', '', s)
    s = re.sub(r'__+', '_', s)
    return s.strip('_').lower()


def period_anchor(dates: pd.Series, frequency: str) -> pd.Series:
    """Map observations to a calendar bucket for fixed reporting frequencies."""
    parsed = pd.to_datetime(dates, errors="coerce")
    freq = str(frequency).upper()
    if freq.startswith("W"):
        suffix = freq if "-" in freq else "W-SUN"
        return parsed.dt.to_period(suffix).dt.end_time.dt.normalize()
    period = "M" if freq == "MS" else "Q" if freq == "QS" else "Y" if freq == "YS" else None
    return parsed.dt.to_period(period).dt.to_timestamp() if period else parsed


def aggregate_periods(df: pd.DataFrame, date_col: str, target_col: str, method: str) -> pd.DataFrame:
    aggregation = {}
    for col in df.columns:
        if col == date_col:
            continue
        if col == target_col:
            aggregation[col] = (lambda values: values.sum(min_count=1)) if method == "sum" else method
        elif pd.api.types.is_numeric_dtype(df[col]):
            aggregation[col] = "mean"
        else:
            aggregation[col] = "first"
    return df.groupby(date_col, as_index=False).agg(aggregation)


class PreprocessingPipeline:
    def __init__(self, file_path: str, user_id: str, job_id: str, config: Optional[Dict[str, Any]] = None):
        self.file_path = file_path
        self.user_id = str(user_id)
        self.job_id = str(job_id)
        self.config = config or {}
        self.audit_log: List[Dict[str, Any]] = []
        self.step_counter = 0

        # State tracking
        self.df_raw: Optional[pd.DataFrame] = None
        self.df_cleaned: Optional[pd.DataFrame] = None
        self.profile_before: Dict[str, Any] = {}
        self.profile_after: Dict[str, Any] = {}
        self.date_col: Optional[str] = None
        self.target_col: Optional[str] = None
        self.frequency: Optional[str] = None
        self.detected_date_col: Optional[str] = None
        self.suggested_target_col: Optional[str] = None
        self.role_analysis: Dict[str, Any] = {}
        self.evaluation_source: Optional[pd.DataFrame] = None
        self.outlier_events: List[Dict[str, Any]] = []
        self.gap_report: Dict[str, Any] = {}
        self.raw_chart: List[Dict[str, Any]] = []
        self.invalid_dates_before = 0
        self.duplicate_dates_before = 0
        self.outlier_count = 0

    def _log_action(self, step_name: str, column_name: str, action: str, method: str, rows_affected: int, description: str, before=None, after=None, reason=None):
        self.step_counter += 1
        entry = {
            "step_order": self.step_counter,
            "step_name": step_name,
            "column_name": column_name or "ALL",
            "action": action,
            "method": method,
            "rows_affected": int(rows_affected),
            "description": description
        }
        entry.update({"reason": reason or description, "before": before, "after": after})
        self.audit_log.append(entry)
        logger.info(f"[{step_name}] {description}")

    def _write_progress(self, output_dir: str, stage: str):
        os.makedirs(output_dir, exist_ok=True)
        path = os.path.join(output_dir, "progress.json")
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"stage": stage}, handle)
        os.replace(temporary, path)

    # -------------------------------------------------------------
    # STEP 1: LOAD
    # -------------------------------------------------------------
    def step1_load(self, sheet_name: Optional[str] = None, max_rows: int = 500000) -> pd.DataFrame:
        if not os.path.exists(self.file_path):
            raise FileNotFoundError(f"Dataset file not found at: {self.file_path}")

        ext = os.path.splitext(self.file_path)[1].lower()

        if ext in ['.xlsx', '.xls']:
            with pd.ExcelFile(self.file_path, engine='openpyxl' if ext == '.xlsx' else None) as excel_file:
                available_sheets = excel_file.sheet_names
                chosen_sheet = sheet_name if sheet_name and sheet_name in available_sheets else available_sheets[0]
                df = pd.read_excel(excel_file, sheet_name=chosen_sheet, nrows=max_rows)
            self._log_action(
                "LOAD", "ALL", "READ_EXCEL", "OPENPYXL", len(df),
                f"Loaded Excel dataset from sheet '{chosen_sheet}' with {len(df)} rows and {len(df.columns)} columns."
            )
        else:
            # CSV Handling with encoding and delimiter detection
            encoding = 'utf-8'
            delimiter = ','
            try:
                with open(self.file_path, 'rb') as f:
                    raw_bytes = f.read(16384)
                    for enc in ['utf-8', 'utf-8-sig', 'latin-1', 'cp1252']:
                        try:
                            raw_bytes.decode(enc)
                            encoding = enc
                            break
                        except UnicodeDecodeError:
                            continue

                with open(self.file_path, 'r', encoding=encoding, errors='ignore') as f:
                    sample_text = f.read(8192)
                    try:
                        dialect = csv.Sniffer().sniff(sample_text, delimiters=[',', ';', '\t', '|'])
                        delimiter = dialect.delimiter
                    except Exception:
                        delimiter = ','
            except Exception as e:
                logger.warning(f"CSV sniffing note: {e}, falling back to default utf-8 and comma delimiter.")

            df = pd.read_csv(self.file_path, delimiter=delimiter, encoding=encoding, nrows=max_rows, low_memory=False)
            self._log_action(
                "LOAD", "ALL", "READ_CSV", f"ENCODING_{encoding.upper()}_DELIMITER_{repr(delimiter)}", len(df),
                f"Loaded CSV dataset using {encoding} encoding and '{delimiter}' delimiter with {len(df)} rows and {len(df.columns)} columns."
            )

        if len(df) > max_rows:
            df = df.iloc[:max_rows]
            self._log_action(
                "LOAD", "ALL", "TRUNCATE_ROWS", "MAX_LIMIT", max_rows,
                f"Dataset truncated to maximum processing limit of {max_rows} rows."
            )

        self.df_raw = df.copy()
        return df

    # -------------------------------------------------------------
    # STEP 2: PROFILE (BEFORE CLEANING)
    # -------------------------------------------------------------
    def step2_profile(self, df: pd.DataFrame) -> Dict[str, Any]:
        total_rows = len(df)
        total_cols = len(df.columns)
        dup_rows = int(df.duplicated().sum())

        column_profiles = []
        constant_columns = []

        for col in df.columns:
            s = df[col]
            missing_count = int(s.isna().sum())
            missing_pct = round((missing_count / total_rows) * 100, 2) if total_rows > 0 else 0
            unique_count = int(s.nunique(dropna=False))

            col_info = {
                "name": str(col),
                "dtype": str(s.dtype),
                "missing_count": missing_count,
                "missing_pct": missing_pct,
                "unique_count": unique_count,
                "sample_values": [str(v) if pd.notna(v) else None for v in s.dropna().head(3).tolist()]
            }

            if pd.api.types.is_numeric_dtype(s):
                valid_num = s.dropna()
                if len(valid_num) > 0:
                    col_info["min"] = round(float(valid_num.min()), 2)
                    col_info["max"] = round(float(valid_num.max()), 2)
                    col_info["mean"] = round(float(valid_num.mean()), 2)
                    col_info["std"] = round(float(valid_num.std()), 2) if len(valid_num) > 1 else 0.0

            if unique_count <= 1:
                constant_columns.append(str(col))

            column_profiles.append(col_info)

        quality = compute_data_quality_score(df)

        profile = {
            "total_rows": total_rows,
            "total_columns": total_cols,
            "duplicate_rows": dup_rows,
            "constant_columns": constant_columns,
            "quality_score": quality["score"],
            "quality_breakdown": quality["breakdown"],
            "columns": column_profiles,
            "sample_rows": df.head(5).replace({np.nan: None}).to_dict(orient="records")
        }

        self.profile_before = profile
        self._log_action(
            "PROFILE", "ALL", "CALCULATE_METRICS", "PROFILE_BEFORE", total_rows,
            f"Profiled dataset: {total_rows} rows, {total_cols} columns, {dup_rows} duplicates. Initial Data Quality Score: {quality['score']}/100."
        )
        return profile

    # -------------------------------------------------------------
    # STEP 3: STANDARDIZE
    # -------------------------------------------------------------
    def step3_standardize(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()

        # 1. Normalize column names to snake_case
        old_cols = list(df.columns)
        new_cols = [to_snake_case(str(c)) for c in old_cols]
        # Guarantee unique column names if collision
        unique_cols = []
        counts = {}
        for c in new_cols:
            if not c:
                c = "col"
            if c in counts:
                counts[c] += 1
                unique_cols.append(f"{c}_{counts[c]}")
            else:
                counts[c] = 1
                unique_cols.append(c)

        renamed_count = sum(1 for o, n in zip(old_cols, unique_cols) if str(o) != n)
        df.columns = unique_cols

        if renamed_count > 0:
            self._log_action(
                "STANDARDIZE", "ALL", "NORMALIZE_HEADERS", "SNAKE_CASE", renamed_count,
                f"Normalized {renamed_count} column header(s) to standardized snake_case format."
            )

        # 2. Trim whitespace on string cells & standardize placeholders to NaN
        placeholder_values = {'n/a', 'na', 'null', 'none', '-', '?', '', 'nan', '<na>'}

        for col in df.columns:
            if df[col].dtype == object or pd.api.types.is_string_dtype(df[col]):
                # Strip leading/trailing whitespaces
                s_str = df[col].astype(str).str.strip()
                # Check for placeholders
                mask_placeholder = s_str.str.lower().isin(placeholder_values)
                if mask_placeholder.any():
                    count_replaced = int(mask_placeholder.sum())
                    df.loc[mask_placeholder, col] = np.nan
                    self._log_action(
                        "STANDARDIZE", col, "REPLACE_PLACEHOLDERS", "TO_NAN", count_replaced,
                        f"Converted {count_replaced} text placeholder(s) in '{col}' to standard null/NaN."
                    )
                else:
                    df[col] = s_str

                # Try numeric conversion for dirty currencies/percentages
                sample_valid = df[col].dropna().astype(str)
                if len(sample_valid) > 0:
                    clean_pattern = sample_valid.str.replace(r'[$€£¥,%\s]', '', regex=True)
                    # Check if at least 70% convert to float
                    converted = pd.to_numeric(clean_pattern, errors='coerce')
                    if converted.notna().mean() >= 0.70 and converted.notna().sum() >= 2:
                        # Full column cleaning
                        cleaned_full = df[col].dropna().astype(str).str.replace(r'[$€£¥,%\s]', '', regex=True)
                        df[col] = pd.to_numeric(cleaned_full, errors='coerce')
                        self._log_action(
                            "STANDARDIZE", col, "CAST_NUMERIC", "REGEX_STRIP_SYMBOLS", int(df[col].notna().sum()),
                            f"Standardized dirty strings (currency/percentages/commas) in column '{col}' into clean numeric floats."
                        )

        # 3. Convert boolean-like text
        bool_map = {'true': True, 'yes': True, '1': True, 'y': True, 'false': False, 'no': False, '0': False, 'n': False}
        for col in df.columns:
            if df[col].dtype == object:
                sample_s = df[col].dropna().astype(str).str.strip().str.lower()
                if len(sample_s) > 0 and sample_s.isin(bool_map.keys()).mean() >= 0.90:
                    df[col] = sample_s.map(bool_map)
                    self._log_action(
                        "STANDARDIZE", col, "CAST_BOOLEAN", "BOOL_MAPPING", len(sample_s),
                        f"Converted boolean-like text in column '{col}' into standard boolean values."
                    )

        return df

    # -------------------------------------------------------------
    # STEP 4: DETECT COLUMNS
    # -------------------------------------------------------------
    def step4_detect_columns(self, df: pd.DataFrame) -> Tuple[Optional[str], Optional[str]]:
        self.role_analysis = detect_roles(df)
        date_candidates: List[Tuple[str, float]] = []
        target_candidates: List[Tuple[str, float]] = []

        date_keywords = ['date', 'time', 'timestamp', 'dt', 'day', 'month', 'year', 'period']
        target_keywords = ['sales', 'revenue', 'demand', 'quantity', 'amount', 'orders', 'units', 'count', 'total', 'volume', 'price', 'metric']

        primary_target_keywords = {'sales', 'revenue', 'demand', 'target', 'volume', 'profit', 'gmv', 'turnover'}
        secondary_target_keywords = {'quantity', 'units', 'orders', 'amount', 'total', 'count', 'price', 'metric'}
        discount_penalty_keywords = {'discount', 'pct', 'percent', 'percentage', 'rate', 'ratio', 'flag', 'status'}

        for col in df.columns:
            col_lower = col.lower()
            tokens = set(re.split(r'[\W_]+', col_lower))
            s = df[col]

            # 1. Date Detection
            score_date = 0.0
            for kw in date_keywords:
                if kw in tokens or kw in col_lower:
                    score_date += 3.0

            if pd.api.types.is_datetime64_any_dtype(s):
                score_date += 10.0
            elif s.dtype == object or pd.api.types.is_string_dtype(s):
                # Sample 30 items and test date parsing
                sample = s.dropna().head(30)
                if len(sample) > 5:
                    parsed = pd.to_datetime(sample, errors='coerce', format='mixed')
                    parse_rate = parsed.notna().mean()
                    score_date += parse_rate * 5.0

            if score_date > 2.0:
                date_candidates.append((col, score_date))

            # 2. Target Detection (Must be numeric)
            score_target = 0.0
            if pd.api.types.is_numeric_dtype(s):
                valid = s.dropna()
                if len(valid) > 5:
                    std_val = float(valid.std()) if len(valid) > 1 else 0.0
                    if std_val > 1e-6:
                        score_target += 2.0
                        # Check tokens
                        if any(kw in tokens for kw in primary_target_keywords):
                            score_target += 8.0
                        elif any(kw in tokens for kw in secondary_target_keywords):
                            score_target += 4.0

                        if any(kw in tokens for kw in discount_penalty_keywords):
                            score_target -= 2.0

                        # Prefer columns with low missing rate
                        missing_rate = s.isna().mean()
                        score_target += (1.0 - missing_rate) * 2.0
                        target_candidates.append((col, score_target))

        # Select top candidates
        date_candidates.sort(key=lambda x: x[1], reverse=True)
        target_candidates.sort(key=lambda x: x[1], reverse=True)

        date_ranked = self.role_analysis["date_candidates"]
        target_ranked = self.role_analysis["target_candidates"]
        self.detected_date_col = date_ranked[0]["column"] if date_ranked and date_ranked[0]["confidence"] >= 50 else None
        self.suggested_target_col = target_ranked[0]["column"] if target_ranked and target_ranked[0]["confidence"] >= 35 else None

        self._log_action(
            "DETECT_COLUMNS", "ALL", "AUTO_DETECT", "HEURISTIC_KEYWORD_DTYPE", 1,
            f"Detected candidate date column: '{self.detected_date_col}' and suggested target column: '{self.suggested_target_col}'."
        )
        return self.detected_date_col, self.suggested_target_col

    # -------------------------------------------------------------
    # STEP 5: DUPLICATES
    # -------------------------------------------------------------
    def step5_duplicates(self, df: pd.DataFrame, date_col: str, target_col: str, agg_method: str = "sum") -> pd.DataFrame:
        df = df.copy()

        # 1. Exact duplicate rows
        exact_dups = int(df.duplicated().sum())
        if exact_dups > 0:
            df = df.drop_duplicates().reset_index(drop=True)
            self._log_action(
                "DUPLICATES", "ALL", "REMOVE_EXACT_DUPLICATES", "DROP_DUPLICATES", exact_dups,
                f"Removed {exact_dups} exact duplicate row(s).", before=len(df) + exact_dups, after=len(df), reason="Identical rows would double-count the same observation."
            )
        else:
            self._log_action(
                "DUPLICATES", "ALL", "CHECK_EXACT_DUPLICATES", "NONE_FOUND", 0,
                "No exact duplicate rows found in dataset."
            )

        # 2. Duplicate timestamps in date column
        if date_col in df.columns:
            # Parse dates first to ensure consistent timestamp grouping
            df[date_col] = pd.to_datetime(df[date_col], errors='coerce')
            dup_dates = int(df[date_col].duplicated().sum())

            if dup_dates > 0:
                agg_dict = {}
                for col in df.columns:
                    if col == date_col:
                        continue
                    if col == target_col:
                        agg_dict[col] = agg_method if agg_method in ['sum', 'mean', 'max', 'min', 'first'] else 'sum'
                    elif pd.api.types.is_numeric_dtype(df[col]):
                        agg_dict[col] = 'mean'
                    else:
                        agg_dict[col] = 'first'

                rows_before_agg = len(df)
                df = df.groupby(date_col, as_index=False).agg(agg_dict)
                rows_consolidated = rows_before_agg - len(df)

                self._log_action(
                    "DUPLICATES", date_col, "AGGREGATE_TIMESTAMPS", f"GROUPBY_{agg_method.upper()}", rows_consolidated,
                    f"Consolidated {dup_dates} duplicate timestamp(s) by grouping on '{date_col}' (target '{target_col}' aggregated via {agg_method}).", before=rows_before_agg, after=len(df), reason="A forecast series needs one target observation per timestamp."
                )

        return df

    # -------------------------------------------------------------
    # STEP 6: MISSING VALUES
    # -------------------------------------------------------------
    def step6_missing_values(self, df: pd.DataFrame, date_col: str, target_col: str, drop_threshold_pct: float = 60.0) -> pd.DataFrame:
        df = df.copy()
        total_rows = len(df)

        # 1. Drop columns exceeding missing threshold
        cols_to_drop = []
        for col in df.columns:
            if col in [date_col, target_col]:
                continue
            missing_ratio = (df[col].isna().sum() / total_rows) * 100 if total_rows > 0 else 0
            if missing_ratio >= drop_threshold_pct:
                cols_to_drop.append((col, missing_ratio))

        if cols_to_drop:
            for col, pct in cols_to_drop:
                df = df.drop(columns=[col])
                self._log_action(
                    "MISSING_VALUES", col, "DROP_COLUMN", f"THRESHOLD_{drop_threshold_pct}%", int((pct / 100) * total_rows),
                    f"Dropped column '{col}' due to excessive missingness ({round(pct, 1)}% >= threshold {drop_threshold_pct}%).", before=f"{round(pct, 1)}% missing", after="Column removed", reason="Supporting column met the configured missingness threshold."
                )

        # 2. Impute target & time-series columns (Linear Interpolation + ffill/bfill)
        if target_col in df.columns:
            target_nulls = int(df[target_col].isna().sum())
            if target_nulls > 0:
                strategy = self.config.get("imputation_strategy", "linear")
                target_values = pd.to_numeric(df[target_col], errors='coerce')
                df[target_col] = target_values.ffill() if strategy == "forward_fill" else target_values.interpolate(method='linear')
                # Boundary fill for edges
                df[target_col] = df[target_col].bfill().ffill()
                self._log_action(
                    "MISSING_VALUES", target_col, "INTERPOLATE", "FORWARD_FILL" if strategy == "forward_fill" else "LINEAR_INTERPOLATION_EDGE_FILL", target_nulls,
                    f"Filled {target_nulls} missing values in target column '{target_col}' using {strategy.replace('_', ' ')}.", before=f"{target_nulls} missing", after=f"{int(df[target_col].isna().sum())} missing", reason="A continuous target is needed for forecasting."
                )

        # 3. Other numeric columns -> Median
        for col in df.columns:
            if col == target_col or col == date_col:
                continue
            if pd.api.types.is_numeric_dtype(df[col]):
                num_nulls = int(df[col].isna().sum())
                if num_nulls > 0:
                    med_val = df[col].median()
                    df[col] = df[col].fillna(med_val)
                    self._log_action(
                        "MISSING_VALUES", col, "IMPUTE", "MEDIAN", num_nulls,
                        f"Imputed {num_nulls} missing values in numeric column '{col}' with median ({round(float(med_val), 2)})."
                    )

        # 4. Categorical columns -> Mode or 'Unknown'
        for col in df.columns:
            if col == target_col or col == date_col:
                continue
            if not pd.api.types.is_numeric_dtype(df[col]):
                cat_nulls = int(df[col].isna().sum())
                if cat_nulls > 0:
                    modes = df[col].mode(dropna=True)
                    replacement = str(modes.iloc[0]) if len(modes) > 0 else "Unknown"
                    df[col] = df[col].fillna(replacement)
                    self._log_action(
                        "MISSING_VALUES", col, "IMPUTE", "MODE_OR_UNKNOWN", cat_nulls,
                        f"Imputed {cat_nulls} missing values in categorical column '{col}' with '{replacement}'."
                    )

        return df

    # -------------------------------------------------------------
    # STEP 7: OUTLIERS
    # -------------------------------------------------------------
    def step7_outliers(self, df: pd.DataFrame, target_col: str, method: str = "iqr", action: str = "flag") -> pd.DataFrame:
        df = df.copy()

        if target_col not in df.columns or action == "none":
            self._log_action(
                "OUTLIERS", target_col or "ALL", "SKIP", "USER_NONE", 0,
                f"Outlier processing skipped on target column '{target_col}' per configuration."
            )
            return df

        s = pd.to_numeric(df[target_col], errors='coerce')
        if len(s.dropna()) < 10:
            return df

        # Detect bounds
        if method == "zscore":
            mean_val = s.mean()
            std_val = s.std()
            if std_val > 1e-9:
                lower_bound = mean_val - 3.0 * std_val
                upper_bound = mean_val + 3.0 * std_val
            else:
                return df
        else:  # iqr
            q1 = s.quantile(0.25)
            q3 = s.quantile(0.75)
            iqr = q3 - q1
            if iqr <= 0:
                return df
            lower_bound = q1 - 1.5 * iqr
            upper_bound = q3 + 1.5 * iqr

        outliers_mask = (s < lower_bound) | (s > upper_bound)
        outlier_count = int(outliers_mask.sum())
        self.outlier_count = outlier_count
        self.outlier_events = []
        if outlier_count:
            date_name = self.date_col if self.date_col in df.columns else None
            for idx in np.flatnonzero(outliers_mask.to_numpy())[:500]:
                value = float(s.iloc[idx])
                distance = (lower_bound - value) if value < lower_bound else (value - upper_bound)
                width = max(float(upper_bound - lower_bound), 1e-9)
                self.outlier_events.append({"date": str(df.iloc[idx][date_name]) if date_name else None, "value": value, "expected_range": [round(float(lower_bound), 3), round(float(upper_bound), 3)], "severity": "Severe" if distance > width else "Unusual", "action": "Capped" if action == "cap" else "Flagged" if action == "flag" else "Unchanged"})

        if outlier_count > 0:
            if action == "cap":
                df[target_col] = s.clip(lower=lower_bound, upper=upper_bound)
                self._log_action(
                    "OUTLIERS", target_col, "CAP_WINSORIZE", f"{method.upper()}_BOUNDS", outlier_count,
                    f"Capped (winsorized) {outlier_count} extreme outlier(s) in '{target_col}' within range [{round(lower_bound, 2)}, {round(upper_bound, 2)}].", before=f"{outlier_count} outside bounds", after="Values clipped to bounds", reason="User explicitly selected capping."
                )
            elif action == "flag":
                flag_col = f"{target_col}_outlier"
                df[flag_col] = outliers_mask
                self._log_action(
                    "OUTLIERS", target_col, "FLAG_ONLY", f"{method.upper()}_INDICATOR", outlier_count,
                    f"Flagged {outlier_count} outlier(s) in new indicator column '{flag_col}' without modifying values.", before=f"{outlier_count} unusual values", after=f"{outlier_count} flags; original values retained", reason="Business spikes may represent genuine events."
                )
        else:
            self._log_action(
                "OUTLIERS", target_col, "CHECK_OUTLIERS", f"{method.upper()}_SAFE", 0,
                f"No outliers detected in target column '{target_col}' using {method.upper()} bounds."
            )

        return df

    # -------------------------------------------------------------
    # STEP 8: TIME-SERIES ALIGNMENT
    # -------------------------------------------------------------
    def step8_time_series_alignment(self, df: pd.DataFrame, date_col: str, target_col: str, frequency: Optional[str] = None) -> Tuple[pd.DataFrame, str]:
        df = df.copy()

        if date_col not in df.columns:
            return df, "unknown"

        df[date_col] = pd.to_datetime(df[date_col], errors='coerce')
        df = df.dropna(subset=[date_col]).sort_values(by=date_col).reset_index(drop=True)

        inferred_freq = frequency
        if not inferred_freq or inferred_freq.lower() in ['auto', 'infer', 'detect']:
            try:
                inferred = pd.infer_freq(df[date_col])
                if inferred:
                    inferred_freq = inferred
                else:
                    # Estimate based on median interval in days
                    diffs = df[date_col].diff().dropna().dt.total_seconds() / 86400.0
                    median_days = diffs.median() if len(diffs) > 0 else 1.0
                    if median_days <= 1.5:
                        inferred_freq = 'D'
                    elif 5.0 <= median_days <= 8.5:
                        inferred_freq = 'W'
                    elif 25.0 <= median_days <= 35.0:
                        inferred_freq = 'M'
                    elif 80.0 <= median_days <= 100.0:
                        inferred_freq = 'Q'
                    elif median_days >= 350.0:
                        inferred_freq = 'Y'
                    else:
                        inferred_freq = 'D'
            except Exception:
                inferred_freq = 'D'

        # Map friendly frequency names to Pandas offset aliases
        freq_map = {
            'daily': 'D',
            'weekly': 'W',
            'monthly': 'MS',
            'quarterly': 'QS',
            'yearly': 'YS',
            'd': 'D',
            'w': 'W',
            'm': 'MS',
            'q': 'QS',
            'y': 'YS'
        }
        clean_freq = freq_map.get(str(inferred_freq).lower(), inferred_freq or 'D')

        anchored = period_anchor(df[date_col], clean_freq)
        if not anchored.equals(df[date_col]):
            before = len(df)
            df[date_col] = anchored
            df = aggregate_periods(df, date_col, target_col, self.config.get("duplicate_aggregation", "sum"))
            self._log_action("TIME_SERIES_ALIGNMENT", date_col, "AGGREGATE_PERIODS", f"FREQUENCY_{clean_freq}", before - len(df), f"Mapped observations to {clean_freq} calendar periods before filling gaps.", before=before, after=len(df), reason="A fixed reporting frequency requires one observation per period.")

        # Reindex to fill gaps
        start_date = df[date_col].min()
        end_date = df[date_col].max()

        try:
            full_date_range = pd.date_range(start=start_date, end=end_date, freq=clean_freq, name=date_col)
            original_len = len(df)

            # Merge with continuous calendar
            df_reindexed = pd.DataFrame({date_col: full_date_range})
            df = pd.merge(df_reindexed, df, on=date_col, how='left')

            new_periods = len(df) - original_len

            if new_periods > 0:
                # Interpolate target for the inserted gaps
                if target_col in df.columns:
                    target_values = pd.to_numeric(df[target_col], errors='coerce')
                    df[target_col] = target_values.ffill() if self.config.get("imputation_strategy") == "forward_fill" else target_values.interpolate(method='linear')
                    df[target_col] = df[target_col].bfill().ffill()

                # Forward-fill categoricals
                for col in df.columns:
                    if col not in [date_col, target_col]:
                        df[col] = df[col].ffill().bfill()

                self._log_action(
                    "TIME_SERIES_ALIGNMENT", date_col, "FILL_PERIOD_GAPS", f"FREQUENCY_{clean_freq}", new_periods,
                    f"Aligned chronological timeline to regular frequency '{clean_freq}'. Inserted and interpolated {new_periods} missing period(s)."
                )
            else:
                self._log_action(
                    "TIME_SERIES_ALIGNMENT", date_col, "VERIFY_CONTINUITY", f"FREQUENCY_{clean_freq}", 0,
                    f"Timeline is already continuous at frequency '{clean_freq}'. No missing periods detected."
                )
        except Exception as e:
            logger.warning(f"Reindexing note: {e}. Keeping existing date index.")
            clean_freq = 'irregular'

        self.frequency = clean_freq
        return df, clean_freq

    # -------------------------------------------------------------
    # STEP 9: VALIDATE READINESS
    # -------------------------------------------------------------
    def step9_validate_readiness(self, df: pd.DataFrame, date_col: str, target_col: str, frequency: str) -> Dict[str, Any]:
        readiness = compute_forecast_readiness_score(df, date_col, target_col, frequency)
        quality_after = compute_data_quality_score(df)

        self.profile_after = {
            "total_rows": len(df),
            "total_columns": len(df.columns),
            "duplicate_rows": int(df.duplicated().sum()),
            "missing_cells": int(df.isna().sum().sum()),
            "quality_score": quality_after["score"],
            "quality_breakdown": quality_after["breakdown"],
            "readiness_score": readiness["readiness_score"],
            "overall_status": readiness["overall_status"],
            "checklist": readiness["checklist"]
        }

        self._log_action(
            "VALIDATE_READINESS", "ALL", "EVALUATE_FORECAST_READINESS", "SCORE_ASSESSMENT", len(df),
            f"Evaluated readiness: Forecast Readiness Score {readiness['readiness_score']}/100 ({readiness['overall_status']}). Final Data Quality: {quality_after['score']}/100."
        )

        return {
            "readiness": readiness,
            "quality_after": quality_after
        }

    # -------------------------------------------------------------
    # STEP 10: EXPORT
    # -------------------------------------------------------------
    def step10_export(self, df: pd.DataFrame, output_dir: str, date_col: str, target_col: str, readiness_info: Dict[str, Any]) -> Tuple[str, str]:
        os.makedirs(output_dir, exist_ok=True)

        cleaned_csv_path = os.path.join(output_dir, "cleaned_data.csv")
        report_json_path = os.path.join(output_dir, "report.json")

        # Format date column nicely before exporting
        export_df = df.copy()
        if date_col in export_df.columns:
            export_df[date_col] = pd.to_datetime(export_df[date_col], errors='coerce').dt.strftime('%Y-%m-%d %H:%M:%S').str.replace(' 00:00:00', '')

        export_df.to_csv(cleaned_csv_path, index=False)

        # Evaluation source preserves target gaps and original extreme values.
        # The forecasting agent splits this file before learning any imputation/outlier bounds.
        evaluation_path = os.path.join(output_dir, "evaluation_source.csv")
        eval_source = self.evaluation_source[[date_col, target_col]].copy()
        eval_source[date_col] = pd.to_datetime(eval_source[date_col], errors="coerce")
        eval_source = eval_source.dropna(subset=[date_col]).drop_duplicates(subset=[date_col])
        anchored = period_anchor(eval_source[date_col], self.frequency)
        if not anchored.equals(eval_source[date_col]):
            eval_source[date_col] = anchored
            eval_source = aggregate_periods(eval_source, date_col, target_col, self.config.get("duplicate_aggregation", "sum"))
        eval_frame = pd.DataFrame({date_col: pd.to_datetime(df[date_col])}).merge(eval_source, on=date_col, how="left")
        eval_frame.to_csv(evaluation_path, index=False)

        roles = self.role_analysis or detect_roles(df)
        dimensions = [item["column"] for item in roles["business_dimensions"] if item["column"] in df.columns]
        quality = readiness_info["quality_after"]
        qb = quality["breakdown"]
        quality_dimensions = {"completeness": max(0, round(100 - qb.get("missing_penalty", 0) * 2.5)), "consistency": max(0, round(100 - qb.get("constant_penalty", 0) * 4 - qb.get("dirty_type_penalty", 0) * 4)), "validity": max(0, round(100 - 100 * self.profile_after.get("missing_cells", 0) / max(1, df.size))), "uniqueness": max(0, round(100 - qb.get("duplicate_penalty", 0) * 5))}
        readiness = readiness_info["readiness"]
        forecast_analysis = forecastability(df, date_col, target_col, self.frequency)
        before_missing = self.profile_before.get("quality_breakdown", {}).get("missing_cells", 0)
        before_duplicates = self.profile_before.get("duplicate_rows", 0)
        dropped = [a["column_name"] for a in self.audit_log if a["action"] == "DROP_COLUMN"]
        filled = sum(a["rows_affected"] for a in self.audit_log if a["action"] in ("IMPUTE", "INTERPOLATE", "FILL_PERIOD_GAPS"))
        confidence_reasons = ["Valid target" if pd.to_numeric(df[target_col], errors="coerce").notna().all() else "Target needs review", "Regular time series" if self.gap_report.get("missing_periods", 0) == 0 else "Period gaps were filled", "Low missingness" if self.profile_after.get("missing_cells", 0) == 0 else "Missing values remain", "Sufficient history" if len(df) >= 50 else "Limited history"]
        confidence_score = (readiness["readiness_score"] + quality["score"] + forecast_analysis["score"]) / 3
        confidence = {"level": "LOW" if readiness["overall_status"] == "FAIL" else "HIGH" if confidence_score >= 80 and readiness["overall_status"] == "READY" else "MEDIUM" if confidence_score >= 55 else "LOW", "reasons": confidence_reasons}
        contract = {"date_column": date_col, "target_column": target_col, "frequency": self.frequency, "target_type": "numeric", "date_start": str(pd.to_datetime(df[date_col]).min().date()), "date_end": str(pd.to_datetime(df[date_col]).max().date()), "observations": len(df), "business_dimensions": dimensions, "forecast_readiness": readiness["readiness_score"], "version": 1}
        comparison = {"rows": {"before": self.profile_before.get("total_rows"), "after": len(df)}, "missing_values": {"before": before_missing, "after": self.profile_after.get("missing_cells")}, "duplicates": {"before": before_duplicates, "after": self.profile_after.get("duplicate_rows")}, "invalid_dates": {"before": self.invalid_dates_before, "after": 0}, "outliers": {"detected": self.outlier_count, "flagged": self.outlier_count if self.config.get("outlier_action", "flag") == "flag" else 0}}
        recipe = {"duplicates_removed": before_duplicates, "duplicate_timestamps_aggregated": self.duplicate_dates_before, "missing_values_filled": filled, "columns_dropped": dropped, "imputation_strategy": self.config.get("imputation_strategy", "linear"), "outlier_method": self.config.get("outlier_method", "iqr"), "outlier_action": self.config.get("outlier_action", "flag"), "aggregation": self.config.get("duplicate_aggregation", "sum"), "missing_threshold": self.config.get("missing_threshold", 60)}
        metadata = {"version": 1, "evaluation_source": "evaluation_source.csv", "evaluation_policy": "Forecasting holdout uses the unfilled, uncapped target; training imputation and bounds are calculated after chronological split.", "limitations": ["Duplicate timestamp aggregation and calendar alignment are structural operations performed before the forecasting split.", "Forecasting metrics exclude holdout periods with no observed target."]}
        package = {"schema.json": {"columns": [{"name": str(c), "type": str(df[c].dtype), "role": "date" if c == date_col else "target" if c == target_col else "dimension" if c in dimensions else "feature"} for c in df.columns]}, "data_quality.json": quality, "forecast_readiness.json": readiness, "forecastability.json": forecast_analysis, "transformation_log.json": self.audit_log, "data_contract.json": contract, "preprocessing_metadata.json": metadata}
        for name, payload in package.items():
            with open(os.path.join(output_dir, name), "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, default=str)

        # Full structured report
        report_data = {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "source_file": os.path.basename(self.file_path),
            "date_column": date_col,
            "target_column": target_col,
            "frequency": self.frequency,
            "rows_before": self.profile_before.get("total_rows", 0),
            "rows_after": len(export_df),
            "columns_before": self.profile_before.get("total_columns", 0),
            "columns_after": len(export_df.columns),
            "quality_score_before": self.profile_before.get("quality_score", 0.0),
            "quality_score_after": self.profile_after.get("quality_score", 0.0),
            "readiness_score": self.profile_after.get("readiness_score", 0.0),
            "overall_status": self.profile_after.get("overall_status", "UNKNOWN"),
            "checklist": self.profile_after.get("checklist", []),
            "audit_log": self.audit_log,
            "cleaned_csv_path": cleaned_csv_path,
            "sample_cleaned_data": export_df.head(50).replace({np.nan: None}).to_dict(orient="records")
        }
        chart_rows = df.iloc[np.linspace(0, len(df) - 1, min(500, len(df)), dtype=int)] if len(df) else df
        chart_cleaned = [{"date": str(pd.to_datetime(row[date_col]).date()), "value": float(row[target_col]) if pd.notna(row[target_col]) else None} for _, row in chart_rows.iterrows()]
        report_data.update({"role_analysis": roles, "time_health": self.gap_report, "forecastability": forecast_analysis, "processing_confidence": confidence, "comparison": comparison, "outlier_events": self.outlier_events, "transformation_recipe": recipe, "data_contract": contract, "quality_breakdown": quality["breakdown"], "quality_dimensions": quality_dimensions, "raw_chart": self.raw_chart, "chart_cleaned": chart_cleaned, "handoff_files": list(package) + ["cleaned_data.csv", "evaluation_source.csv"], "preprocessing_metadata": metadata})

        self._log_action(
            "EXPORT", "ALL", "WRITE_ARTIFACTS", "CSV_AND_JSON", len(export_df),
            f"Saved cleaned time-series dataset ({len(export_df)} rows) and explainability audit dossier."
        )
        report_data["audit_log"] = self.audit_log
        with open(os.path.join(output_dir, "transformation_log.json"), "w", encoding="utf-8") as handle:
            json.dump(self.audit_log, handle, indent=2, default=str)
        with open(report_json_path, 'w', encoding='utf-8') as f:
            json.dump(report_data, f, indent=2, default=str)

        return cleaned_csv_path, report_json_path

    # -------------------------------------------------------------
    # FULL EXECUTION RUNNER
    # -------------------------------------------------------------
    def run_pipeline(self, output_dir: str) -> Dict[str, Any]:
        # Step 1: LOAD
        self._write_progress(output_dir, "loading")
        sheet = self.config.get("sheet_name")
        df = self.step1_load(sheet_name=sheet)

        # Step 2: PROFILE
        self._write_progress(output_dir, "profiling")
        self.step2_profile(df)

        # Step 3: STANDARDIZE
        self._write_progress(output_dir, "cleaning")
        df = self.step3_standardize(df)

        # Step 4: DETECT COLUMNS
        detected_date, suggested_target = self.step4_detect_columns(df)
        date_col = self.config.get("date_column") or detected_date
        target_col = self.config.get("target_column") or suggested_target

        if not date_col or date_col not in df.columns:
            # Fallback to first column
            date_col = df.columns[0]
        if not target_col or target_col not in df.columns:
            # Fallback to first numeric column or second column
            numeric_cols = df.select_dtypes(include=[np.number]).columns
            target_col = numeric_cols[0] if len(numeric_cols) > 0 else (df.columns[1] if len(df.columns) > 1 else df.columns[0])

        if pd.to_numeric(df[target_col], errors="coerce").notna().sum() == 0:
            raise ValueError(f"The selected target column '{target_col}' contains no usable numeric values. Choose another target or correct the dataset.")
        parsed_dates = pd.to_datetime(df[date_col], errors="coerce")
        self.invalid_dates_before = int(parsed_dates.isna().sum())
        self.duplicate_dates_before = int(parsed_dates.dropna().duplicated().sum())

        self.date_col = date_col
        self.target_col = target_col
        chart_raw = df.iloc[np.linspace(0, len(df) - 1, min(500, len(df)), dtype=int)] if len(df) else df
        self.raw_chart = [{"date": str(row[date_col]), "value": float(row[target_col]) if pd.notna(pd.to_numeric(row[target_col], errors="coerce")) else None} for _, row in chart_raw.iterrows()]

        # Step 5: DUPLICATES
        agg_method = self.config.get("duplicate_aggregation", "sum")
        df = self.step5_duplicates(df, date_col=date_col, target_col=target_col, agg_method=agg_method)
        self.evaluation_source = df.copy()

        # Step 6: MISSING VALUES
        drop_threshold = float(self.config.get("missing_threshold", 60.0))
        df = self.step6_missing_values(df, date_col=date_col, target_col=target_col, drop_threshold_pct=drop_threshold)

        # Step 7: OUTLIERS
        outlier_method = self.config.get("outlier_method", "iqr")
        outlier_action = self.config.get("outlier_action", "flag")
        df = self.step7_outliers(df, target_col=target_col, method=outlier_method, action=outlier_action)

        # Step 8: TIME-SERIES ALIGNMENT
        requested_freq = self.config.get("frequency")
        df, active_freq = self.step8_time_series_alignment(df, date_col=date_col, target_col=target_col, frequency=requested_freq)
        self.gap_report = time_health(self.evaluation_source, date_col, target_col, active_freq)
        self.gap_report["invalid_dates"] = self.invalid_dates_before
        self.gap_report["duplicate_dates"] = self.duplicate_dates_before

        # Step 9: VALIDATE READINESS
        self._write_progress(output_dir, "validating")
        readiness_info = self.step9_validate_readiness(df, date_col=date_col, target_col=target_col, frequency=active_freq)

        # Step 10: EXPORT
        self._write_progress(output_dir, "reporting")
        cleaned_path, report_path = self.step10_export(df, output_dir, date_col=date_col, target_col=target_col, readiness_info=readiness_info)
        self._write_progress(output_dir, "complete")

        self.df_cleaned = df

        return {
            "success": True,
            "job_id": self.job_id,
            "user_id": self.user_id,
            "date_column": date_col,
            "target_column": target_col,
            "frequency": active_freq,
            "rows_before": self.profile_before.get("total_rows", 0),
            "rows_after": len(df),
            "columns_before": self.profile_before.get("total_columns", 0),
            "columns_after": len(df.columns),
            "quality_score_before": self.profile_before.get("quality_score", 0.0),
            "quality_score_after": self.profile_after.get("quality_score", 0.0),
            "readiness_score": self.profile_after.get("readiness_score", 0.0),
            "overall_status": self.profile_after.get("overall_status", "UNKNOWN"),
            "checklist": self.profile_after.get("checklist", []),
            "audit_log": self.audit_log,
            "cleaned_csv_path": cleaned_path,
            "report_json_path": report_path,
            "sample_cleaned_data": df.head(50).replace({np.nan: None}).to_dict(orient="records")
        }
