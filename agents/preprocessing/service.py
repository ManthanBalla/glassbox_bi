"""
FastAPI Microservice for GlassBox-BI Data Preprocessing Agent.
Runs as an internal stateless service on port 8001 (not exposed to browser).
"""

import os
import logging
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd

from pipeline import PreprocessingPipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("preprocessing_service")

app = FastAPI(
    title="GlassBox-BI Preprocessing Agent Microservice",
    description="Explainable, time-series aware tabular preprocessing microservice",
    version="1.0.0"
)

# Only accessible internally; CORS configured for localhost safety
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SheetsRequest(BaseModel):
    file_path: str


class ProfileRequest(BaseModel):
    file_path: str
    sheet_name: Optional[str] = None


class ProcessRequest(BaseModel):
    file_path: str
    user_id: str
    job_id: str
    output_dir: str
    config: Optional[Dict[str, Any]] = None


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "preprocessing_agent",
        "version": "1.0.0"
    }


@app.post("/sheets")
def get_sheets(req: SheetsRequest):
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="File not found")

    ext = os.path.splitext(req.file_path)[1].lower()
    if ext in ['.xlsx', '.xls']:
        try:
            excel = pd.ExcelFile(req.file_path, engine='openpyxl' if ext == '.xlsx' else None)
            return {"is_excel": True, "sheets": excel.sheet_names}
        except Exception as e:
            logger.error(f"Error reading Excel sheets: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to inspect Excel workbook: {str(e)}")
    return {"is_excel": False, "sheets": []}


@app.post("/profile")
def profile_dataset(req: ProfileRequest):
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="Dataset file not found")

    try:
        pipeline = PreprocessingPipeline(
            file_path=req.file_path,
            user_id="preview",
            job_id="preview"
        )
        df_raw = pipeline.step1_load(sheet_name=req.sheet_name)
        profile_data = pipeline.step2_profile(df_raw)
        df_std = pipeline.step3_standardize(df_raw)
        detected_date, suggested_target = pipeline.step4_detect_columns(df_std)

        # Build recommended configuration defaults
        all_numeric_cols = [c for c in df_std.columns if pd.api.types.is_numeric_dtype(df_std[c])]
        all_date_cols = [c for c in df_std.columns if pd.api.types.is_datetime64_any_dtype(df_std[c]) or 'date' in c.lower() or 'time' in c.lower()]

        recommended_config = {
            "date_column": detected_date or (all_date_cols[0] if all_date_cols else df_std.columns[0]),
            "target_column": suggested_target or (all_numeric_cols[0] if all_numeric_cols else df_std.columns[-1]),
            "frequency": "auto",
            "duplicate_aggregation": "sum",
            "missing_strategy": "interpolate_target_median_num",
            "missing_threshold": 60.0,
            "outlier_method": "iqr",
            "outlier_action": "cap"
        }

        return {
            "success": True,
            "profile": profile_data,
            "detected_date_column": detected_date,
            "suggested_target_column": suggested_target,
            "standardized_columns": list(df_std.columns),
            "numeric_columns": all_numeric_cols,
            "recommended_config": recommended_config
        }
    except Exception as e:
        logger.error(f"Profile error: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Failed to profile dataset: {str(e)}")


@app.post("/process")
def process_dataset(req: ProcessRequest):
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail="Dataset file not found")

    try:
        pipeline = PreprocessingPipeline(
            file_path=req.file_path,
            user_id=req.user_id,
            job_id=req.job_id,
            config=req.config or {}
        )
        result = pipeline.run_pipeline(output_dir=req.output_dir)
        return result
    except Exception as e:
        logger.error(f"Process error for job {req.job_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Preprocessing failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("AGENT_PORT", 8001))
    uvicorn.run("service:app", host="127.0.0.1", port=port, reload=False)
