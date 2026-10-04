"""
FastAPI Microservice for GlassBox-BI Forecasting Agent.
Runs as an internal stateless service on port 8002 (bound to 127.0.0.1 only, not exposed to browser).
"""

import os
import logging
from typing import Dict, Any, Optional, List
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from pipeline import ForecastingPipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("forecasting_service")

app = FastAPI(
    title="GlassBox-BI Forecasting Agent Microservice",
    description="Multi-model explainable time-series forecasting microservice",
    version="1.0.0"
)

# Only accessible internally by Express backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PrecheckRequest(BaseModel):
    file_path: str
    date_column: str
    target_column: str
    frequency: str = "D"


class ForecastRequest(BaseModel):
    file_path: str
    date_column: str
    target_column: str
    frequency: str = "D"
    user_id: str
    job_id: str
    horizon: int = Field(default=12, ge=1, le=365)
    selected_models: Optional[List[str]] = None
    ranking_metric: Optional[str] = "rmse"
    holdout_percent: Optional[float] = 0.20
    confidence_levels: Optional[List[float]] = None
    output_dir: Optional[str] = None
    models_dir: Optional[str] = None
    evaluation_file_path: Optional[str] = None
    preprocessing_recipe: Optional[Dict[str, Any]] = None
    preprocessing_contract: Optional[Dict[str, Any]] = None


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "forecasting_agent",
        "port": 8002,
        "version": "1.0.0"
    }


@app.post("/precheck")
def precheck_time_series(req: PrecheckRequest):
    """
    Executes Steps 1-3 only:
    1. LOAD cleaned dataset
    2. TIME-SERIES VALIDATION (checks sorted, unique, regular, nulls, constant, min 24 rows)
    3. MODEL ELIGIBILITY CHECK (reasons for each of 6 models)
    """
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="Processed dataset file not found on disk")

    try:
        pipeline = ForecastingPipeline(
            file_path=req.file_path,
            date_column=req.date_column,
            target_column=req.target_column,
            frequency=req.frequency,
            user_id="precheck",
            job_id="precheck"
        )
        pipeline.step1_load()
        validation = pipeline.step2_validate()
        eligibility = pipeline.step3_check_eligibility()

        return {
            "success": True,
            "validation": validation,
            "suggested_horizon": validation.get("suggested_horizon", 12),
            "seasonal_period": pipeline.seasonal_period,
            "total_rows": len(pipeline.df),
            "eligibility": eligibility,
            "actions": pipeline.actions
        }
    except ValueError as ve:
        logger.warning(f"Precheck validation error: {ve}")
        return {
            "success": False,
            "error": str(ve),
            "validation": {"status": "fail", "is_valid": False, "errors": [str(ve)]}
        }
    except Exception as e:
        logger.error(f"Unexpected error in precheck: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Precheck inspection failed: {str(e)}")


@app.post("/forecast")
def run_forecast(req: ForecastRequest):
    """
    Executes the full 10-step forecasting pipeline:
    Validates, splits, trains eligible models, evaluates on holdout, ranks by metric,
    selects winner, refits on full series with 80%/95% intervals, and exports artifacts.
    """
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="Processed dataset file not found on disk")

    try:
        pipeline = ForecastingPipeline(
            file_path=req.file_path,
            date_column=req.date_column,
            target_column=req.target_column,
            frequency=req.frequency,
            user_id=req.user_id,
            job_id=req.job_id,
            horizon=req.horizon,
            selected_models=req.selected_models,
            ranking_metric=req.ranking_metric or "rmse",
            holdout_percent=req.holdout_percent or 0.20,
            confidence_levels=req.confidence_levels,
            output_dir=req.output_dir,
            models_dir=req.models_dir,
            evaluation_file_path=req.evaluation_file_path,
            preprocessing_recipe=req.preprocessing_recipe,
            preprocessing_contract=req.preprocessing_contract
        )

        report = pipeline.run()

        # Format points for database persistence
        def safe_val(v):
            if v is None:
                return None
            try:
                val = float(v)
                return None if (np.isnan(val) or np.isinf(val)) else val
            except:
                return None

        forecast_points = []
        if pipeline.future_forecast_df is not None:
            for _, row in pipeline.future_forecast_df.iterrows():
                forecast_points.append({
                    "date": str(row["date"]),
                    "forecast": float(row["forecast"]),
                    "lower_80": safe_val(row.get("lower_80")),
                    "upper_80": safe_val(row.get("upper_80")),
                    "lower_95": safe_val(row.get("lower_95")),
                    "upper_95": safe_val(row.get("upper_95"))
                })

        return {
            "success": True,
            "job_id": req.job_id,
            "winner_model": pipeline.winner_model_name,
            "horizon": pipeline.horizon,
            "ranking_metric": pipeline.ranking_metric,
            "warnings": pipeline.warnings,
            "model_leaderboard": report.get("model_leaderboard", []),
            "forecast_points": forecast_points,
            "split_info": report.get("split_info", {}),
            "audit_actions": pipeline.actions,
            "report": report
        }
    except Exception as e:
        logger.error(f"Forecasting pipeline error: {e}", exc_info=True)
        return {
            "success": False,
            "job_id": req.job_id,
            "error": str(e)
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("service:app", host="127.0.0.1", port=8002, reload=False)
