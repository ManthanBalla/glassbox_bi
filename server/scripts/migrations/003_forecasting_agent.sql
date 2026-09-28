-- Migration: 003_forecasting_agent.sql
-- Description: Adds tables for Forecasting Agent jobs, model results, predictions, and audit actions.

-- 1. Forecast Jobs Table
CREATE TABLE IF NOT EXISTS forecast_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processed_dataset_id UUID NOT NULL REFERENCES processed_datasets(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'queued',
    config_json JSONB,
    horizon INTEGER,
    selected_metric VARCHAR(50),
    winner_model VARCHAR(100),
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Forecast Model Results (Leaderboard & Evaluations)
CREATE TABLE IF NOT EXISTS forecast_model_results (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    model_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'ok', 'skipped', 'failed', 'unavailable'
    skip_reason TEXT,
    mae NUMERIC(14,4),
    rmse NUMERIC(14,4),
    mape NUMERIC(10,4),
    smape NUMERIC(10,4),
    mase NUMERIC(10,4),
    beats_baseline BOOLEAN,
    rank INTEGER,
    hyperparameters_json JSONB,
    train_seconds NUMERIC(8,3),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Forecast Points (Predictions & Intervals)
CREATE TABLE IF NOT EXISTS forecast_points (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    forecast_date VARCHAR(50) NOT NULL,
    forecast_value NUMERIC(16,4) NOT NULL,
    lower_80 NUMERIC(16,4),
    upper_80 NUMERIC(16,4),
    lower_95 NUMERIC(16,4),
    upper_95 NUMERIC(16,4)
);

-- 4. Forecast Actions (Explainability Audit Log Timeline)
CREATE TABLE IF NOT EXISTS forecast_actions (
    id SERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES forecast_jobs(id) ON DELETE CASCADE,
    step_order INTEGER,
    step_name VARCHAR(100),
    model_name VARCHAR(100),
    action VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_forecast_jobs_user ON forecast_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_forecast_jobs_dataset ON forecast_jobs(processed_dataset_id);
CREATE INDEX IF NOT EXISTS idx_forecast_model_results_job ON forecast_model_results(job_id);
CREATE INDEX IF NOT EXISTS idx_forecast_points_job ON forecast_points(job_id);
CREATE INDEX IF NOT EXISTS idx_forecast_actions_job ON forecast_actions(job_id);
